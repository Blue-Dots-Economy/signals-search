import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveVectorizeFields, type VectorizeField, type ItemSchema } from './vectorize_fields.js';

type MetricBucket = 'create' | 'accept' | 'reject' | 'cancel';
type Interaction = {
  from_network: string; from_domain: string; to_network: string; to_domain: string;
  metric_categories?: Partial<Record<MetricBucket, string[]>> | null;
};
type Domain = { id: string; item_schemas?: Record<string, ItemSchema> };
type NetworkConfig = {
  id: string;
  domains?: Domain[];
  actions?: Record<string, { interactions?: Interaction[] }>;
};

export type StatusGroup = MetricBucket;
export type StatusSet = { statuses: string[]; negate: boolean };

const FALLBACK_CLOSED_STATUSES = ['accepted', 'completed', 'cancelled', 'rejected', 'declined', 'withdrawn'];
const CLOSED_BUCKETS: MetricBucket[] = ['accept', 'reject', 'cancel'];

function interactionsOf(cfg: NetworkConfig | undefined): Interaction[] {
  return Object.values(cfg?.actions ?? {}).flatMap((a) => a.interactions ?? []);
}

function bucketStatuses(cfg: NetworkConfig | undefined, buckets: MetricBucket[]): Set<string> {
  const out = new Set<string>();
  for (const it of interactionsOf(cfg)) {
    for (const bucket of buckets) {
      for (const status of it.metric_categories?.[bucket] ?? []) out.add(status);
    }
  }
  return out;
}

export type NetworkRegistry = {
  hasDomain(network: string, domain: string): boolean;
  itemSchema(network: string, domain: string, type: string): ItemSchema | undefined;
  vectorizeFields(network: string, domain: string, type: string): VectorizeField[];
  isInteractionAllowed(network: string, fromDomain: string, toDomain: string): boolean;
  // Cross-network variant for /v1/relevance: matches an interaction in the
  // source network's actions whose from/to network and domain all match.
  isInteractionAllowedAcross(
    fromNetwork: string,
    fromDomain: string,
    toNetwork: string,
    toDomain: string,
  ): boolean;
  actionTypes(network: string): string[];
  statusGroup(network: string, group: StatusGroup): StatusSet;
};

async function readConfigs(path: string): Promise<NetworkConfig[]> {
  const s = await stat(path);
  const files = s.isDirectory()
    ? (await readdir(path)).filter((f) => f.endsWith('.json')).map((f) => join(path, f))
    : [path];
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(f, 'utf8')) as NetworkConfig));
}

export async function loadNetworkRegistry(path: string): Promise<NetworkRegistry> {
  const configs = await readConfigs(path);
  const byId = new Map<string, NetworkConfig>(configs.map((c) => [c.id, c]));
  const domain = (n: string, d: string): Domain | undefined => byId.get(n)?.domains?.find((x) => x.id === d);
  return {
    hasDomain: (n, d) => Boolean(domain(n, d)),
    itemSchema: (n, d, t) => domain(n, d)?.item_schemas?.[t],
    vectorizeFields(n, d, t) {
      const schema = domain(n, d)?.item_schemas?.[t];
      return schema ? resolveVectorizeFields(schema).fields : [];
    },
    isInteractionAllowed(n, from, to) {
      const actions = byId.get(n)?.actions ?? {};
      for (const a of Object.values(actions)) {
        for (const it of a.interactions ?? []) {
          if (it.from_network === n && it.to_network === n && it.from_domain === from && it.to_domain === to) return true;
        }
      }
      return false;
    },
    isInteractionAllowedAcross(fromNetwork, fromDomain, toNetwork, toDomain) {
      const actions = byId.get(fromNetwork)?.actions ?? {};
      for (const a of Object.values(actions)) {
        for (const it of a.interactions ?? []) {
          if (
            it.from_network === fromNetwork && it.from_domain === fromDomain &&
            it.to_network === toNetwork && it.to_domain === toDomain
          ) return true;
        }
      }
      return false;
    },
    actionTypes: (n) => Object.keys(byId.get(n)?.actions ?? {}),
    statusGroup(n, group) {
      const cfg = byId.get(n);
      if (group === 'create') {
        const closed = bucketStatuses(cfg, CLOSED_BUCKETS);
        for (const s of FALLBACK_CLOSED_STATUSES) closed.add(s);
        return { statuses: [...closed], negate: true };
      }
      return { statuses: [...bucketStatuses(cfg, [group])], negate: false };
    },
  };
}

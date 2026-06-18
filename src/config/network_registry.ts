import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveVectorizeFields, type VectorizeField, type ItemSchema } from './vectorize_fields.js';

type Interaction = { from_network: string; from_domain: string; to_network: string; to_domain: string };
type Domain = { id: string; item_schemas?: Record<string, ItemSchema> };
type NetworkConfig = { id: string; domains?: Domain[]; actions?: Record<string, { interactions?: Interaction[] }> };

export type NetworkRegistry = {
  hasDomain(network: string, domain: string): boolean;
  itemSchema(network: string, domain: string, type: string): ItemSchema | undefined;
  vectorizeFields(network: string, domain: string, type: string): VectorizeField[];
  isInteractionAllowed(network: string, fromDomain: string, toDomain: string): boolean;
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
  };
}

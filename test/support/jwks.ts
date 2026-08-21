import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { JWK } from 'jose';

const KID = 'signals-search-test-key';

export type MintOverrides = {
  /** Pass null to mint a token with no `sub` claim at all. */
  sub?: string | null;
  iss?: string;
  /**
   * Emitted as BOTH `azp` and `client_id`, the way Keycloak shapes a
   * client-credentials token. Pass null to omit both claims entirely (unlike
   * `undefined`, which falls back to the default below).
   */
  azp?: string | null;
  aud?: string | string[];
  /** Anything `jose`'s setExpirationTime accepts; pass a past epoch second for an expired token. */
  expiresIn?: string | number;
  claims?: Record<string, unknown>;
  /** Sign with a key that is NOT published in the served JWKS. */
  signWithForeignKey?: boolean;
};

export type JwksHarness = {
  issuer: string;
  jwksUri: string;
  /** How many times the JWKS endpoint has been hit — asserts the cache caches. */
  requests: () => number;
  /** Flip to make the endpoint 500, simulating a Keycloak outage. */
  setFailing: (failing: boolean) => void;
  mint: (overrides?: MintOverrides) => Promise<string>;
  close: () => Promise<void>;
};

export async function startJwksServer(): Promise<JwksHarness> {
  const pair = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');
  const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };

  let requests = 0;
  let failing = false;
  const server: Server = createServer((_req, res) => {
    requests += 1;
    if (failing) {
      res.writeHead(500).end('keycloak is down');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const issuer = `http://127.0.0.1:${port}/realms/bluedots`;

  return {
    issuer,
    jwksUri: `${issuer}/protocol/openid-connect/certs`,
    requests: () => requests,
    setFailing: (f) => {
      failing = f;
    },
    async mint(overrides: MintOverrides = {}) {
      const {
        sub = '11111111-2222-3333-4444-555555555555',
        iss = issuer,
        azp = 'signals-search',
        // Keycloak's shape once the audience mapper is in place: the resource
        // server plus the default `account`.
        aud = ['signals-search', 'account'],
        expiresIn = '5m',
        claims = {},
        signWithForeignKey = false,
      } = overrides;
      const jwt = new SignJWT({ ...(azp ? { azp, client_id: azp } : {}), ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: KID })
        .setIssuer(iss)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime(expiresIn);
      if (sub !== null) jwt.setSubject(sub);
      return jwt.sign(signWithForeignKey ? foreign.privateKey : pair.privateKey);
    },
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

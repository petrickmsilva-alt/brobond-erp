// ============================================================================
// OAUTH 2.1 › CHAVES DE ASSINATURA (RS256 + JWKS)
//
// O access token do MCP é ASSINADO ASSIMETRICAMENTE (RS256) — NUNCA com o
// segredo HS256 da sessão do ERP. São mecanismos separados (decisão
// arquitetural 4): o JWT do ERP não é, e não pode ser, token OAuth do MCP.
//
// Ordem de resolução das chaves:
//   1. ambiente (`OAUTH_JWT_PRIVATE_KEY` / `OAUTH_JWT_PUBLIC_KEY`, PEM);
//   2. tabela `configuracoes` (privada CIFRADA, chave `oauth_signing_keys`);
//   3. geração de um par RSA 2048 e persistência (rotação estável entre boots).
//
// O `kid` é o prefixo do SHA-256 da chave pública: o JWKS anuncia só o que é
// público; a chave privada NUNCA é serializada nem registrada em log.
// ============================================================================
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { lerConfig, gravarConfig } from '../../../server/src/configuracoes';
import { cifrarSegredo, decifrarSegredo } from '../../../server/src/segredos';

export type ChavesOAuth = { kid: string; privateKey: KeyObject; publicKey: KeyObject; publicPem: string };

const CHAVE_CONFIG = 'oauth_signing_keys';

function normalizarPem(bruto: string | null | undefined): string {
  return String(bruto ?? '').replace(/\\n/g, '\n').trim();
}

function kidDe(publicPem: string): string {
  return createHash('sha256').update(publicPem).digest('hex').slice(0, 16);
}

let cache: ChavesOAuth | null = null;

function montar(privatePem: string, publicPem: string): ChavesOAuth {
  const privateKey = createPrivateKey(privatePem);
  const publicKey = createPublicKey(publicPem);
  return { kid: kidDe(publicPem), privateKey, publicKey, publicPem };
}

function doAmbiente(): ChavesOAuth | null {
  const priv = normalizarPem(process.env.OAUTH_JWT_PRIVATE_KEY);
  const pub = normalizarPem(process.env.OAUTH_JWT_PUBLIC_KEY);
  if (!priv || !pub) return null;
  try {
    return montar(priv, pub);
  } catch {
    return null;
  }
}

/** Par de chaves vigente (cacheado no processo). */
export async function obterChaves(): Promise<ChavesOAuth> {
  if (cache) return cache;
  const env = doAmbiente();
  if (env) return (cache = env);

  const persistido = await lerConfig(CHAVE_CONFIG);
  if (persistido) {
    try {
      const dados = JSON.parse(persistido) as { privada?: string; publica?: string };
      const priv = decifrarSegredo(dados.privada);
      const pub = dados.publica ?? '';
      if (priv && pub) return (cache = montar(priv, pub));
    } catch {
      // Config corrompida → regenera (o token antigo deixa de valer, o que é seguro).
    }
  }

  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const novo = montar(privateKey, publicKey);
  try {
    await gravarConfig(CHAVE_CONFIG, JSON.stringify({ privada: cifrarSegredo(privateKey), publica: publicKey }), 'sistema');
  } catch {
    // Persistência best-effort: sem ela o par vive só neste processo.
  }
  return (cache = novo);
}

/** Representação JWK pública (n, e) — nunca inclui `d`. */
export async function jwks(): Promise<{ keys: Record<string, unknown>[] }> {
  const chaves = await obterChaves();
  const jwk = chaves.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return { keys: [{ kty: 'RSA', use: 'sig', alg: 'RS256', kid: chaves.kid, n: jwk.n, e: jwk.e }] };
}

/** Limpa o cache (rotação/testes). */
export function limparCacheChaves(): void {
  cache = null;
}

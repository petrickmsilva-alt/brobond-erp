// ============================================================================
// CONTROL PLANE › INFRA › RATE LIMIT
//
// Reusa o MESMO store de rate limit do login (`rateLimitEstado`/`rateLimitHit`),
// com bucket próprio e limites operacionais (o bucket de login é 5/15min — fino
// demais para consultas). Chave = usuário/empresa/rota. Fail-open como o login:
// sem banco de rate limit a operação segue exigindo autorização plena.
// ============================================================================
import { getStore } from '../../../server/src/services';
import { HttpError } from '../../../server/src/errors';

const JANELA_MS = Number(process.env.OPERATIONAL_RATE_WINDOW_MS) || 60_000;
const MAX = Number(process.env.OPERATIONAL_RATE_MAX) || 60;

/** Consome uma unidade do limite; lança 429 quando excedido. */
export async function limitarOperacao(chave: string): Promise<void> {
  try {
    const { restantes } = await getStore().rateLimitHit(`operational|${chave}`, JANELA_MS, MAX);
    if (restantes <= 0) throw new HttpError(429, 'Limite de chamadas operacionais excedido. Aguarde alguns segundos.');
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.warn('⚠️  Rate limit operacional indisponível (fail-open):', (e as Error)?.message || e);
  }
}

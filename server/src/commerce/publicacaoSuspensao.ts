// ============================================================================
// COMMERCE OS — SUSPENSÃO CONTROLADA DE PUBLICAÇÃO EM CANAIS EXTERNOS.
//
// Canais de marketplace começam SUSPENSOS (criação e edição de anúncios não
// são enviadas ao provedor). Para liberar, o operador define
// PUBLICACAO_CANAIS_LIBERADOS com a lista explícita (ex.: "MERCADOLIVRE").
// Remover a variável volta à suspensão. Não afeta pedidos, webhooks, estoque
// local, histórico nem identificadores: só o envio de publicações.
// ============================================================================
import { CANAIS_PUBLICACAO, type CanalPublicacao } from './regras';

/** Canais de marketplace cuja publicação automática fica suspensa por padrão. */
export const CANAIS_SUSPENSOS_POR_PADRAO: readonly CanalPublicacao[] = ['MERCADOLIVRE', 'NUVEMSHOP'];

export const VARIAVEL_CANAIS_LIBERADOS = 'PUBLICACAO_CANAIS_LIBERADOS';

export function canaisLiberadosPublicacao(env: NodeJS.ProcessEnv = process.env): Set<CanalPublicacao> {
  const bruto = String(env[VARIAVEL_CANAIS_LIBERADOS] || '');
  const validos = new Set<string>(CANAIS_PUBLICACAO);
  const liberados = new Set<CanalPublicacao>();
  for (const parte of bruto.split(',')) {
    const canal = parte.trim().toUpperCase();
    if (validos.has(canal)) liberados.add(canal as CanalPublicacao);
  }
  return liberados;
}

export function canalPublicacaoSuspenso(canal: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!CANAIS_SUSPENSOS_POR_PADRAO.includes(canal as CanalPublicacao)) return false;
  return !canaisLiberadosPublicacao(env).has(canal as CanalPublicacao);
}

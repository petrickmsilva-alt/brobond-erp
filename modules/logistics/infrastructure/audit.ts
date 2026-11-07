// ============================================================================
// MOTOR DE FRETE › INFRA › AUDITORIA
//
// Trilha própria do módulo (`logistics_audit_logs`) para as operações
// logísticas: criar/alterar regra, cotar, criar remessa, gerar etiqueta,
// rastrear, corrigir divergência. `dados` guarda a evidência MINIMIZADA —
// nunca credencial, token ou PII de terceiro.
//
// Não substitui a auditoria global (`store.audit`): complementa-a com o
// detalhe logístico que o feed genérico não carrega.
// ============================================================================
import { getStore } from '../../../server/src/services';
import { R_AUDIT_LOGS } from './resources';
import type { StoreKey } from '../domain/contract';
import type { Tx } from '../../../server/src/store';

export type EventoAuditoria = {
  empresaId: number;
  storeKey?: StoreKey | null;
  entidade: string;
  entidadeId?: number | null;
  acao: string;
  descricao: string;
  dados?: unknown;
  usuarioId?: number | null;
};

/** Grava uma linha de auditoria logística. Nunca lança por falha de auditoria. */
export async function auditarLogistica(evento: EventoAuditoria, tx?: Tx): Promise<void> {
  try {
    await getStore().insert(
      R_AUDIT_LOGS(),
      {
        empresa_id: evento.empresaId,
        store_key: evento.storeKey ?? null,
        entidade: evento.entidade,
        entidade_id: evento.entidadeId ?? null,
        acao: evento.acao,
        descricao: evento.descricao.slice(0, 500),
        dados: evento.dados === undefined ? null : evento.dados,
        usuario_id: evento.usuarioId ?? null,
      },
      tx
    );
  } catch (e) {
    // Auditoria é acessório crítico, mas sua falha não pode derrubar a operação
    // de negócio já concluída — registra no log do servidor e segue.
    console.error('[logistics:audit] falha ao gravar auditoria logística', {
      entidade: evento.entidade,
      acao: evento.acao,
      erro: e instanceof Error ? e.message : String(e),
    });
  }
}

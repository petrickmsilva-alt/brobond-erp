/**
 * Pipeline CANÔNICO de ingestão de webhooks de pagamento (ADR-001, P1-07).
 *
 * Há UM único ponto de entrada por provedor (`POST /api/gateway/webhooks/:provider`),
 * que roteia internamente para o Engine. Esta unidade concentra as REGRAS de
 * ingestão — o que fazer com uma entrega — para que elas não sejam
 * reimplementadas por caminho nenhum:
 *
 *   1. a assinatura é verificada sobre os BYTES CRUS antes de qualquer
 *      deduplicação (um evento não autenticado nunca recebe ACK nem revela a
 *      existência de um evento aceito de outro tenant);
 *   2. o evento autenticado é PERSISTIDO antes do processamento;
 *   3. a deduplicação é por (provedor, evento_id) com isolamento por empresa;
 *   4. uma notificação anterior REJEITADA é reaproveitada (o índice único é
 *      (provider, evento_id)) em vez de empilhar linhas;
 *   5. uma reentrega idêntica já ACEITA é respondida como duplicata, sem
 *      segundo processamento nem segundo efeito financeiro.
 *
 * Função PURA: recebe apenas primitivos já extraídos pelo adaptador de
 * compatibilidade, de modo que a regra é a mesma para todos os provedores e
 * testável sem banco.
 */

/** Visão mínima de um evento já persistido, necessária à decisão de ingestão. */
export type EventoPersistido = {
  id: number;
  empresa_id: number | null;
  status: string;
  assinatura_ok: boolean;
  /** Referência de cobrança extraída do payload persistido (ou null). */
  referencia: string | null;
};

export type ClassificacaoEntrega =
  | { acao: 'conflito' }
  | { acao: 'rejeitar'; reutilizar: EventoPersistido | null; persistir: boolean }
  | { acao: 'duplicado' }
  | { acao: 'persistir'; reutilizar: EventoPersistido | null };

/** Rejeição legada sem empresa (assinatura inválida/sem efeito) não envenena o retry. */
function rejeicaoReaproveitavel(row: EventoPersistido | null): boolean {
  return !!row && row.empresa_id == null && row.status === 'ignorado';
}

export function classificarEntrega(opts: {
  anteriores: EventoPersistido[];
  empresaId: number | null;
  referencia: string | null;
  temSegredo: boolean;
  assinaturaOk: boolean;
}): ClassificacaoEntrega {
  const { anteriores, empresaId, referencia, temSegredo, assinaturaOk } = opts;
  const anterior = anteriores[0] ?? null;

  const conflito =
    !!anterior &&
    ((!rejeicaoReaproveitavel(anterior) && Number(anterior.empresa_id || 0) !== Number(empresaId || 0)) ||
      anterior.referencia !== referencia);
  if (conflito) return { acao: 'conflito' };

  // Um evento já ACEITO não pode ser reconhecido como duplicata quando a
  // entrega atual NÃO foi autenticada.
  const aceito =
    anteriores.find((r) => r.status !== 'ignorado' && !(temSegredo && r.status === 'erro' && r.assinatura_ok !== true)) ?? null;
  const jaRejeitado = aceito ? null : anterior;

  if (temSegredo && !assinaturaOk) {
    // Já existe um evento ACEITO para esta cobrança: a entrega atual NÃO deve
    // nem autenticar a duplicata nem inserir uma segunda linha (o índice único
    // (provider, evento_id) a rejeitaria). Apenas 401, sem gravar.
    if (aceito) return { acao: 'rejeitar', reutilizar: null, persistir: false };
    return { acao: 'rejeitar', reutilizar: jaRejeitado, persistir: true };
  }
  if (aceito) return { acao: 'duplicado' };
  return { acao: 'persistir', reutilizar: jaRejeitado };
}

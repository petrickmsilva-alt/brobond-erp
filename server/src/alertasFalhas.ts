// Fase 7 (P2-08) — falhas de entrega no relatório diário de alertas.
//
// Mostra CONTAGENS por empresa, tipo de evento e webhook. Não inclui payload,
// destinatário, URL, segredo nem texto bruto de erro (ultimo_erro/erro), porque esses
// campos podem carregar dados pessoais ou credenciais do provedor.
import { getResource } from './resources';
import { getStore } from './services';
import { aplicarFiltroEmpresa } from './empresa';

export interface LinhaOutboxFalha {
  empresa_id: number | null;
  tipo: string | null;
}

export interface LinhaEntregaFalha {
  webhook_id: number | null;
  evento: string | null;
  concluida_em: string | null;
}

export interface LinhaNotificacaoFalha {
  empresa_id: number | null;
  canal: string | null;
  /** Momento da falha (atualizado_em/criado_em). */
  quando: string | null;
}

export interface ResumoFalhasEntrega {
  total: number;
  outbox: Array<{ empresa_id: number | null; tipo: string; total: number }>;
  webhooks: Array<{ empresa_id: number | null; evento: string; total: number }>;
  notificacoes: Array<{ empresa_id: number | null; canal: string; total: number }>;
  /** true quando a leitura cortou registros: o número é piso, não total exato. */
  truncado: boolean;
}

const JANELA_PADRAO_HORAS = 24;

/** Agrupa falhas. Função pura: recebe as linhas já lidas e o mapa webhook→empresa. */
export function agruparFalhasEntrega(
  outbox: LinhaOutboxFalha[],
  entregas: LinhaEntregaFalha[],
  empresaDoWebhook: (webhookId: number) => number | null,
  agora: Date = new Date(),
  janelaHoras = JANELA_PADRAO_HORAS,
  notificacoes: LinhaNotificacaoFalha[] = [],
): Omit<ResumoFalhasEntrega, 'truncado'> {
  const limite = agora.getTime() - janelaHoras * 3600_000;
  const contOutbox = new Map<string, { empresa_id: number | null; tipo: string; total: number }>();
  for (const linha of outbox) {
    const tipo = linha.tipo || 'desconhecido';
    const chave = `${linha.empresa_id ?? '-'}|${tipo}`;
    const atual = contOutbox.get(chave) ?? { empresa_id: linha.empresa_id ?? null, tipo, total: 0 };
    atual.total += 1;
    contOutbox.set(chave, atual);
  }
  const contWebhook = new Map<string, { empresa_id: number | null; evento: string; total: number }>();
  for (const linha of entregas) {
    const quando = linha.concluida_em ? new Date(linha.concluida_em).getTime() : NaN;
    if (!Number.isFinite(quando) || quando < limite) continue;
    const empresa = linha.webhook_id == null ? null : empresaDoWebhook(Number(linha.webhook_id));
    const evento = linha.evento || 'desconhecido';
    const chave = `${empresa ?? '-'}|${evento}`;
    const atual = contWebhook.get(chave) ?? { empresa_id: empresa, evento, total: 0 };
    atual.total += 1;
    contWebhook.set(chave, atual);
  }
  const contNotif = new Map<string, { empresa_id: number | null; canal: string; total: number }>();
  for (const linha of notificacoes) {
    const quando = linha.quando ? new Date(linha.quando).getTime() : NaN;
    if (!Number.isFinite(quando) || quando < limite) continue;
    const canal = linha.canal || 'desconhecido';
    const chave = `${linha.empresa_id ?? '-'}|${canal}`;
    const atual = contNotif.get(chave) ?? { empresa_id: linha.empresa_id ?? null, canal, total: 0 };
    atual.total += 1;
    contNotif.set(chave, atual);
  }
  const outboxOrdenado = [...contOutbox.values()].sort((a, b) => b.total - a.total);
  const webhooksOrdenado = [...contWebhook.values()].sort((a, b) => b.total - a.total);
  const notifOrdenado = [...contNotif.values()].sort((a, b) => b.total - a.total);
  const total = [outboxOrdenado, webhooksOrdenado, notifOrdenado].reduce((n, lista) => n + lista.reduce((m, x) => m + x.total, 0), 0);
  return { total, outbox: outboxOrdenado, webhooks: webhooksOrdenado, notificacoes: notifOrdenado };
}

const escapar = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);

/** Seção HTML do relatório. Vazia quando não há falha. */
export function htmlSecaoFalhasEntrega(resumo: ResumoFalhasEntrega): string {
  if (resumo.total === 0) return '';
  const linhas = (itens: Array<{ empresa_id: number | null; total: number }>, rotulo: (i: any) => string) =>
    itens.map((i) => `<tr><td style="padding:4px 6px;border-bottom:1px solid #eee;">${escapar(i.empresa_id == null ? '—' : `Empresa #${i.empresa_id}`)}</td><td style="padding:4px 6px;border-bottom:1px solid #eee;">${escapar(rotulo(i))}</td><td style="padding:4px 6px;text-align:right;border-bottom:1px solid #eee;">${i.total}</td></tr>`).join('');
  return `
    <h4 style="color:#C53030;margin-top:16px;">🔴 Falhas de envio nas últimas 24h (${resumo.total})</h4>
    ${resumo.outbox.length ? `<p style="font-size:12px;margin:4px 0;">Fila de sincronização em erro (após tentativas esgotadas):</p>
      <table style="width:100%;border-collapse:collapse;font-size:12px;"><tbody>${linhas(resumo.outbox, (i) => i.tipo)}</tbody></table>` : ''}
    ${resumo.webhooks.length ? `<p style="font-size:12px;margin:8px 0 4px;">Webhooks de saída com entrega falha:</p>
      <table style="width:100%;border-collapse:collapse;font-size:12px;"><tbody>${linhas(resumo.webhooks, (i) => i.evento)}</tbody></table>` : ''}
    ${resumo.notificacoes.length ? `<p style="font-size:12px;margin:8px 0 4px;">Notificações (e-mail/WhatsApp) não entregues:</p>
      <table style="width:100%;border-collapse:collapse;font-size:12px;"><tbody>${linhas(resumo.notificacoes, (i) => i.canal)}</tbody></table>` : ''}
    ${resumo.truncado ? '<p style="font-size:11px;color:#64748b;">Leitura limitada: o número exibido pode ser inferior ao real.</p>' : ''}
    <p style="font-size:11px;color:#64748b;">Detalhes (payload, destinatário e mensagem de erro) ficam fora deste e-mail: consulte a Fila de sincronização e as entregas de webhook no sistema.</p>`;
}

const TAMANHO_LEITURA = 5000;

/**
 * Lê as falhas de UMA empresa (R-12, Fase 4.2). Não existe leitura global: o escopo é obrigatório.
 *
 * Inclui: fila de sincronização em erro e notificações não entregues (ambas com `empresa_id`).
 * NÃO inclui: entregas de webhook. `webhooks` e `webhook_entregas` não têm `empresa_id` no
 * esquema (R-14), então a falha não pode ser atribuída a uma empresa com segurança. Ela
 * permanece fora dos relatórios por empresa até a decisão de modelagem (ver fase-4-2-correcoes.md).
 */
export async function coletarFalhasEntrega(
  agora: Date = new Date(),
  escopo: { empresaId: number },
): Promise<ResumoFalhasEntrega> {
  if (!(Number(escopo?.empresaId) > 0)) throw new Error('coletarFalhasEntrega exige empresa explícita.');
  const s = getStore();
  const R_OUTBOX = getResource('commerce_outbox')!;
  const R_NOTIF = getResource('commerce_notificacoes')!;
  const recorte = { empresaId: escopo.empresaId, consolidado: false, permitidas: [escopo.empresaId] };
  const [outboxRes, notifErro, notifFailed] = await Promise.all([
    s.list(R_OUTBOX, { page: 1, pageSize: TAMANHO_LEITURA, filter: aplicarFiltroEmpresa(R_OUTBOX, { estado: 'ERRO' }, recorte) }),
    s.list(R_NOTIF, { page: 1, pageSize: TAMANHO_LEITURA, filter: aplicarFiltroEmpresa(R_NOTIF, { estado: 'ERRO' }, recorte) }),
    s.list(R_NOTIF, { page: 1, pageSize: TAMANHO_LEITURA, filter: aplicarFiltroEmpresa(R_NOTIF, { provider_status: 'FAILED' }, recorte) }),
  ]);
  // Mesma notificação pode estar nas duas listas: deduplica por id.
  const notifVistas = new Map<number, (typeof notifErro.rows)[number]>();
  for (const r of [...notifErro.rows, ...notifFailed.rows]) notifVistas.set(Number(r.id), r);
  const resumo = agruparFalhasEntrega(
    outboxRes.rows.map((r) => ({ empresa_id: r.empresa_id == null ? null : Number(r.empresa_id), tipo: (r.tipo as string) ?? null })),
    [],
    () => null,
    agora,
    JANELA_PADRAO_HORAS,
    [...notifVistas.values()].map((r) => ({
      empresa_id: r.empresa_id == null ? null : Number(r.empresa_id),
      canal: (r.canal as string) ?? null,
      quando: ((r.atualizado_em ?? r.criado_em ?? null) as string | null),
    })),
  );
  const truncado = outboxRes.total > outboxRes.rows.length
    || notifErro.total > notifErro.rows.length || notifFailed.total > notifFailed.rows.length;
  return { ...resumo, truncado };
}

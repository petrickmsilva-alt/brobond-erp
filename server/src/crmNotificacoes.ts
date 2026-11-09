// ============================================================================
// FASE 9.2 — CRM LIFECYCLE AUTOMATION: CAIXA DE ENTRADA INTERNA (BL-012/GAP-P2-06)
//
// O lembrete de atividade já é disparado pelo AGENDADOR existente
// (`scheduled.ts` → `dispararLembretesCrm`), com idempotência por
// `crm_atividades.lembrete_enviado_em` (compare-and-swap). O canal EXTERNO
// (e-mail) é opcional. Este módulo fecha o ciclo de vida com o canal INTERNO:
// um registro de notificação que o responsável vê DENTRO do ERP.
//
// Regras invioláveis:
//   • MULTIEMPRESA: toda notificação carrega `empresa_id`; a leitura é recortada
//     por empresa E por usuário (cada um só vê a própria caixa);
//   • IDEMPOTÊNCIA: a chave é `crm:<tipo>:<atividade>:<discriminador>`; o UNIQUE
//     `(empresa_id, chave_idempotencia)` impede duplicata em reprocessamento;
//   • NÃO é ação: notificar não altera preço, estoque, pagamento, pedido nem a
//     própria atividade;
//   • NENHUM conector externo: nada aqui envia e-mail/WhatsApp/SMS/push.
// ============================================================================
import type { Request, Response } from 'express';
import { currentUser } from './auth';
import { escopoDoAtor } from './empresa';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, getStore } from './services';
import type { Row, Tx } from './store';

export const TIPOS_NOTIFICACAO_CRM = [
  'atribuicao', 'lembrete', 'vencida', 'alteracao_responsavel', 'conclusao', 'reagendamento', 'cancelamento', 'falha',
] as const;
export type TipoNotificacaoCrm = (typeof TIPOS_NOTIFICACAO_CRM)[number];

const R = () => getResource('crm_notificacoes')!;

type NovaNotificacao = {
  empresaId: number;
  atividadeId?: number | null;
  tipo: TipoNotificacaoCrm;
  severidade?: 'baixa' | 'media' | 'alta' | 'critica';
  usuarioId?: number | null;
  atorId?: number | null;
  titulo: string;
  detalhe?: string;
  payload?: Record<string, unknown>;
  /** Discriminador da chave de idempotência (ex.: data de referência). */
  discriminador: string;
};

/**
 * Cria a notificação interna de forma IDEMPOTENTE.
 *
 * O `chave_idempotencia` é `crm:<tipo>:<atividade>:<discriminador>`. O Store não
 * expõe upsert genérico, então checamos o existente por `findOneWhere` e, se já
 * houver, não duplicamos. O UNIQUE do banco é a rede de segurança para corrida.
 *
 * Retorna `true` quando criou uma notificação nova; `false` quando já existia ou
 * quando não há destinatário (não se cria aviso para ninguém).
 */
export async function criarNotificacaoCrm(n: NovaNotificacao, tx?: Tx): Promise<boolean> {
  const usuarioId = n.usuarioId === null || n.usuarioId === undefined ? null : Number(n.usuarioId);
  if (!usuarioId || !(Number(n.empresaId) > 0)) return false;
  const s = getStore();
  const chave = `crm:${n.tipo}:${n.atividadeId ?? 'x'}:${n.discriminador}`;
  const existente = await s.findOneWhere(R(), { empresa_id: Number(n.empresaId), chave_idempotencia: chave }, tx);
  if (existente) return false;
  await s.insert(R(), {
    empresa_id: Number(n.empresaId),
    atividade_id: n.atividadeId ?? null,
    tipo: n.tipo,
    severidade: n.severidade ?? 'media',
    usuario_id: usuarioId,
    ator_id: n.atorId ?? null,
    titulo: n.titulo.slice(0, 200),
    detalhe: (n.detalhe ?? '').slice(0, 2000),
    payload: n.payload ?? {},
    chave_idempotencia: chave,
    criado_em: new Date().toISOString(),
  } as any, tx);
  return true;
}

/**
 * Caixa de entrada PESSOAL: cada usuário só vê a própria. O destinatário é
 * sempre o próprio ator — nunca vem do cliente.
 */
function caixaDoAtor(actorId: number | null): number | null {
  return actorId && actorId > 0 ? actorId : null;
}

// ----------------------------------------------------------------------------
// LEITURA — a tela do sino (não lidas + recentes)
// ----------------------------------------------------------------------------
/** GET /api/crm/notificacoes — caixa de entrada interna do usuário. */
export async function listarNotificacoesCrm(req: Request, res: Response): Promise<void> {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R(), actor, 'read');
  const s = getStore();
  const pagina = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 30));
  // Caixa PESSOAL: sempre recortada pelo próprio usuário — nunca pelo cliente.
  const destino = caixaDoAtor(Number(actor.id) || null);
  if (destino === null) throw new HttpError(403, 'Sua conta não tem caixa de entrada própria.');
  const base: Record<string, unknown> = { empresa_id: escopo.empresaId, usuario_id: destino };
  const filtro: Record<string, unknown> = { ...base };
  if (req.query.tipo) filtro.tipo = String(req.query.tipo);

  const out = await s.list(R(), { page: pagina, pageSize, filter: filtro, sort: 'criado_em', dir: 'desc' });
  const naoLidas = (await s.list(R(), { page: 1, pageSize: 500, filter: base })).rows.filter((r) => !r.lida_em).length;

  res.json({
    itens: out.rows,
    total: out.total,
    nao_lidas: naoLidas,
    page: pagina,
    pageSize,
  });
}

// ----------------------------------------------------------------------------
// MARCAÇÃO DE LEITURA — por endpoint próprio (o recurso é READ_ONLY no CRUD)
// ----------------------------------------------------------------------------
/**
 * POST /api/crm/notificacoes/:id/lida — marca UMA notificação como lida.
 * Só o próprio destinatário (ou admin/gerente da empresa) pode marcar; a
 * operação é idempotente (marcar de novo não altera `lida_em`).
 */
export async function marcarNotificacaoLida(req: Request, res: Response): Promise<void> {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R(), actor, 'read');
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Notificação inválida.');
  const s = getStore();
  const atual = await s.findOneWhere(R(), { id, empresa_id: escopo.empresaId });
  if (!atual) throw new HttpError(404, 'Notificação não encontrada.');
  const destino = caixaDoAtor(Number(actor.id) || null);
  if (destino !== null && Number(atual.usuario_id) !== destino) {
    throw new HttpError(403, 'Você só pode marcar as notificações da sua caixa.');
  }
  if (!atual.lida_em) {
    await s.update(R(), id, { lida_em: new Date().toISOString() } as any);
  }
  const atualizada = await s.findOneWhere(R(), { id, empresa_id: escopo.empresaId });
  res.json({ ok: true, notificacao: atualizada });
}

/**
 * POST /api/crm/notificacoes/lidas — marca TODAS as notificações do usuário
 * como lidas. Idempotente. Nunca toca a caixa de outro tenant/usuário.
 */
export async function marcarTodasLidas(req: Request, res: Response): Promise<void> {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R(), actor, 'read');
  const s = getStore();
  const destino = caixaDoAtor(Number(actor.id) || null);
  if (destino === null) throw new HttpError(403, 'Sua conta não tem caixa de entrada própria.');
  const pendentes = await s.list(R(), {
    page: 1,
    pageSize: 500,
    filter: { empresa_id: escopo.empresaId, usuario_id: destino },
  });
  const agora = new Date().toISOString();
  let marcadas = 0;
  for (const n of pendentes.rows) {
    if (n.lida_em) continue;
    await s.update(R(), Number(n.id), { lida_em: agora } as any);
    marcadas += 1;
  }
  res.json({ ok: true, marcadas });
}

// ----------------------------------------------------------------------------
// HOOKS DO CICLO DE VIDA — chamados pelo CRUD genérico (services.ts)
//
// Cada hook grava a notificação interna do FATO ocorrido, na MESMA transação da
// mutação (histórico e aviso nascem juntos — nunca um sem o outro).
// ----------------------------------------------------------------------------

/** Extrai o responsável (usuário) de uma atividade. */
function responsavelDe(row: Row): number | null {
  const id = Number(row.responsavel_id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Criação de atividade → notifica o responsável (atribuição). */
export async function notificarAtividadeCriada(row: Row, tx?: Tx): Promise<boolean> {
  const resp = responsavelDe(row);
  return criarNotificacaoCrm({
    empresaId: Number(row.empresa_id),
    atividadeId: Number(row.id),
    tipo: 'atribuicao',
    severidade: 'baixa',
    usuarioId: resp,
    titulo: `Nova atividade atribuída: ${String(row.tipo ?? 'atividade')}`,
    detalhe: String(row.resumo ?? ''),
    payload: { prioridade: row.prioridade ?? null, lembrete_em: row.lembrete_em ?? null },
    discriminador: 'criacao',
  }, tx);
}

/**
 * Edição de atividade → notifica o responsável sobre troca de responsável,
 * reagendamento, conclusão ou cancelamento. O discriminador usa o CARIMBO da
 * mudança para que cada transição gere um aviso novo sem duplicar a mesma.
 */
export async function notificarAtividadeAtualizada(before: Row, row: Row, tx?: Tx): Promise<void> {
  const empresaId = Number(row.empresa_id);
  const atividadeId = Number(row.id);
  const respAntes = responsavelDe(before);
  const respDepois = responsavelDe(row);
  const statusAntes = String(before.status ?? 'pendente');
  const statusDepois = String(row.status ?? 'pendente');
  const lembreteAntes = before.lembrete_em ? String(before.lembrete_em) : null;
  const lembreteDepois = row.lembrete_em ? String(row.lembrete_em) : null;
  const concluidaAgora = statusDepois === 'concluida' && statusAntes !== 'concluida';
  const canceladaAgora = statusDepois === 'cancelada' && statusAntes !== 'cancelada';
  const reagendou = lembreteAntes !== lembreteDepois;
  const trocouResp = respAntes !== respDepois;
  if (!concluidaAgora && !canceladaAgora && !reagendou && !trocouResp) return;
  const carimbo = String(row.atualizado_em ?? new Date().toISOString());

  // Troca de responsável: o NOVO responsável é avisado (o antigo não recebe
  // aviso interno — ele apenas deixa de ser dono da atividade).
  if (trocouResp && respDepois) {
    await criarNotificacaoCrm({
      empresaId,
      atividadeId,
      tipo: 'alteracao_responsavel',
      severidade: 'media',
      usuarioId: respDepois,
      titulo: `Atividade transferida para você: ${String(row.tipo ?? 'atividade')}`,
      detalhe: String(row.resumo ?? ''),
      payload: { responsavel_anterior: respAntes, lembrete_em: lembreteDepois },
      discriminador: `resp:${carimbo}`,
    }, tx);
  }
  if (concluidaAgora) {
    await criarNotificacaoCrm({
      empresaId,
      atividadeId,
      tipo: 'conclusao',
      severidade: 'baixa',
      usuarioId: respDepois ?? respAntes,
      titulo: `Atividade concluída: ${String(row.tipo ?? 'atividade')}`,
      detalhe: String(row.resumo ?? ''),
      payload: { concluida_em: row.concluida_em ?? null },
      discriminador: `conclusao:${String(row.concluida_em ?? carimbo)}`,
    }, tx);
  }
  if (canceladaAgora) {
    await criarNotificacaoCrm({
      empresaId,
      atividadeId,
      tipo: 'cancelamento',
      severidade: 'baixa',
      usuarioId: respDepois ?? respAntes,
      titulo: `Atividade cancelada: ${String(row.tipo ?? 'atividade')}`,
      detalhe: String(row.motivo_cancelamento ?? row.resumo ?? ''),
      payload: { cancelada_em: row.cancelada_em ?? null },
      discriminador: `cancelamento:${String(row.cancelada_em ?? carimbo)}`,
    }, tx);
  }
  if (reagendou && !concluidaAgora && !canceladaAgora) {
    await criarNotificacaoCrm({
      empresaId,
      atividadeId,
      tipo: 'reagendamento',
      severidade: 'baixa',
      usuarioId: respDepois ?? respAntes,
      titulo: `Atividade reagendada: ${String(row.tipo ?? 'atividade')}`,
      detalhe: `Novo lembrete: ${lembreteDepois ?? '—'}`,
      payload: { lembrete_anterior: lembreteAntes, lembrete_novo: lembreteDepois },
      discriminador: `reag:${carimbo}`,
    }, tx);
  }
}

// ----------------------------------------------------------------------------
// CANAL INTERNO — disparado pelo AGENDADOR (`dispararLembretesCrm`)
//
// Independente do canal externo (e-mail). O lembrete interno é o produto desta
// fase: o responsável vê o aviso DENTRO do ERP, mesmo sem SMTP configurado.
// ----------------------------------------------------------------------------

/** Dia (YYYY-MM-DD, UTC) para chaves de idempotência "por dia". */
function diaUTC(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Atividade VENCIDA (prazo já passou e ainda pendente) → aviso interno.
 * Idempotente POR DIA: uma atividade atrasada gera UM aviso por dia, não um
 * aviso a cada varredura do agendador.
 */
export async function notificarAtividadeVencida(row: Row, agora: Date = new Date()): Promise<boolean> {
  return criarNotificacaoCrm({
    empresaId: Number(row.empresa_id),
    atividadeId: Number(row.id),
    tipo: 'vencida',
    severidade: 'alta',
    usuarioId: responsavelDe(row),
    titulo: `Atividade vencida: ${String(row.tipo ?? 'atividade')}`,
    detalhe: String(row.resumo ?? ''),
    payload: { lembrete_em: row.lembrete_em ?? null, data_atividade: row.data_atividade ?? null },
    discriminador: `vencida:${diaUTC(agora)}`,
  });
}

/**
 * LEMBRETE interno (prazo ainda por vir) → aviso interno.
 * Idempotente por (atividade, INSTANTE do lembrete): reagendar muda o instante
 * e gera um novo aviso; a mesma configuração não duplica.
 */
export async function notificarLembreteInterno(row: Row, quando: Date): Promise<boolean> {
  return criarNotificacaoCrm({
    empresaId: Number(row.empresa_id),
    atividadeId: Number(row.id),
    tipo: 'lembrete',
    severidade: 'media',
    usuarioId: responsavelDe(row),
    titulo: `Lembrete: ${String(row.tipo ?? 'atividade')}`,
    detalhe: String(row.resumo ?? ''),
    payload: { quando: quando.toISOString(), prioridade: row.prioridade ?? 'media' },
    discriminador: `lembrete:${quando.toISOString()}`,
  });
}

/**
 * FALHA de processamento que exige ação administrativa (ex.: a entrega do
 * lembrete falhou de forma persistente). Idempotente POR DIA.
 */
export async function notificarFalhaProcessamento(row: Row, motivo: string, agora: Date = new Date()): Promise<boolean> {
  return criarNotificacaoCrm({
    empresaId: Number(row.empresa_id),
    atividadeId: Number(row.id),
    tipo: 'falha',
    severidade: 'critica',
    usuarioId: responsavelDe(row),
    titulo: `Falha ao processar atividade #${row.id}`,
    detalhe: motivo.slice(0, 1000),
    payload: { motivo },
    discriminador: `falha:${diaUTC(agora)}`,
  });
}

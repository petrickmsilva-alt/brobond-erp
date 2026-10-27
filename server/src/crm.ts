// ============================================================================
// CRM 3.0 — INTEGRAÇÃO DO FUNIL (Lead → Oportunidade)
// ----------------------------------------------------------------------------
// O CRM 3.0 (migration 0049) trouxe `crm_leads`, `crm_oportunidades`,
// `crm_atividades` e `crm_motivos_perda` com escopo de empresa, RBAC e
// vocabulário fechado no banco. Faltava o único elo do funil que não podia ser
// expresso por CRUD genérico:
//
//     LEAD  --converter-->  OPORTUNIDADE  --(proposta/venda)-->  receita
//
// Esta conversão NÃO cria arquitetura paralela: usa exatamente as duas tabelas
// oficiais do CRM, o cliente JÁ existente (sem duplicar cadastro), o
// representante/responsável já modelados e a auditoria do ERP. Também não é um
// "CRM 4.0" — é o contrato que liga lead a oportunidade e nada mais.
//
// GARANTIAS (mesmo padrão da conversão de proposta em pedido):
//
//   1) TRANSACIONAL — a oportunidade e a marcação do lead vivem ou morrem
//      juntas (transação serializable).
//   2) IDEMPOTENTE — repetir a chamada devolve a MESMA oportunidade. A defesa
//      é o `crm_leads.lead_convertido_em` gravado por UPDATE condicional
//      (compare-and-swap): quem perde a corrida faz rollback e a oportunidade
//      criada por ele desaparece.
//   3) MULTIEMPRESA — o lead é lido com `empresa_id` no predicado (404 para
//      lead de outra empresa, sem vazar existência) e a oportunidade nasce
//      carimbada com a empresa da sessão. Referências (cliente, responsável)
//      são validadas contra o mesmo tenant.
//   4) AUDITÁVEL — duas entradas na trilha: criação da oportunidade e
//      conversão do lead, ambas com empresa/usuário/antes-depois.
//   5) SEM DUPLICAR CLIENTE — a conversão nunca cria `clientes`. Se o lead
//      ainda não está vinculado, o documento (CPF/CNPJ) é usado apenas para
//      ENCONTRAR o cliente já cadastrado no tenant e vinculá-lo.
//
// O que NÃO faz (de propósito): não cria venda, não fatura, não mexe em
// estoque/financeiro. Lead → oportunidade é qualificação comercial; a receita
// continua nascendo no fluxo oficial proposta → venda → faturamento.
// ============================================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, clientePorDocumento, getStore, toHttpError } from './services';
import { currentUser } from './auth';
import {
  assertRegistroDaEmpresa,
  carimbarEmpresa,
  empresaDoRegistroAudit,
  escopoDoAtor,
  validarReferenciasDaEmpresa,
  type EscopoEmpresa,
} from './empresa';
import { parseId, validatePayload } from './validate';
import type { Payload, Row, Tx } from './store';

export const R_LEAD = () => getResource('crm_leads')!;
export const R_OPORTUNIDADE = () => getResource('crm_oportunidades')!;
const R_CLIENTE = () => getResource('clientes')!;

/** Status de lead que já encerraram o funil: não se convertem. */
const STATUS_ENCERRADOS = new Set(['ganho', 'perdido']);
/** Status de lead que a conversão promove para "qualificação". */
const STATUS_ANTES_DA_QUALIFICACAO = new Set(['novo', 'contato']);

/** Teto do nome da oportunidade (mesma coluna/campo do recurso). */
const NOME_MAX = 160;

function texto(v: unknown, max: number): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Alçada para converter: precisa LER o lead e CRIAR oportunidade. Os dois
 * recursos exigem gerente/admin (`minPerfil: 'gerente'`), então operador recebe
 * 403 — a autorização é a mesma do CRUD, não uma regra nova.
 */
function exigirConversao(req: Request) {
  const actor = currentUser(req);
  checkAccess(R_LEAD(), actor, 'read');
  checkAccess(R_OPORTUNIDADE(), actor, 'create');
  return actor;
}

/**
 * Vincula o cliente já cadastrado quando o lead traz documento mas ainda não
 * tem `cliente_id`. NUNCA cria cliente — evita duplicar o cadastro (a mesma
 * regra de unicidade por documento da empresa continua valendo).
 */
async function clienteDoLead(lead: Row, escopo: EscopoEmpresa, tx: Tx): Promise<number | null> {
  const existente = Number(lead.cliente_id);
  if (Number.isInteger(existente) && existente > 0) {
    const row = await getStore().findOneWhere(R_CLIENTE(), { id: existente, empresa_id: escopo.empresaId }, tx);
    if (!row) throw new HttpError(404, 'Cliente do lead não encontrado(a).');
    return existente;
  }
  if (!lead.documento) return null;
  const cliente = await clientePorDocumento(lead.documento, escopo.empresaId, null, tx);
  return cliente ? Number(cliente.id) : null;
}

/**
 * POST /api/crm/leads/:id/converter
 *
 * Corpo (todos opcionais — o padrão vem do próprio lead):
 *   { nome?, etapa?, valor?, probabilidade?, previsao_fechamento?,
 *     responsavel_id?, observacoes? }
 */
export async function converterLead(req: Request, res: Response) {
  const actor = exigirConversao(req);
  const escopo = escopoDoAtor(actor);
  const id = parseId(req.params.id);
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const s = getStore();

  try {
    const resultado = await s.transaction(async (tx) => {
      // 1) Lead do TENANT — 404 (e não 403) quando é de outra empresa.
      const lead = assertRegistroDaEmpresa(
        R_LEAD(),
        await s.findOneWhere(R_LEAD(), { id, empresa_id: escopo.empresaId }, tx),
        escopo
      );

      // 2) IDEMPOTÊNCIA (camada 1): já convertido? Devolve a mesma oportunidade.
      if (lead.lead_convertido_em) {
        const existente = await s.list(
          R_OPORTUNIDADE(),
          { page: 1, pageSize: 1, filter: { empresa_id: escopo.empresaId, lead_id: id }, sort: 'id', dir: 'asc' },
          tx
        );
        if (existente.rows.length) return { oportunidade: existente.rows[0], idempotente: true, lead };
      }

      if (STATUS_ENCERRADOS.has(String(lead.status))) {
        throw new HttpError(409, `O lead está "${lead.status}" e não pode ser convertido em oportunidade.`);
      }

      // 3) Oportunidade — valores do lead por padrão, sobrescritos pelo corpo.
      const clienteId = await clienteDoLead(lead, escopo, tx);
      const payload: Record<string, unknown> = {
        empresa_id: escopo.empresaId,
        nome: texto(body.nome || `${lead.nome} — oportunidade`, NOME_MAX),
        lead_id: id,
        cliente_id: clienteId,
        etapa: body.etapa ?? 'qualificacao',
        status: 'aberta',
        valor: body.valor ?? lead.valor_estimado ?? null,
        probabilidade: body.probabilidade ?? lead.probabilidade ?? 0,
        previsao_fechamento: body.previsao_fechamento ?? lead.previsao_contato ?? null,
        observacoes: body.observacoes ?? `Convertida do lead #${id}.`,
        responsavel_id: body.responsavel_id ?? lead.responsavel_id ?? null,
      };

      // A validação é a MESMA do CRUD: vocabulário fechado (etapa/status),
      // faixa de probabilidade, obrigatórios — nada de caminho alternativo.
      const data = validatePayload(R_OPORTUNIDADE(), payload, 'create');
      carimbarEmpresa(R_OPORTUNIDADE(), data, escopo);
      await validarReferenciasDaEmpresa(
        R_OPORTUNIDADE(),
        data,
        escopo,
        (alvo, alvoId, empresaId, t) => s.findOneWhere(alvo, { id: alvoId, empresa_id: empresaId }, t),
        tx
      );
      if (String(data.status) === 'perdida' && !data.motivo_perda_id) {
        throw new HttpError(400, 'Informe o motivo da perda.', { motivo_perda_id: 'Obrigatório quando o status é perdida.' });
      }

      const oportunidade = await s.insert(R_OPORTUNIDADE(), data, tx);

      // 4) IDEMPOTÊNCIA (camada 2): compare-and-swap no lead. Quem perde a
      //    corrida recebe 409 e a oportunidade criada acima é desfeita.
      const patchLead: Record<string, unknown> = { lead_convertido_em: new Date().toISOString() };
      if (STATUS_ANTES_DA_QUALIFICACAO.has(String(lead.status))) patchLead.status = 'qualificacao';
      const convertido = await s.tryUpdateIf(R_LEAD(), id, { lead_convertido_em: null }, patchLead, tx);
      if (!convertido) {
        throw new HttpError(409, 'Este lead acabou de ser convertido por outra operação. Nenhuma oportunidade duplicada foi criada.');
      }

      // 5) Auditoria — criação (oportunidade) + edição (lead).
      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'criar',
          recurso: 'crm_oportunidades',
          registro_id: Number(oportunidade.id),
          descricao: `Oportunidade #${oportunidade.id} criada a partir do lead #${id}`,
          dados: { lead_id: id, cliente_id: clienteId },
          empresa_id: empresaDoRegistroAudit(R_OPORTUNIDADE(), oportunidade, actor),
        },
        tx
      );
      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'editar',
          recurso: 'crm_leads',
          registro_id: id,
          descricao: `Lead #${id} convertido na oportunidade #${oportunidade.id}`,
          dados: { de: lead.status, para: convertido.status, oportunidade_id: Number(oportunidade.id) },
          empresa_id: empresaDoRegistroAudit(R_LEAD(), lead, actor),
        },
        tx
      );

      return { oportunidade, idempotente: false, lead: convertido };
    }, { isolation: 'serializable' });

    res.status(resultado.idempotente ? 200 : 201).json({
      ok: true,
      lead_id: id,
      oportunidade_id: Number(resultado.oportunidade.id),
      // Repetir a mesma conversão devolve a oportunidade existente — não uma nova.
      idempotente: resultado.idempotente,
      lead: resultado.lead,
      oportunidade: resultado.oportunidade,
      mensagem: resultado.idempotente
        ? 'Este lead já havia sido convertido; devolvendo a oportunidade existente.'
        : 'Lead convertido em oportunidade.',
    });
  } catch (e) {
    throw toHttpError(e, R_LEAD());
  }
}

// ============================================================================
// CRM 3.0 — EVOLUÇÃO (migration 0051)
// ----------------------------------------------------------------------------
// Quatro capacidades novas, todas DENTRO do CRM existente (nada é recriado):
//
//   1) HISTÓRICO DE ESTÁGIO — trilha própria da oportunidade, gravada na MESMA
//      transação da mudança de etapa (não depende da auditoria genérica).
//   2) LEAD SCORING — regra EXPLICÁVEL: cada componente do score é registrado
//      em `score_motivo`, para o representante entender por que o lead pontua.
//   3) AGENDA DE ATIVIDADES — hoje / atrasadas / próximas, por status real.
//   4) FORECAST + PAINEL — previsão ponderada por probabilidade e agregações de
//      funil, conversão por etapa e por origem, desempenho por responsável.
//
// REGRAS QUE NÃO MUDAM: empresa = tenant (todo predicado carrega empresa_id),
// RBAC do recurso (gerente/admin), nada de escrever em vendas/estoque/financeiro.
// ============================================================================
const R_ESTAGIO_HIST = () => getResource('crm_estagio_historico')!;
const R_ATIVIDADE = () => getResource('crm_atividades')!;
const R_FUNIL = () => getResource('crm_funis')!;
const R_CAMPANHA = () => getResource('crm_campanhas')!;

/** Etapas canônicas do funil (as mesmas aceitas pelo CHECK da migration 0049). */
export const ETAPAS_CRM = ['prospeccao', 'qualificacao', 'proposta', 'negociacao', 'fechamento'] as const;

/** Probabilidade padrão por etapa — usada só quando a etapa não tem cadastro. */
const PROBABILIDADE_PADRAO: Record<string, number> = {
  prospeccao: 10,
  qualificacao: 25,
  proposta: 50,
  negociacao: 75,
  fechamento: 90,
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function diaISO(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function hojeISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Grava uma linha no histórico de estágio. Chamada DENTRO da transação que
 * mudou a oportunidade (create/update do CRUD e transição explícita), para que
 * histórico e mudança vivam ou morram juntos.
 */
export async function registrarHistoricoEstagio(
  s: ReturnType<typeof getStore>,
  tx: Tx,
  params: {
    empresaId: number;
    oportunidadeId: number;
    estagioAnterior: string | null;
    estagioNovo: string;
    statusAnterior?: string | null;
    statusNovo?: string | null;
    usuarioId: number | null;
    observacao?: string | null;
  }
): Promise<void> {
  await s.insert(
    R_ESTAGIO_HIST(),
    {
      empresa_id: params.empresaId,
      oportunidade_id: params.oportunidadeId,
      estagio_anterior: params.estagioAnterior ?? null,
      estagio_novo: params.estagioNovo,
      status_anterior: params.statusAnterior ?? null,
      status_novo: params.statusNovo ?? null,
      usuario_id: params.usuarioId ?? null,
      observacao: params.observacao ?? null,
    },
    tx
  );
}

// ----------------------------------------------------------------------------
// LEAD SCORING — regra explicável
// ----------------------------------------------------------------------------
export type ScoreLead = { score: number; motivo: string };

/**
 * Calcula o score de um lead (0–100) com regras SIMPLES e EXPLICÁVEIS.
 *
 * Não há IA nem modelo escondido: cada parcela tem um motivo escrito, e o
 * resultado é a soma limitada a 100. Os critérios são os cinco pedidos pelo
 * produto — origem, interação, atividade, dados preenchidos, valor potencial e
 * recência.
 *
 * @param lead   linha do lead (valores já gravados/persistidos)
 * @param ctx    contexto: quantidade de atividades e data da última interação
 */
export function calcularScoreLead(
  lead: Row,
  ctx: { atividades: number; ultimaInteracao?: string | null; agora?: Date } = { atividades: 0 }
): ScoreLead {
  const partes: string[] = [];
  let score = 0;
  const somar = (valor: number, texto: string) => {
    if (!valor) return;
    score += valor;
    partes.push(`${texto} ${valor > 0 ? '+' : ''}${valor}`);
  };

  // 1) ORIGEM / CANAL
  const origem = String(lead.origem ?? '').toLowerCase();
  const canal = String(lead.canal ?? '').toLowerCase();
  const pesoOrigem: Record<string, number> = { indicacao: 15, feira: 10, site: 10, outbound: 5, outro: 0 };
  const pesoCanal: Record<string, number> = { marketplace: 12, evento: 10, site: 10, loja_fisica: 12, indicacao: 15, outbound: 5, outro: 0 };
  const o = pesoOrigem[origem] ?? 0;
  const c = pesoCanal[canal] ?? 0;
  if (o || c) somar(Math.max(o, c), `origem/canal (${canal || origem || 'não informado'})`);

  // 2) DADOS PREENCHIDOS
  if (lead.documento) somar(10, 'documento informado');
  if (lead.email) somar(5, 'e-mail informado');
  if (lead.telefone) somar(5, 'telefone informado');

  // 3) VALOR POTENCIAL
  const valor = num(lead.valor_estimado);
  if (valor !== null && valor > 0) {
    if (valor >= 5000) somar(15, 'valor potencial alto');
    else if (valor >= 1000) somar(8, 'valor potencial médio');
    else somar(4, 'valor potencial informado');
  }

  // 4) INTERAÇÃO (atividades registradas)
  const atividades = Math.max(0, Number(ctx.atividades) || 0);
  if (atividades > 0) somar(Math.min(20, atividades * 5), `${atividades} interação(ões)`);

  // 5) ATIVIDADE RECENTE (últimos 30 dias)
  const agora = ctx.agora ?? new Date();
  const ultima = ctx.ultimaInteracao ? new Date(String(ctx.ultimaInteracao)) : null;
  if (ultima && !Number.isNaN(ultima.getTime())) {
    const dias = Math.floor((agora.getTime() - ultima.getTime()) / 86_400_000);
    if (dias <= 30) somar(10, 'interação nos últimos 30 dias');
  }

  // 6) RECÊNCIA DO CADASTRO
  const criado = lead.criado_em ? new Date(String(lead.criado_em)) : null;
  if (criado && !Number.isNaN(criado.getTime())) {
    const dias = Math.floor((agora.getTime() - criado.getTime()) / 86_400_000);
    if (dias <= 7) somar(10, 'lead recente');
    else if (dias <= 30) somar(5, 'lead do mês');
  }

  // 7) AVANÇO NO FUNIL
  const status = String(lead.status ?? '');
  if (status === 'proposta') somar(10, 'proposta em andamento');
  else if (status === 'qualificacao') somar(5, 'lead qualificado');

  const final = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score: final,
    motivo: partes.length ? `${partes.join('; ')} = ${final}` : 'sem critérios de pontuação aplicáveis',
  };
}

/**
 * Recalcula e GRAVA o score do lead. Chamado pelo CRUD (create/update) na mesma
 * transação. A gravação é feita direto no store (`s.update`), nunca via
 * `updateRecord`, para não gerar auditoria duplicada nem reentrar no hook.
 */
export async function recalcularScoreDoLead(
  s: ReturnType<typeof getStore>,
  tx: Tx,
  leadId: number,
  empresaId: number,
  base?: Row
): Promise<ScoreLead> {
  const lead = base ?? (await s.findOneWhere(R_LEAD(), { id: leadId, empresa_id: empresaId }, tx));
  if (!lead) return { score: 0, motivo: 'lead não encontrado' };
  const atividades = await s.list(
    R_ATIVIDADE(),
    { page: 1, pageSize: 500, filter: { empresa_id: empresaId, lead_id: leadId } },
    tx
  );
  const datas = atividades.rows
    .map((a) => (a.data_atividade ? new Date(String(a.data_atividade)).getTime() : 0))
    .filter((n) => n > 0);
  const ultima = datas.length ? new Date(Math.max(...datas)).toISOString() : null;
  const resultado = calcularScoreLead(lead, { atividades: atividades.rows.length, ultimaInteracao: ultima });
  await s.update(
    R_LEAD(),
    leadId,
    {
      score: resultado.score,
      score_motivo: resultado.motivo,
      score_atualizado_em: new Date().toISOString(),
    },
    tx
  );
  return resultado;
}

// ----------------------------------------------------------------------------
// Helpers de leitura agregada (empresa-scoped)
// ----------------------------------------------------------------------------
async function listarTudo(
  s: ReturnType<typeof getStore>,
  key: string,
  empresaId: number,
  filtro: Record<string, unknown> = {},
  tx?: Tx
): Promise<Row[]> {
  const r = getResource(key)!;
  const paginado = await s.list(r, { page: 1, pageSize: 50_000, filter: { ...filtro, empresa_id: empresaId } }, tx);
  return paginado.rows;
}

function nomeDoUsuario(usuarios: Row[], id: unknown): string {
  const alvo = num(id);
  if (!alvo) return '—';
  const u = usuarios.find((x) => Number(x.id) === alvo);
  return u ? String(u.nome ?? u.email ?? `#${alvo}`) : `#${alvo}`;
}

// ----------------------------------------------------------------------------
// POST /api/crm/oportunidades/:id/estagio — transição explícita de etapa
// ----------------------------------------------------------------------------
export async function mudarEstagioOportunidade(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_OPORTUNIDADE(), actor, 'update');
  const escopo = escopoDoAtor(actor);
  const id = parseId(req.params.id);
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const novaEtapa = String(body.etapa ?? '').trim();
  if (!ETAPAS_CRM.includes(novaEtapa as (typeof ETAPAS_CRM)[number])) {
    throw new HttpError(400, `Etapa inválida. Use: ${ETAPAS_CRM.join(', ')}.`, { etapa: 'Etapa inválida' });
  }
  const observacao = body.observacao ? texto(body.observacao, 300) : null;
  const s = getStore();

  return s.transaction(async (tx) => {
    const antes = assertRegistroDaEmpresa(
      R_OPORTUNIDADE(),
      await s.findOneWhere(R_OPORTUNIDADE(), { id, empresa_id: escopo.empresaId }, tx),
      escopo
    );
    const etapaAtual = String(antes.etapa ?? '');
    if (etapaAtual === novaEtapa) {
      // Idempotente: repetir a mesma etapa não duplica histórico.
      return { ok: true, idempotente: true, etapa: novaEtapa, oportunidade: antes };
    }
    if (String(antes.status ?? 'aberta') !== 'aberta') {
      throw new HttpError(409, 'Oportunidade encerrada não muda de estágio.');
    }
    const probabilidade = body.probabilidade !== undefined ? Number(body.probabilidade) : undefined;
    const patch: Record<string, unknown> = { etapa: novaEtapa };
    if (probabilidade !== undefined && Number.isFinite(probabilidade)) {
      patch.probabilidade = Math.max(0, Math.min(100, probabilidade));
    }
    const depois = await s.update(R_OPORTUNIDADE(), id, patch, tx);
    await registrarHistoricoEstagio(s, tx, {
      empresaId: escopo.empresaId,
      oportunidadeId: id,
      estagioAnterior: etapaAtual || null,
      estagioNovo: novaEtapa,
      statusAnterior: antes.status ? String(antes.status) : null,
      statusNovo: depois?.status ? String(depois.status) : null,
      usuarioId: actor.id ?? null,
      observacao,
    });
    return { ok: true, idempotente: false, etapa: novaEtapa, oportunidade: depois };
  });
}

// ----------------------------------------------------------------------------
// GET /api/crm/oportunidades/:id/historico — trilha do funil da oportunidade
// ----------------------------------------------------------------------------
export async function historicoDaOportunidade(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_OPORTUNIDADE(), actor, 'read');
  checkAccess(R_ESTAGIO_HIST(), actor, 'read');
  const escopo = escopoDoAtor(actor);
  const id = parseId(req.params.id);
  const s = getStore();
  assertRegistroDaEmpresa(
    R_OPORTUNIDADE(),
    await s.findOneWhere(R_OPORTUNIDADE(), { id, empresa_id: escopo.empresaId }),
    escopo
  );
  const linhas = await listarTudo(s, 'crm_estagio_historico', escopo.empresaId, { oportunidade_id: id });
  const usuarios = await listarTudo(s, 'usuarios', escopo.empresaId);
  res.json({
    oportunidade_id: id,
    historico: linhas
      .slice()
      .sort((a, b) => String(a.criado_em ?? '').localeCompare(String(b.criado_em ?? '')))
      .map((h) => ({
        id: Number(h.id),
        estagio_anterior: h.estagio_anterior ?? null,
        estagio_novo: h.estagio_novo ?? null,
        status_anterior: h.status_anterior ?? null,
        status_novo: h.status_novo ?? null,
        usuario_id: num(h.usuario_id),
        usuario: nomeDoUsuario(usuarios, h.usuario_id),
        observacao: h.observacao ?? null,
        criado_em: h.criado_em ?? null,
      })),
  });
}

// ----------------------------------------------------------------------------
// GET /api/crm/atividades/agenda — hoje / atrasadas / próximas
// ----------------------------------------------------------------------------
export async function agendaDeAtividades(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_ATIVIDADE(), actor, 'read');
  const escopo = escopoDoAtor(actor);
  const s = getStore();
  const hoje = hojeISO();
  const atividades = await listarTudo(s, 'crm_atividades', escopo.empresaId);
  const leads = await listarTudo(s, 'crm_leads', escopo.empresaId);
  const oportunidades = await listarTudo(s, 'crm_oportunidades', escopo.empresaId);
  const usuarios = await listarTudo(s, 'usuarios', escopo.empresaId);
  const nomeLead = new Map(leads.map((l) => [Number(l.id), String(l.nome ?? `#${l.id}`)]));
  const nomeOportunidade = new Map(oportunidades.map((o) => [Number(o.id), String(o.nome ?? `#${o.id}`)]));

  const enriquecer = (a: Row) => {
    const lembrete = a.lembrete_em ? String(a.lembrete_em) : diaISO(a.data_atividade);
    const dia = diaISO(lembrete);
    const pendente = String(a.status ?? 'pendente') === 'pendente';
    return {
      id: Number(a.id),
      tipo: a.tipo ?? null,
      resumo: a.resumo ?? null,
      prioridade: a.prioridade ?? 'media',
      status: a.status ?? 'pendente',
      data_atividade: a.data_atividade ?? null,
      lembrete_em: a.lembrete_em ?? null,
      dia,
      concluida_em: a.concluida_em ?? null,
      responsavel_id: num(a.responsavel_id),
      responsavel: nomeDoUsuario(usuarios, a.responsavel_id),
      lead_id: num(a.lead_id),
      lead: a.lead_id ? (nomeLead.get(Number(a.lead_id)) ?? null) : null,
      oportunidade_id: num(a.oportunidade_id),
      oportunidade: a.oportunidade_id ? (nomeOportunidade.get(Number(a.oportunidade_id)) ?? null) : null,
      cliente_id: num(a.cliente_id),
      proxima_acao: a.proxima_acao ?? null,
      vencida: pendente && !!dia && dia < hoje,
      hoje: pendente && dia === hoje,
    };
  };

  const todas = atividades.map(enriquecer);
  const pendentes = todas.filter((a) => a.status === 'pendente');
  res.json({
    hoje: pendentes.filter((a) => a.hoje).sort((a, b) => String(a.lembrete_em ?? '').localeCompare(String(b.lembrete_em ?? ''))),
    atrasadas: pendentes.filter((a) => a.vencida).sort((a, b) => String(a.dia ?? '').localeCompare(String(b.dia ?? ''))),
    proximas: pendentes.filter((a) => !a.hoje && !a.vencida && !!a.dia && String(a.dia) > hoje),
    concluidas: todas.filter((a) => a.status === 'concluida').sort((a, b) => String(b.concluida_em ?? '').localeCompare(String(a.concluida_em ?? ''))),
    totais: {
      pendentes: pendentes.length,
      hoje: pendentes.filter((a) => a.hoje).length,
      atrasadas: pendentes.filter((a) => a.vencida).length,
      concluidas: todas.filter((a) => a.status === 'concluida').length,
    },
  });
}

// ----------------------------------------------------------------------------
// GET /api/crm/forecast — previsão ponderada por probabilidade
// ----------------------------------------------------------------------------
/**
 * Forecast = Σ (valor × probabilidade/100) das oportunidades ABERTAS.
 *
 * A probabilidade usada é, nesta ordem:
 *   1) a da própria oportunidade (campo `probabilidade`);
 *   2) a da etapa do funil configurado (`crm_etapas.probabilidade`);
 *   3) a probabilidade padrão da etapa.
 *
 * Nada é reescrito: o forecast é DERIVADO. As metas/comissões existentes
 * continuam sendo as únicas fontes de meta e de comissão.
 */
export async function forecastCrm(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_OPORTUNIDADE(), actor, 'read');
  const escopo = escopoDoAtor(actor);
  const s = getStore();
  const oportunidades = await listarTudo(s, 'crm_oportunidades', escopo.empresaId);
  const etapas = await listarTudo(s, 'crm_etapas', escopo.empresaId);
  const usuarios = await listarTudo(s, 'usuarios', escopo.empresaId);
  const representantes = await listarTudo(s, 'representantes', escopo.empresaId);

  const probPorEtapa = new Map<string, number>();
  for (const e of etapas) {
    const p = num(e.probabilidade);
    if (p !== null) probPorEtapa.set(String(e.chave), p);
  }
  const nomeRep = new Map(representantes.map((r) => [Number(r.id), String(r.nome ?? `#${r.id}`)]));

  const hoje = hojeISO();
  const mes = req.query.mes ? String(req.query.mes) : hoje.slice(0, 7);

  const abertas = oportunidades.filter((o) => String(o.status ?? 'aberta') === 'aberta');
  const linhas = abertas.map((o) => {
    const valor = num(o.valor) ?? 0;
    const etapa = String(o.etapa ?? '');
    const probInformada = num(o.probabilidade);
    const prob = probInformada !== null && probInformada > 0 ? probInformada : (probPorEtapa.get(etapa) ?? PROBABILIDADE_PADRAO[etapa] ?? 0);
    const previsao = diaISO(o.previsao_fechamento);
    return {
      oportunidade_id: Number(o.id),
      nome: o.nome ?? null,
      etapa,
      valor,
      probabilidade: prob,
      probabilidade_origem: probInformada ? 'oportunidade' : (probPorEtapa.has(etapa) ? 'funil' : 'padrao'),
      previsao_fechamento: previsao,
      ponderado: Math.round(valor * (prob / 100) * 100) / 100,
      responsavel_id: num(o.responsavel_id),
      responsavel: nomeDoUsuario(usuarios, o.responsavel_id),
      cliente_id: num(o.cliente_id),
      no_mes: !!previsao && previsao.slice(0, 7) === mes,
    };
  });

  const soma = (lista: typeof linhas) => Math.round(lista.reduce((t, l) => t + l.ponderado, 0) * 100) / 100;
  const porEtapa = ETAPAS_CRM.map((etapa) => {
    const lista = linhas.filter((l) => l.etapa === etapa);
    return {
      etapa,
      oportunidades: lista.length,
      valor_total: Math.round(lista.reduce((t, l) => t + l.valor, 0) * 100) / 100,
      forecast: soma(lista),
    };
  });
  const porResponsavel = [...new Set(linhas.map((l) => l.responsavel))]
    .map((responsavel) => {
      const lista = linhas.filter((l) => l.responsavel === responsavel);
      return {
        responsavel,
        oportunidades: lista.length,
        valor_total: Math.round(lista.reduce((t, l) => t + l.valor, 0) * 100) / 100,
        forecast: soma(lista),
      };
    })
    .sort((a, b) => b.forecast - a.forecast);

  res.json({
    periodo: mes,
    gerado_em: new Date().toISOString(),
    abertas: linhas.length,
    valor_total: Math.round(linhas.reduce((t, l) => t + l.valor, 0) * 100) / 100,
    forecast_total: soma(linhas),
    forecast_mes: soma(linhas.filter((l) => l.no_mes)),
    sem_previsao: linhas.filter((l) => !l.previsao_fechamento).length,
    por_etapa: porEtapa,
    por_responsavel: porResponsavel,
    oportunidades: linhas,
    representantes: representantes.map((r) => ({ id: Number(r.id), nome: nomeRep.get(Number(r.id)) })),
  });
}

// ----------------------------------------------------------------------------
// GET /api/crm/painel — dashboard comercial do CRM
// ----------------------------------------------------------------------------
export async function painelCrm(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_LEAD(), actor, 'read');
  checkAccess(R_OPORTUNIDADE(), actor, 'read');
  const escopo = escopoDoAtor(actor);
  const s = getStore();
  const [leads, oportunidades, atividades, etapas, origens, campanhas, usuarios] = await Promise.all([
    listarTudo(s, 'crm_leads', escopo.empresaId),
    listarTudo(s, 'crm_oportunidades', escopo.empresaId),
    listarTudo(s, 'crm_atividades', escopo.empresaId),
    listarTudo(s, 'crm_etapas', escopo.empresaId),
    listarTudo(s, 'crm_origens', escopo.empresaId),
    listarTudo(s, 'crm_campanhas', escopo.empresaId),
    listarTudo(s, 'usuarios', escopo.empresaId),
  ]);

  const hoje = hojeISO();
  const abertas = oportunidades.filter((o) => String(o.status ?? 'aberta') === 'aberta');
  const ganhas = oportunidades.filter((o) => String(o.status) === 'ganha');
  const perdidas = oportunidades.filter((o) => String(o.status) === 'perdida');
  const encerradas = ganhas.length + perdidas.length;

  const probPorEtapa = new Map<string, number>();
  for (const e of etapas) {
    const p = num(e.probabilidade);
    if (p !== null) probPorEtapa.set(String(e.chave), p);
  }
  const probabilidade = (o: Row) => {
    const p = num(o.probabilidade);
    if (p !== null && p > 0) return p;
    const etapa = String(o.etapa ?? '');
    return probPorEtapa.get(etapa) ?? PROBABILIDADE_PADRAO[etapa] ?? 0;
  };
  const valorDe = (o: Row) => num(o.valor) ?? 0;
  const round2 = (n: number) => Math.round(n * 100) / 100;

  // Funil por etapa (abertas) + conversão (ganhas / encerradas por etapa final
  // não faz sentido; a conversão por etapa é medida pelo avanço registrado no
  // histórico de estágio).
  const historico = await listarTudo(s, 'crm_estagio_historico', escopo.empresaId);
  const avancosPorEtapa = new Map<string, number>();
  for (const h of historico) {
    const destino = String(h.estagio_novo ?? '');
    avancosPorEtapa.set(destino, (avancosPorEtapa.get(destino) ?? 0) + 1);
  }
  const funil = ETAPAS_CRM.map((etapa) => {
    const lista = abertas.filter((o) => String(o.etapa) === etapa);
    return {
      etapa,
      nome: etapas.find((e) => String(e.chave) === etapa)?.nome ?? etapa,
      ordem: num(etapas.find((e) => String(e.chave) === etapa)?.ordem) ?? ETAPAS_CRM.indexOf(etapa) + 1,
      probabilidade: probPorEtapa.get(etapa) ?? PROBABILIDADE_PADRAO[etapa] ?? 0,
      oportunidades: lista.length,
      valor: round2(lista.reduce((t, o) => t + valorDe(o), 0)),
      forecast: round2(lista.reduce((t, o) => t + valorDe(o) * (probabilidade(o) / 100), 0)),
      avancos_registrados: avancosPorEtapa.get(etapa) ?? 0,
    };
  });

  // Conversão por origem (lead → oportunidade → ganho).
  const origemDoLead = new Map<number, string>();
  for (const l of leads) {
    const id = num(l.origem_id);
    const origem = id ? origens.find((o) => Number(o.id) === id) : null;
    origemDoLead.set(Number(l.id), String(origem?.nome ?? l.origem ?? 'não informada'));
  }
  const porOrigemMap = new Map<string, { leads: number; oportunidades: number; ganhas: number; valor_ganho: number }>();
  const garantir = (k: string) => {
    if (!porOrigemMap.has(k)) porOrigemMap.set(k, { leads: 0, oportunidades: 0, ganhas: 0, valor_ganho: 0 });
    return porOrigemMap.get(k)!;
  };
  for (const l of leads) garantir(origemDoLead.get(Number(l.id)) ?? 'não informada').leads += 1;
  const origemDaOportunidade = new Map<number, string>();
  for (const o of oportunidades) {
    const leadId = num(o.lead_id);
    const origem = leadId ? (origemDoLead.get(leadId) ?? 'não informada') : 'sem lead';
    origemDaOportunidade.set(Number(o.id), origem);
    const item = garantir(origem);
    item.oportunidades += 1;
    if (String(o.status) === 'ganha') {
      item.ganhas += 1;
      item.valor_ganho += valorDe(o);
    }
  }
  const porOrigem = [...porOrigemMap.entries()]
    .map(([origem, v]) => ({
      origem,
      leads: v.leads,
      oportunidades: v.oportunidades,
      ganhas: v.ganhas,
      valor_ganho: round2(v.valor_ganho),
      conversao_lead_oportunidade_pct: v.leads ? round2((v.oportunidades / v.leads) * 100) : null,
      conversao_ganho_pct: v.oportunidades ? round2((v.ganhas / v.oportunidades) * 100) : null,
    }))
    .sort((a, b) => b.leads - a.leads);

  // Atividades / atrasos
  const pendentes = atividades.filter((a) => String(a.status ?? 'pendente') === 'pendente');
  const diaDa = (a: Row) => diaISO(a.lembrete_em ?? a.data_atividade);
  const atrasadas = pendentes.filter((a) => {
    const d = diaDa(a);
    return !!d && d < hoje;
  });
  const deHoje = pendentes.filter((a) => diaDa(a) === hoje);

  // Desempenho por responsável
  const porResponsavel = [...new Set(abertas.map((o) => nomeDoUsuario(usuarios, o.responsavel_id)).concat(ganhas.map((o) => nomeDoUsuario(usuarios, o.responsavel_id))))]
    .map((responsavel) => {
      const minhasAbertas = abertas.filter((o) => nomeDoUsuario(usuarios, o.responsavel_id) === responsavel);
      const minhasGanhas = ganhas.filter((o) => nomeDoUsuario(usuarios, o.responsavel_id) === responsavel);
      const minhasAtividades = pendentes.filter((a) => nomeDoUsuario(usuarios, a.responsavel_id) === responsavel);
      return {
        responsavel,
        abertas: minhasAbertas.length,
        valor_aberto: round2(minhasAbertas.reduce((t, o) => t + valorDe(o), 0)),
        forecast: round2(minhasAbertas.reduce((t, o) => t + valorDe(o) * (probabilidade(o) / 100), 0)),
        ganhas: minhasGanhas.length,
        valor_ganho: round2(minhasGanhas.reduce((t, o) => t + valorDe(o), 0)),
        atividades_pendentes: minhasAtividades.length,
        atividades_atrasadas: minhasAtividades.filter((a) => {
          const d = diaDa(a);
          return !!d && d < hoje;
        }).length,
      };
    })
    .sort((a, b) => b.forecast - a.forecast);

  const investimento = campanhas.reduce((t, c) => t + (num(c.investimento) ?? 0), 0);
  res.json({
    gerado_em: new Date().toISOString(),
    leads: {
      total: leads.length,
      abertos: leads.filter((l) => !['ganho', 'perdido'].includes(String(l.status))).length,
      ganhos: leads.filter((l) => String(l.status) === 'ganho').length,
      perdidos: leads.filter((l) => String(l.status) === 'perdido').length,
      score_medio: leads.length ? round2(leads.reduce((t, l) => t + (num(l.score) ?? 0), 0) / leads.length) : 0,
      score_alto: leads.filter((l) => (num(l.score) ?? 0) >= 70).length,
      convertidos: leads.filter((l) => !!l.lead_convertido_em).length,
      conversao_pct: leads.length ? round2((leads.filter((l) => !!l.lead_convertido_em).length / leads.length) * 100) : 0,
    },
    oportunidades: {
      total: oportunidades.length,
      abertas: abertas.length,
      ganhas: ganhas.length,
      perdidas: perdidas.length,
      valor_aberto: round2(abertas.reduce((t, o) => t + valorDe(o), 0)),
      valor_ganho: round2(ganhas.reduce((t, o) => t + valorDe(o), 0)),
      valor_perdido: round2(perdidas.reduce((t, o) => t + valorDe(o), 0)),
      ticket_medio_ganho: ganhas.length ? round2(ganhas.reduce((t, o) => t + valorDe(o), 0) / ganhas.length) : 0,
      taxa_ganho_pct: encerradas ? round2((ganhas.length / encerradas) * 100) : null,
      forecast_ponderado: round2(abertas.reduce((t, o) => t + valorDe(o) * (probabilidade(o) / 100), 0)),
    },
    pipeline: funil,
    conversao_por_origem: porOrigem,
    campanhas: {
      total: campanhas.length,
      investimento: round2(investimento),
      custo_por_lead: leads.length && investimento ? round2(investimento / leads.length) : null,
      custo_por_ganho: ganhas.length && investimento ? round2(investimento / ganhas.length) : null,
    },
    atividades: {
      total: atividades.length,
      pendentes: pendentes.length,
      hoje: deHoje.length,
      atrasadas: atrasadas.length,
      concluidas: atividades.filter((a) => String(a.status) === 'concluida').length,
      por_prioridade: ['baixa', 'media', 'alta', 'urgente'].reduce<Record<string, number>>((acc, p) => {
        acc[p] = pendentes.filter((a) => String(a.prioridade ?? 'media') === p).length;
        return acc;
      }, {}),
    },
    por_responsavel: porResponsavel,
  });
}

// ----------------------------------------------------------------------------
// Normalizações de coerência do CRM (chamadas pelo CRUD, dentro da transação)
// ----------------------------------------------------------------------------
/**
 * ATIVIDADES — `concluida_em` é consequência do status, nunca campo livre.
 *
 * O banco tem CHECK (`status = 'concluida'` exige `concluida_em`). Em vez de
 * deixar o PostgreSQL recusar no commit, o servidor carimba/limpa o campo na
 * própria gravação.
 */
export function normalizarAtividadeCrm(data: Payload, before: Row | null): void {
  const status = data.status !== undefined ? String(data.status) : before ? String(before.status ?? 'pendente') : 'pendente';
  if (status === 'concluida') {
    if (!data.concluida_em && !(before && before.concluida_em)) data.concluida_em = new Date().toISOString();
  } else {
    data.concluida_em = null;
  }
  // Lembrete padrão: sem lembrete explícito, a agenda usa `data_atividade`.
  if (data.lembrete_em === undefined && before === null && data.proxima_acao) {
    data.lembrete_em = null;
  }
}

/**
 * OPORTUNIDADES — funil padrão da empresa quando nenhum foi informado.
 *
 * Não cria funil nem etapa: usa o que a migration 0051 semeou (um funil
 * padrão por empresa). Se a empresa não tiver funil padrão, deixa nulo — o
 * CRUD continua funcionando com o estágio textual, como antes.
 */
export async function resolverFunilPadrao(
  s: ReturnType<typeof getStore>,
  tx: Tx,
  empresaId: number,
  data: Payload
): Promise<void> {
  if (data.funil_id !== undefined && data.funil_id !== null && data.funil_id !== '') return;
  const funis = await s.list(R_FUNIL(), { page: 1, pageSize: 1, filter: { empresa_id: empresaId, padrao: true } }, tx);
  const padrao = funis.rows[0];
  if (padrao) data.funil_id = Number(padrao.id);
}

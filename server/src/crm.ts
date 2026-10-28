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
  EMPRESA_PADRAO,
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
      //
      // ETAPA: a conversão NÃO inventa estágio. Ela usa o funil PADRÃO da
      // empresa e a PRIMEIRA etapa ATIVA desse funil (por `ordem`). Se a
      // empresa ainda não cadastrou etapas, cai no vocabulário de
      // compatibilidade ('prospeccao') e diz isso na resposta (`funil.legado`).
      // Nunca cria funil/etapa escondida.
      const clienteId = await clienteDoLead(lead, escopo, tx);
      const funilId = await funilPadraoDaEmpresa(s, escopo.empresaId, tx);
      const etapaInicial = await resolverEtapaDoFunil(s, tx, {
        empresaId: escopo.empresaId,
        funilId,
        etapaId: body.etapa_id === undefined ? null : Number(body.etapa_id),
        etapaTexto: body.etapa === undefined || body.etapa === null ? null : String(body.etapa),
        exigirAtiva: true,
        padraoInicial: true,
      });

      const payload: Record<string, unknown> = {
        empresa_id: escopo.empresaId,
        nome: texto(body.nome || `${lead.nome} — oportunidade`, NOME_MAX),
        lead_id: id,
        cliente_id: clienteId,
        funil_id: etapaInicial?.funil_id ?? funilId,
        etapa_id: etapaInicial?.etapa_id ?? null,
        etapa: etapaInicial?.chave ?? ETAPAS_CRM[0],
        status: 'aberta',
        valor: body.valor ?? lead.valor_estimado ?? null,
        // Probabilidade: explícita (corpo) > lead (> 0) > PROBABILIDADE DA
        // ETAPA > 0. O `> 0` existe porque `crm_leads.probabilidade` tem
        // default 0 no schema: zero ali significa "não informado", não
        // "probabilidade nula" — e a etapa cadastrada é a fonte mais confiável.
        probabilidade:
          body.probabilidade ??
          (num(lead.probabilidade) !== null && Number(lead.probabilidade) > 0 ? Number(lead.probabilidade) : null) ??
          etapaInicial?.probabilidade ??
          0,
        previsao_fechamento: body.previsao_fechamento ?? lead.previsao_contato ?? null,
        observacoes: body.observacoes ?? `Convertida do lead #${id}.`,
        responsavel_id: body.responsavel_id ?? lead.responsavel_id ?? null,
      };

      // A validação é a MESMA do CRUD: faixa de probabilidade, obrigatórios,
      // referências da empresa — nada de caminho alternativo.
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

    const etapaFinal = resultado.oportunidade?.etapa_id
      ? await getStore().findOneWhere(R_ETAPA(), { id: Number(resultado.oportunidade.etapa_id), empresa_id: escopo.empresaId })
      : null;
    res.status(resultado.idempotente ? 200 : 201).json({
      ok: true,
      lead_id: id,
      // Etapa de destino da conversão, com a origem da decisão explícita:
      // 'cadastro' = veio do funil da empresa; 'compatibilidade' = a empresa
      // não tem etapas cadastradas e vale o vocabulário histórico.
      etapa: {
        id: resultado.oportunidade?.etapa_id ? Number(resultado.oportunidade.etapa_id) : null,
        chave: resultado.oportunidade?.etapa ?? null,
        nome: etapaFinal?.nome ?? null,
        funil_id: resultado.oportunidade?.funil_id ? Number(resultado.oportunidade.funil_id) : null,
        origem: resultado.oportunidade?.etapa_id ? 'cadastro' : 'compatibilidade',
      },
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
const R_ETAPA = () => getResource('crm_etapas')!;

/**
 * ETAPAS CANÔNICAS — semente e compatibilidade, NÃO autoridade.
 *
 * A autoridade sobre "quais estágios existem" é o CADASTRO da empresa
 * (`crm_etapas`). Esta lista sobrevive por três motivos legítimos:
 *   1) SEMENTE — é o que a migration 0051 semeia no funil padrão de cada
 *      empresa (nomes/rótulos/probabilidades iniciais);
 *   2) COMPATIBILIDADE — banco legado sem nenhuma etapa cadastrada continua
 *      operando pelo vocabulário que o CHECK da 0049 aceitava (hoje o CHECK é
 *      só "não vazio", ver migration 0057);
 *   3) LEITURA HISTÓRICA — chance que aparece em oportunidade antiga mas não
 *      está no cadastro continua sendo exibida no funil/painel em vez de
 *      desaparecer do relatório.
 *
 * O que ela NÃO faz mais: decidir se uma etapa pode ser usada. Quem decide é
 * `resolverEtapaDoFunil()` abaixo, consultando o cadastro da EMPRESA.
 */
export const ETAPAS_CRM = ['prospeccao', 'qualificacao', 'proposta', 'negociacao', 'fechamento'] as const;

/** Probabilidade histórica por etapa — usada só quando a etapa não tem cadastro. */
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

// ----------------------------------------------------------------------------
// ETAPAS DO FUNIL — a empresa é a autoridade (migration 0057)
//
// Toda escrita de etapa de oportunidade passa por aqui. As regras, nesta ordem:
//   1) a etapa existe no cadastro da EMPRESA da sessão (senão 404 — não vaza
//      existência de registro de outro tenant);
//   2) a etapa pertence ao FUNIL da oportunidade (senão 422);
//   3) a etapa está ATIVA para criação/movimentação (senão 422). Oportunidade
//      antiga em etapa desativada continua legível: só não se move para ela.
// Nada disso é validado no cliente: o cliente apenas recebe a lista
// (`GET /api/meta` → `optionsFrom: crm_etapas`) e escolhe.
// ----------------------------------------------------------------------------

export type EtapaResolvida = {
  /** `crm_etapas.id` — referência operacional (FK composta por empresa). */
  etapa_id: number | null;
  /** chave da etapa (é o que vai para `crm_oportunidades.etapa`). */
  chave: string;
  /** rótulo humano, quando a etapa veio do cadastro. */
  nome: string | null;
  /** funil a que a etapa pertence. */
  funil_id: number | null;
  /** probabilidade configurada na etapa (null quando não há cadastro). */
  probabilidade: number | null;
  /** true quando a resolução caiu no vocabulário de compatibilidade. */
  legado: boolean;
};

/** Etapas cadastradas da empresa (opcionalmente de um funil), ativas primeiro. */
export async function etapasDaEmpresa(
  s: ReturnType<typeof getStore>,
  empresaId: number,
  tx?: Tx,
  funilId?: number | null
): Promise<Row[]> {
  const filtro: Record<string, unknown> = { empresa_id: empresaId };
  if (funilId !== undefined && funilId !== null) filtro.funil_id = funilId;
  const { rows } = await s.list(R_ETAPA(), { page: 1, pageSize: 5000, filter: filtro }, tx);
  return rows.slice().sort((a, b) => {
    const oa = num(a.ordem) ?? 0;
    const ob = num(b.ordem) ?? 0;
    if (oa !== ob) return oa - ob;
    return String(a.nome ?? '').localeCompare(String(b.nome ?? ''));
  });
}

/** Funil padrão da empresa (a migration 0051 garante no máximo um). */
export async function funilPadraoDaEmpresa(
  s: ReturnType<typeof getStore>,
  empresaId: number,
  tx?: Tx
): Promise<number | null> {
  const { rows } = await s.list(R_FUNIL(), { page: 1, pageSize: 1, filter: { empresa_id: empresaId, padrao: true } }, tx);
  return rows[0] ? Number(rows[0].id) : null;
}

/**
 * Resolve a etapa da oportunidade contra o CADASTRO da empresa.
 *
 * Aceita `etapa_id` (referência) OU texto (chave ou nome, para compatibilidade
 * com integrações que já mandavam `etapa: 'proposta'`). Quando nada é informado
 * e `padraoInicial` é true (criação), usa a PRIMEIRA etapa ativa do funil — é
 * o que faz a conversão de lead respeitar a configuração da empresa.
 */
export async function resolverEtapaDoFunil(
  s: ReturnType<typeof getStore>,
  tx: Tx | undefined,
  params: {
    empresaId: number;
    funilId?: number | null;
    etapaId?: number | null;
    etapaTexto?: string | null;
    /** exige etapa ativa (criação e movimentação de funil) */
    exigirAtiva?: boolean;
    /** sem etapa informada: assume a primeira ativa do funil */
    padraoInicial?: boolean;
  }
): Promise<EtapaResolvida | null> {
  const { empresaId } = params;
  const funilId = params.funilId ?? null;
  const etapaId = num(params.etapaId ?? null);
  const texto = String(params.etapaTexto ?? '').replace(/\s+/g, ' ').trim();
  const todas = await etapasDaEmpresa(s, empresaId, tx);

  const doFunil = (e: Row) => funilId === null || Number(e.funil_id) === funilId;
  const ativa = (e: Row) => e.ativo !== false;

  if (etapaId !== null) {
    const etapa = todas.find((e) => Number(e.id) === etapaId);
    // 404 sem detalhe: nunca confirmamos a existência de etapa de outro tenant.
    if (!etapa) throw new HttpError(404, 'Etapa do funil não encontrada.');
    if (!doFunil(etapa)) {
      throw new HttpError(422, 'Esta etapa pertence a outro funil. Escolha uma etapa do funil da oportunidade.', {
        etapa_id: 'Etapa de outro funil',
      });
    }
    if (params.exigirAtiva && !ativa(etapa)) {
      throw new HttpError(422, 'Esta etapa está inativa e não pode receber movimentação. Reative a etapa ou escolha outra.', {
        etapa_id: 'Etapa inativa',
      });
    }
    return {
      etapa_id: Number(etapa.id),
      chave: String(etapa.chave),
      nome: etapa.nome === null || etapa.nome === undefined ? null : String(etapa.nome),
      funil_id: Number(etapa.funil_id),
      probabilidade: num(etapa.probabilidade),
      legado: false,
    };
  }

  if (texto) {
    // COMPATIBILIDADE: empresa sem NENHUMA etapa cadastrada (base legada, modo
    // demonstração sem semente, integração antiga). Só aceita o vocabulário
    // histórico — nada de inventar etapa nova — e diz que é legado.
    if (todas.length === 0) {
      const legado = ETAPAS_CRM.find((c) => c === texto.toLowerCase());
      if (legado) {
        return {
          etapa_id: null,
          chave: legado,
          nome: null,
          funil_id: funilId,
          probabilidade: PROBABILIDADE_PADRAO[legado] ?? 0,
          legado: true,
        };
      }
      throw new HttpError(
        422,
        `Etapa "${texto}" não existe e esta empresa ainda não cadastrou etapas de funil. Cadastre em CRM › Etapas do funil.`,
        { etapa: 'Etapa não cadastrada no funil' }
      );
    }
    const alvo = texto.toLowerCase();
    const candidatas = todas.filter((e) => String(e.chave).toLowerCase() === alvo || String(e.nome ?? '').toLowerCase() === alvo);
    // Prefere a etapa do funil da oportunidade e, entre iguais, a ativa.
    const ordenadas = candidatas
      .slice()
      .sort((a, b) => Number(!doFunil(a)) - Number(!doFunil(b)) || Number(!ativa(a)) - Number(!ativa(b)));
    const etapa = ordenadas[0];
    if (!etapa) {
      const disponiveis = todas.filter(doFunil).map((e) => String(e.chave));
      throw new HttpError(
        422,
        disponiveis.length
          ? `Etapa "${texto}" não existe no funil desta empresa. Etapas disponíveis: ${disponiveis.join(', ')}.`
          : 'O funil desta empresa não tem etapas cadastradas para este estágio.',
        { etapa: 'Etapa não cadastrada no funil' }
      );
    }
    if (!doFunil(etapa)) {
      throw new HttpError(422, 'Esta etapa pertence a outro funil. Escolha uma etapa do funil da oportunidade.', {
        etapa: 'Etapa de outro funil',
      });
    }
    if (params.exigirAtiva && !ativa(etapa)) {
      throw new HttpError(422, 'Esta etapa está inativa e não pode receber movimentação. Reative a etapa ou escolha outra.', {
        etapa: 'Etapa inativa',
      });
    }
    return {
      etapa_id: Number(etapa.id),
      chave: String(etapa.chave),
      nome: etapa.nome === null || etapa.nome === undefined ? null : String(etapa.nome),
      funil_id: Number(etapa.funil_id),
      probabilidade: num(etapa.probabilidade),
      legado: false,
    };
  }

  if (!params.padraoInicial) return null;

  // Sem etapa informada: primeira etapa ATIVA do funil (ordem do cadastro).
  const primeira = todas.filter((e) => doFunil(e) && ativa(e))[0];
  if (primeira) {
    return {
      etapa_id: Number(primeira.id),
      chave: String(primeira.chave),
      nome: primeira.nome === null || primeira.nome === undefined ? null : String(primeira.nome),
      funil_id: Number(primeira.funil_id),
      probabilidade: num(primeira.probabilidade),
      legado: false,
    };
  }

  // Compatibilidade: empresa sem NENHUMA etapa cadastrada. Mantém o
  // comportamento anterior (vocabulário canônico) e diz isso na resposta.
  if (todas.length === 0) {
    const chave = ETAPAS_CRM[0];
    return { etapa_id: null, chave, nome: null, funil_id: funilId, probabilidade: PROBABILIDADE_PADRAO[chave] ?? 0, legado: true };
  }
  throw new HttpError(422, 'O funil desta empresa não tem nenhuma etapa ativa. Reative uma etapa antes de criar oportunidades.', {
    etapa: 'Nenhuma etapa ativa no funil',
  });
}

/**
 * Aplica a etapa resolvida no payload da oportunidade (criação, edição e
 * conversão de lead). Sempre grava os DOIS lados:
 *   • `etapa_id` — referência operacional (FK composta, tenant safe);
 *   • `etapa`    — chave textual, para histórico/relatório/compatibilidade.
 */
export async function aplicarEtapaNaOportunidade(
  s: ReturnType<typeof getStore>,
  tx: Tx | undefined,
  escopo: EscopoEmpresa,
  data: Payload,
  before: Row | null,
  /** `probabilidadeInformada`: o corpo cru trazia `probabilidade`? (default 0
   *  do schema NÃO conta como informação do usuário) */
  opts: { probabilidadeInformada?: boolean } = {}
): Promise<EtapaResolvida | null> {
  const etapaInformada = data.etapa_id !== undefined || data.etapa !== undefined;
  // Nada foi dito sobre etapa/funil nesta gravação: preserva o que já existe.
  if (!etapaInformada && before) return null;
  // `funil_id` sozinho não move a etapa; se mudou de funil, a etapa é
  // revalidada contra o novo funil (e pode ser rejeitada — de propósito).
  const funilTrocado = data.funil_id !== undefined && before !== null && String(data.funil_id ?? '') !== String(before.funil_id ?? '');
  if (!etapaInformada && !funilTrocado && before) return null;

  const funilId = data.funil_id !== undefined
    ? num(data.funil_id)
    : before
      ? num(before.funil_id) ?? (await funilPadraoDaEmpresa(s, escopo.empresaId, tx))
      : await funilPadraoDaEmpresa(s, escopo.empresaId, tx);

  // Precedência: `etapa_id` explícito > `etapa` explícito > texto atual
  // (só quando o FUNIL mudou, para revalidar a etapa no funil novo).
  // Nunca herdamos o `etapa_id` antigo quando o chamador disse qual etapa
  // quer: isso faria a mudança ser silenciosamente ignorada.
  const etapaIdInformada = data.etapa_id === undefined ? null : num(data.etapa_id);
  const textoInformado =
    data.etapa !== undefined
      ? String(data.etapa ?? '')
      : funilTrocado && before
        ? String(before.etapa ?? '')
        : null;

  const resolvida = await resolverEtapaDoFunil(s, tx, {
    empresaId: escopo.empresaId,
    funilId,
    etapaId: etapaIdInformada,
    etapaTexto: textoInformado,
    exigirAtiva: true,
    padraoInicial: before === null && etapaIdInformada === null && !textoInformado,
  });

  if (!resolvida) return null;
  data.etapa_id = resolvida.etapa_id;
  data.etapa = resolvida.chave;
  if (funilId !== null && data.funil_id === undefined) data.funil_id = funilId;

  // PROBABILIDADE: a etapa cadastrada manda. O valor EXPLÍCITO do chamador
  // continua vencendo (é o override consciente do gestor).
  //
  // `probabilidade` tem default 0 no schema, então `data.probabilidade === 0`
  // não prova que alguém informou zero — pode ser o default preenchendo o
  // campo. Quem sabe a diferença é quem viu o corpo cru (createRecord/
  // updateRecord passam `probabilidadeInformada`).
  const explicita = opts.probabilidadeInformada;
  if (!explicita && resolvida.probabilidade !== null) data.probabilidade = resolvida.probabilidade;
  return resolvida;
}

/**
 * Grava uma linha no histórico de estágio. Chamada DENTRO da transação que
 * mudou a oportunidade (create/update do CRUD e transição explícita), para que
 * histórico e mudança vivam ou morram juntos.
 *
 * SNAPSHOT HISTÓRICO (migration 0058)
 * -----------------------------------
 * A trilha gravava só a CHAVE (`estagio_novo`). Como o rótulo exibido era
 * resolvido no cadastro ATUAL, renomear a etapa reescrevia o passado: uma
 * transição registrada quando a etapa se chamava "Proposta" passava a aparecer
 * como "Proposta Comercial" depois da renomeação. Aqui o registro passa a
 * guardar a fotografia do momento:
 *
 *   • `estagio_anterior_id` / `estagio_novo_id` — ids da etapa na transição;
 *   • `estagio_anterior_nome` / `estagio_novo_nome` — rótulo NAQUELE momento;
 *   • `funil_id` — o funil em que a transição aconteceu;
 *   • `usuario_nome` — o nome do usuário naquele momento;
 *   • `snapshot_versao = 1` — marca "esta linha TEM snapshot".
 *
 * Linha antiga (`snapshot_versao = 0`) NÃO é preenchida por inferência: o nome
 * de hoje não é o nome de ontem. A API diz que o snapshot não existe
 * (`nome_historico_indisponivel`) em vez de inventar.
 *
 * O nome é lido do CADASTRO dentro da MESMA transação da mudança — é
 * exatamente o valor vigente no instante da transição, não uma cópia futura.
 */
export async function registrarHistoricoEstagio(
  s: ReturnType<typeof getStore>,
  tx: Tx,
  params: {
    empresaId: number;
    oportunidadeId: number;
    estagioAnterior: string | null;
    estagioNovo: string;
    estagioAnteriorId?: number | null;
    estagioNovoId?: number | null;
    funilId?: number | null;
    statusAnterior?: string | null;
    statusNovo?: string | null;
    usuarioId: number | null;
    usuarioNome?: string | null;
    observacao?: string | null;
  }
): Promise<void> {
  // Nome e funil da etapa: lidos do cadastro DA EMPRESA, na mesma transação.
  const etapaDaEmpresa = async (id: unknown): Promise<Row | null> => {
    const alvo = num(id);
    if (alvo === null || alvo <= 0) return null;
    return s.findOneWhere(R_ETAPA(), { id: alvo, empresa_id: params.empresaId }, tx);
  };

  const anterior = await etapaDaEmpresa(params.estagioAnteriorId);
  const nova = await etapaDaEmpresa(params.estagioNovoId);

  const nomeDe = (etapa: Row | null): string | null => {
    if (!etapa) return null;
    const nome = etapa.nome === null || etapa.nome === undefined ? '' : String(etapa.nome).trim();
    return nome || null;
  };

  const funilId =
    num(params.funilId) ??
    (nova ? num(nova.funil_id) : null) ??
    (anterior ? num(anterior.funil_id) : null);

  await s.insert(
    R_ESTAGIO_HIST(),
    {
      empresa_id: params.empresaId,
      oportunidade_id: params.oportunidadeId,
      funil_id: funilId,
      estagio_anterior: params.estagioAnterior ?? null,
      estagio_anterior_id: anterior ? Number(anterior.id) : null,
      estagio_anterior_nome: nomeDe(anterior),
      estagio_novo: params.estagioNovo,
      estagio_novo_id: nova ? Number(nova.id) : null,
      estagio_novo_nome: nomeDe(nova),
      status_anterior: params.statusAnterior ?? null,
      status_novo: params.statusNovo ?? null,
      usuario_id: params.usuarioId ?? null,
      usuario_nome: params.usuarioNome ? String(params.usuarioNome).slice(0, 120) : null,
      observacao: params.observacao ?? null,
      // 1 = linha COM snapshot. A coluna tem default 0 justamente para que
      // linha antiga seja distinguível sem heurística.
      snapshot_versao: 1,
    },
    tx
  );
}

// ----------------------------------------------------------------------------
// LEAD SCORING — regra explicável
// ----------------------------------------------------------------------------
export type FatorScore = { criterio: string; rotulo: string; pontos: number; evidencia: string };
export type ScoreLead = { score: number; motivo: string; classificacao: string; fatores: FatorScore[] };

/**
 * Faixas de classificação do score.
 *
 * São DERIVADAS do número, não uma segunda pontuação: a mesma entrada sempre
 * produz a mesma faixa. Os limites são explícitos aqui (e repetidos no CHECK de
 * `crm_leads.score_classificacao`) para que a API e o banco concordem.
 */
export const CLASSIFICACAO_SCORE = [
  { chave: 'prioritario', minimo: 75 },
  { chave: 'quente', minimo: 50 },
  { chave: 'morno', minimo: 25 },
  { chave: 'frio', minimo: 0 },
] as const;

export function classificarScore(score: number): string {
  const alvo = Math.max(0, Math.min(100, Math.round(score)));
  return CLASSIFICACAO_SCORE.find((f) => alvo >= f.minimo)!.chave;
}

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
  const fatores: FatorScore[] = [];
  let score = 0;
  // `criterio` é a CHAVE estável (para programa); `rotulo` é o texto humano
  // que aparece no motivo. Os dois existem porque o número precisa ser
  // auditável por código e legível por gente.
  const somar = (valor: number, criterio: string, rotulo: string, evidencia: string) => {
    if (!valor) return;
    score += valor;
    fatores.push({ criterio, rotulo, pontos: valor, evidencia });
  };

  // 1) ORIGEM / CANAL
  const origem = String(lead.origem ?? '').toLowerCase();
  const canal = String(lead.canal ?? '').toLowerCase();
  const pesoOrigem: Record<string, number> = { indicacao: 15, feira: 10, site: 10, outbound: 5, outro: 0 };
  const pesoCanal: Record<string, number> = { marketplace: 12, evento: 10, site: 10, loja_fisica: 12, indicacao: 15, outbound: 5, outro: 0 };
  const o = pesoOrigem[origem] ?? 0;
  const c = pesoCanal[canal] ?? 0;
  if (o || c) {
    // Vale o MAIOR dos dois: origem e canal descrevem a mesma procedência e
    // somar os dois premiaria o mesmo sinal duas vezes.
    const rotulo = canal || origem || 'não informado';
    somar(Math.max(o, c), 'origem_canal', `origem/canal (${rotulo})`, `origem=${origem || '—'}, canal=${canal || '—'}`);
  }

  // 2) DADOS PREENCHIDOS — dado de contato é o que permite agir.
  if (lead.documento) somar(10, 'documento', 'documento', 'CPF/CNPJ informado');
  if (lead.email) somar(5, 'email', 'e-mail', 'e-mail informado');
  if (lead.telefone) somar(5, 'telefone', 'telefone', 'telefone informado');

  // 3) VALOR POTENCIAL
  const valor = num(lead.valor_estimado);
  if (valor !== null && valor > 0) {
    if (valor >= 5000) somar(15, 'valor_potencial', 'valor potencial alto', `valor estimado ${valor} ≥ 5000`);
    else if (valor >= 1000) somar(8, 'valor_potencial', 'valor potencial médio', `valor estimado ${valor} entre 1000 e 5000`);
    else somar(4, 'valor_potencial', 'valor potencial informado', `valor estimado ${valor} < 1000`);
  }

  // 4) INTERAÇÃO (atividades registradas) — teto de 20 pontos.
  const atividades = Math.max(0, Number(ctx.atividades) || 0);
  if (atividades > 0) somar(Math.min(20, atividades * 5), 'interacao', `${atividades} interação(ões)`, `${atividades} atividade(s) registrada(s) (5 cada, teto 20)`);

  // 5) ATIVIDADE RECENTE (últimos 30 dias)
  const agora = ctx.agora ?? new Date();
  const ultima = ctx.ultimaInteracao ? new Date(String(ctx.ultimaInteracao)) : null;
  if (ultima && !Number.isNaN(ultima.getTime())) {
    const dias = Math.floor((agora.getTime() - ultima.getTime()) / 86_400_000);
    if (dias >= 0 && dias <= 30) somar(10, 'atividade_recente', 'interação nos últimos 30 dias', `última atividade há ${dias} dia(s) (≤ 30)`);
  }

  // 6) RECÊNCIA DO CADASTRO
  const criado = lead.criado_em ? new Date(String(lead.criado_em)) : null;
  if (criado && !Number.isNaN(criado.getTime())) {
    const dias = Math.floor((agora.getTime() - criado.getTime()) / 86_400_000);
    if (dias >= 0 && dias <= 7) somar(10, 'regencia_cadastro', 'lead recente', `lead criado há ${dias} dia(s) (≤ 7)`);
    else if (dias >= 0 && dias <= 30) somar(5, 'regencia_cadastro', 'lead do mês', `lead criado há ${dias} dia(s) (≤ 30)`);
  }

  // 7) AVANÇO NO FUNIL
  const status = String(lead.status ?? '');
  if (status === 'proposta') somar(10, 'avanco_funil', 'proposta em andamento', 'status "proposta"');
  else if (status === 'qualificacao') somar(5, 'avanco_funil', 'lead qualificado', 'status "qualificacao"');

  const final = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score: final,
    motivo: fatores.length
      ? `${fatores.map((f) => `${f.rotulo} ${f.pontos > 0 ? '+' : ''}${f.pontos}`).join('; ')} = ${final}`
      : 'sem critérios de pontuação aplicáveis',
    classificacao: classificarScore(final),
    fatores,
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
  if (!lead) return { score: 0, motivo: 'lead não encontrado', classificacao: classificarScore(0), fatores: [] };
  const atividades = await s.list(
    R_ATIVIDADE(),
    { page: 1, pageSize: 500, filter: { empresa_id: empresaId, lead_id: leadId } },
    tx
  );
  // Só atividade NÃO CANCELADA conta como interação: cancelamento é desfazer a
  // intenção, então não é sinal comercial.
  const validas = atividades.rows.filter((a) => String(a.status ?? 'pendente') !== 'cancelada');
  const datas = validas
    .map((a) => (a.data_atividade ? new Date(String(a.data_atividade)).getTime() : 0))
    .filter((n) => n > 0);
  const ultima = datas.length ? new Date(Math.max(...datas)).toISOString() : null;
  const resultado = calcularScoreLead(lead, { atividades: validas.length, ultimaInteracao: ultima });
  await s.update(
    R_LEAD(),
    leadId,
    {
      score: resultado.score,
      score_motivo: resultado.motivo,
      score_classificacao: resultado.classificacao,
      // Fatores ESTRUTURADOS: o número continua auditável depois, sem
      // reexecutar a regra (que depende de "agora" e por isso não é
      // reproduzível a posteriori).
      score_fatores: JSON.stringify(resultado.fatores),
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

/**
 * Chaves de etapa para relatório: CADASTRO primeiro (ordenado por `ordem`),
 * depois as chaves que só aparecem em oportunidade antiga. Assim o painel não
 * esconde estágio histórico nem inventa estágio que a empresa não usa.
 */
function chavesDoFunil(etapas: Row[], oportunidades: Row[]): string[] {
  const doCadastro = etapas.slice().sort((a, b) => (num(a.ordem) ?? 0) - (num(b.ordem) ?? 0)).map((e) => String(e.chave));
  const vistas = new Set(doCadastro);
  const extras: string[] = [];
  for (const o of oportunidades) {
    const chave = String(o.etapa ?? '').trim();
    if (chave && !vistas.has(chave)) {
      vistas.add(chave);
      extras.push(chave);
    }
  }
  if (!doCadastro.length && !extras.length) return [...ETAPAS_CRM];
  return [...doCadastro, ...extras];
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
  const etapaIdBody = body.etapa_id === undefined || body.etapa_id === null || body.etapa_id === '' ? null : Number(body.etapa_id);
  const etapaTexto = body.etapa === undefined || body.etapa === null ? '' : String(body.etapa).trim();
  if (etapaIdBody === null && !etapaTexto) {
    throw new HttpError(400, 'Informe a etapa de destino (etapa_id ou etapa).', { etapa: 'Obrigatório' });
  }
  const observacao = body.observacao ? texto(body.observacao, 300) : null;
  const s = getStore();

  // TUDO na mesma transação: validar oportunidade/funil/etapa, gravar a
  // mudança e gravar o histórico. Qualquer falha → rollback completo (nada de
  // oportunidade movida sem trilha).
  //
  // ATENÇÃO: o `wrap()` do Express descarta o valor de retorno do handler —
  // sem `res.json()` explícito a rota ficava pendurada. A resposta é enviada
  // aqui, depois do commit.
  const resultado = await s.transaction(async (tx) => {
    const antes = assertRegistroDaEmpresa(
      R_OPORTUNIDADE(),
      await s.findOneWhere(R_OPORTUNIDADE(), { id, empresa_id: escopo.empresaId }, tx),
      escopo
    );
    const etapaAtual = String(antes.etapa ?? '');

    // A etapa de destino vem do CADASTRO da empresa (o funil é o da própria
    // oportunidade). Etapa de outro funil, de outro tenant ou inativa → erro.
    const destino = await resolverEtapaDoFunil(s, tx, {
      empresaId: escopo.empresaId,
      funilId: num(antes.funil_id) ?? (await funilPadraoDaEmpresa(s, escopo.empresaId, tx)),
      etapaId: etapaIdBody,
      etapaTexto,
      exigirAtiva: true,
    });
    if (!destino) throw new HttpError(400, 'Informe a etapa de destino.', { etapa: 'Obrigatório' });

    if (etapaAtual === destino.chave && num(antes.etapa_id) === destino.etapa_id) {
      // Idempotente: repetir a mesma etapa não duplica histórico.
      return { ok: true, idempotente: true, etapa: destino.chave, etapa_id: destino.etapa_id, oportunidade: antes };
    }
    if (String(antes.status ?? 'aberta') !== 'aberta') {
      throw new HttpError(409, 'Oportunidade encerrada não muda de estágio.');
    }

    const patch: Record<string, unknown> = { etapa: destino.chave, etapa_id: destino.etapa_id };
    const probabilidadeInformada = body.probabilidade !== undefined && body.probabilidade !== null && body.probabilidade !== '';
    if (probabilidadeInformada) {
      const p = Number(body.probabilidade);
      if (!Number.isFinite(p)) throw new HttpError(400, 'Probabilidade inválida.', { probabilidade: 'Número de 0 a 100' });
      patch.probabilidade = Math.max(0, Math.min(100, p));
    } else if (destino.probabilidade !== null) {
      // Probabilidade POR ETAPA: mover para "Proposta 50%" já aplica os 50%
      // no forecast, sem o gestor digitar de novo.
      patch.probabilidade = Math.max(0, Math.min(100, destino.probabilidade));
    }
    const depois = await s.update(R_OPORTUNIDADE(), id, patch, tx);
    await registrarHistoricoEstagio(s, tx, {
      empresaId: escopo.empresaId,
      oportunidadeId: id,
      estagioAnterior: etapaAtual || null,
      estagioAnteriorId: num(antes.etapa_id),
      estagioNovo: destino.chave,
      estagioNovoId: destino.etapa_id,
      funilId: destino.funil_id ?? num(antes.funil_id),
      statusAnterior: antes.status ? String(antes.status) : null,
      statusNovo: depois?.status ? String(depois.status) : null,
      usuarioId: actor.id ?? null,
      usuarioNome: actor.name ?? null,
      observacao,
    });
    return {
      ok: true,
      idempotente: false,
      etapa: destino.chave,
      etapa_id: destino.etapa_id,
      etapa_nome: destino.nome,
      probabilidade: depois?.probabilidade ?? null,
      oportunidade: depois,
    };
  });

  return res.json(resultado);
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
  // Cadastro ATUAL: serve só para rotular o que a trilha não fotografou. Nunca
  // é usado como se fosse o nome da época (ver `nome_historico_indisponivel`).
  const etapas = await listarTudo(s, 'crm_etapas', escopo.empresaId);
  const nomeAtualDaChave = new Map(etapas.map((e) => [String(e.chave), String(e.nome ?? e.chave)]));

  res.json({
    oportunidade_id: id,
    // Contrato explícito do snapshot: quem lê sabe quando o nome é HISTÓRICO
    // (gravado na transição) e quando é apenas o rótulo ATUAL do cadastro.
    contrato_snapshot: {
      versao: 1,
      gravado_desde: 'migration 0058',
      legado: 'linhas com snapshot_versao=0 foram criadas antes do snapshot; o nome da etapa NÃO é recuperável e não é inferido do cadastro atual',
    },
    historico: linhas
      .slice()
      .sort((a, b) => String(a.criado_em ?? '').localeCompare(String(b.criado_em ?? '')))
      .map((h) => {
        const versao = Number(h.snapshot_versao ?? 0);
        const temSnapshot = versao >= 1;
        const chaveNova = h.estagio_novo === null || h.estagio_novo === undefined ? null : String(h.estagio_novo);
        const chaveAnterior = h.estagio_anterior === null || h.estagio_anterior === undefined ? null : String(h.estagio_anterior);
        return {
          id: Number(h.id),
          oportunidade_id: num(h.oportunidade_id),
          empresa_id: num(h.empresa_id),
          funil_id: num(h.funil_id),
          estagio_anterior: chaveAnterior,
          estagio_anterior_id: num(h.estagio_anterior_id),
          estagio_anterior_nome: h.estagio_anterior_nome ?? null,
          estagio_novo: chaveNova,
          estagio_novo_id: num(h.estagio_novo_id),
          estagio_novo_nome: h.estagio_novo_nome ?? null,
          // Rótulo do cadastro ATUAL — separado de propósito. Não substitui o
          // snapshot: é informação de hoje sobre uma chave histórica.
          estagio_novo_nome_atual: chaveNova ? (nomeAtualDaChave.get(chaveNova) ?? null) : null,
          estagio_anterior_nome_atual: chaveAnterior ? (nomeAtualDaChave.get(chaveAnterior) ?? null) : null,
          snapshot_versao: versao,
          /** true quando ESTA linha não tem o nome histórico gravado. */
          nome_historico_indisponivel: !temSnapshot,
          status_anterior: h.status_anterior ?? null,
          status_novo: h.status_novo ?? null,
          usuario_id: num(h.usuario_id),
          // Nome do usuário: snapshot quando existe; senão o cadastro atual
          // (o usuário é uma identidade viva, não um rótulo de estágio).
          usuario: (h.usuario_nome ? String(h.usuario_nome) : null) ?? nomeDoUsuario(usuarios, h.usuario_id),
          usuario_nome_historico: h.usuario_nome ?? null,
          observacao: h.observacao ?? null,
          criado_em: h.criado_em ?? null,
        };
      }),
  });
}

// ----------------------------------------------------------------------------
// POST /api/crm/funis/:id/etapas/reordenar — reordenação TRANSACIONAL do funil
//
// O QUE ESTA ROTA GARANTE (e por quê)
// -----------------------------------
// `ordem` é a posição da etapa no funil. Antes dela ser única por funil
// (migration 0058), "reordenar" era um PUT por etapa: duas chamadas
// concorrentes deixavam duas etapas na mesma posição e a tela mostrava uma
// ordem que o banco não tinha. Esta rota trata a reordenação como o que ela é —
// UMA operação sobre o funil inteiro:
//
//   1) TENANT — todas as etapas são lidas com `empresa_id` da sessão. Etapa de
//      outra empresa responde 404 (o ERP não confirma existência de dado
//      alheio), nunca 200.
//   2) FUNIL — etapa de outro funil da MESMA empresa responde 422: é engano de
//      tela, não vazamento.
//   3) COMPLETUDE — o corpo precisa listar TODAS as etapas do funil, cada uma
//      uma única vez. Lista parcial é recusada (400): renumerar 1..N com um
//      subconjunto embaralharia as etapas que ficaram de fora.
//   4) SEM DUPLICATA — id repetido ou ordem repetida no corpo é 400. O índice
//      único do banco é a segunda barreira.
//   5) TRANSACIONAL — a renumeração inteira vive numa transação. Falha no meio
//      → rollback: nenhuma etapa fica "meio reordenada".
//   6) AUDITÁVEL — uma entrada na trilha com a ordem ANTES e DEPOIS.
//
// COMO A RENUMERAÇÃO EVITA COLISÃO TRANSITÓRIA
// --------------------------------------------
// Trocar duas posições (1↔2) colidiria com o índice único no meio do caminho.
// Por isso a renumeração é feita em DUAS passadas: primeiro todas as etapas do
// funil recebem `ordem + deslocamento` (uma translação — preserva a unicidade e
// deixa todo mundo acima de N), depois cada uma recebe sua posição final 1..N.
// Nenhum estado intermediário viola a unicidade, sem precisar de constraint
// adiada.
// ----------------------------------------------------------------------------
export async function reordenarEtapasDoFunil(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_ETAPA(), actor, 'update');
  const escopo = escopoDoAtor(actor);
  const funilId = parseId(req.params.id);
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

  // Aceita os dois formatos: `{ ordem: [id, id, ...] }` (sequência direta) e
  // `{ etapas: [{ id | etapa_id, ordem }] }` (posição explícita).
  const alvo = new Map<number, number>();
  const sequencia = Array.isArray(body.ordem) ? body.ordem : Array.isArray(body.etapas) ? body.etapas : null;
  if (!sequencia) {
    throw new HttpError(400, 'Informe a nova ordem das etapas em `ordem` (lista de ids) ou `etapas` (lista de {id, ordem}).', {
      ordem: 'Obrigatório',
    });
  }
  if (Array.isArray(body.etapas) && !Array.isArray(body.ordem)) {
    body.etapas.forEach((item: unknown, indice: number) => {
      const linha = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
      const id = Number(linha.id ?? linha.etapa_id);
      const ordem = linha.ordem === undefined ? indice + 1 : Number(linha.ordem);
      if (!Number.isInteger(id) || id <= 0) {
        throw new HttpError(400, 'Item de `etapas` sem `id`/`etapa_id` válido.', { etapas: `Item ${indice + 1} inválido` });
      }
      if (!Number.isInteger(ordem) || ordem <= 0) {
        throw new HttpError(400, 'A posição (`ordem`) precisa ser um inteiro maior que zero.', { etapas: `Item ${indice + 1}: ordem inválida` });
      }
      if (alvo.has(id)) throw new HttpError(400, `A etapa #${id} aparece mais de uma vez na reordenação.`, { etapas: 'Id repetido' });
      alvo.set(id, ordem);
    });
  } else {
    (sequencia as unknown[]).forEach((valor, indice) => {
      const id = Number(valor);
      if (!Number.isInteger(id) || id <= 0) {
        throw new HttpError(400, 'A lista `ordem` deve conter apenas ids de etapa.', { ordem: `Item ${indice + 1} inválido` });
      }
      if (alvo.has(id)) throw new HttpError(400, `A etapa #${id} aparece mais de uma vez na reordenação.`, { ordem: 'Id repetido' });
      alvo.set(id, indice + 1);
    });
  }
  if (alvo.size === 0) throw new HttpError(400, 'A reordenação precisa de pelo menos uma etapa.', { ordem: 'Lista vazia' });

  const posicoes = [...alvo.values()];
  if (new Set(posicoes).size !== posicoes.length) {
    throw new HttpError(400, 'Há duas etapas na mesma posição. Cada etapa ocupa uma posição distinta.', { etapas: 'Ordem duplicada' });
  }

  const s = getStore();
  const resultado = await s.transaction(async (tx) => {
    // 1) Funil do TENANT — 404 para funil de outra empresa.
    const funil = assertRegistroDaEmpresa(
      R_FUNIL(),
      await s.findOneWhere(R_FUNIL(), { id: funilId, empresa_id: escopo.empresaId }, tx),
      escopo
    );

    // 2) Todas as etapas do funil (o conjunto que a reordenação precisa cobrir).
    const doFunil = await listarTudo(s, 'crm_etapas', escopo.empresaId, { funil_id: funilId }, tx);
    const idsDoFunil = new Set(doFunil.map((e) => Number(e.id)));

    // 3) Etapa informada que não é deste funil.
    for (const id of alvo.keys()) {
      if (!idsDoFunil.has(id)) {
        // Existe em OUTRO tenant? Então 404 (não confirmamos existência alheia).
        const daEmpresa = await s.findOneWhere(R_ETAPA(), { id, empresa_id: escopo.empresaId }, tx);
        if (!daEmpresa) throw new HttpError(404, `A etapa #${id} não existe nesta empresa.`);
        throw new HttpError(422, `A etapa #${id} pertence a outro funil. Reordene cada funil separadamente.`, {
          etapas: 'Etapa de outro funil',
        });
      }
    }

    // 4) Completude: reordenar um subconjunto renumeraria 1..N e embaralharia
    //    as etapas omitidas.
    const faltando = [...idsDoFunil].filter((id) => !alvo.has(id));
    if (faltando.length) {
      throw new HttpError(
        400,
        `A reordenação precisa listar TODAS as ${idsDoFunil.size} etapas do funil. Faltaram: ${faltando.map((id) => `#${id}`).join(', ')}.`,
        { etapas: 'Lista incompleta' }
      );
    }

    const antes = doFunil
      .slice()
      .sort((a, b) => (num(a.ordem) ?? 0) - (num(b.ordem) ?? 0))
      .map((e) => ({ id: Number(e.id), chave: String(e.chave), nome: String(e.nome ?? ''), ordem: num(e.ordem) ?? 0 }));

    // 5) Duas passadas (ver comentário da função): translação e depois posição.
    const deslocamento = Math.max(0, ...antes.map((e) => e.ordem)) + idsDoFunil.size + 1;
    for (const e of antes) {
      await s.update(R_ETAPA(), e.id, { ordem: e.ordem + deslocamento }, tx);
    }
    for (const e of antes) {
      await s.update(R_ETAPA(), e.id, { ordem: alvo.get(e.id)! }, tx);
    }

    const depois = (await listarTudo(s, 'crm_etapas', escopo.empresaId, { funil_id: funilId }, tx))
      .slice()
      .sort((a, b) => (num(a.ordem) ?? 0) - (num(b.ordem) ?? 0))
      .map((e) => ({ id: Number(e.id), chave: String(e.chave), nome: String(e.nome ?? ''), ordem: num(e.ordem) ?? 0 }));

    await s.audit(
      {
        usuario_id: actor.id || null,
        usuario: actor.name,
        acao: 'editar',
        recurso: 'crm_etapas',
        registro_id: funilId,
        descricao: `Funil "${String(funil.nome)}" reordenado (${depois.length} etapa(s))`,
        dados: { funil_id: funilId, antes, depois },
        empresa_id: escopo.empresaId,
      },
      tx
    );

    return { funil, antes, depois };
  });

  res.json({
    ok: true,
    funil_id: funilId,
    funil: String(resultado.funil.nome),
    etapas: resultado.depois,
    antes: resultado.antes,
    depois: resultado.depois,
  });
}


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
      // Estado do LEMBRETE: `lembrete_enviado_em` só é gravado quando houve
      // notificação de verdade (0058). NULL = ainda não disparado.
      lembrete_enviado_em: a.lembrete_enviado_em ?? null,
      lembrete_pendente: !a.lembrete_enviado_em && String(a.status ?? 'pendente') === 'pendente',
      concluida_em: a.concluida_em ?? null,
      cancelada_em: a.cancelada_em ?? null,
      motivo_cancelamento: a.motivo_cancelamento ?? null,
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
    /** Canceladas continuam listadas: cancelar não é excluir. */
    canceladas: todas
      .filter((a) => a.status === 'cancelada')
      .sort((a, b) => String(b.cancelada_em ?? '').localeCompare(String(a.cancelada_em ?? ''))),
    totais: {
      pendentes: pendentes.length,
      hoje: pendentes.filter((a) => a.hoje).length,
      atrasadas: pendentes.filter((a) => a.vencida).length,
      concluidas: todas.filter((a) => a.status === 'concluida').length,
      canceladas: todas.filter((a) => a.status === 'cancelada').length,
      lembretes_pendentes: pendentes.filter((a) => a.lembrete_pendente).length,
    },
    /** Como o lembrete é entregue — o frontend não dispara nada. */
    lembretes: {
      canal: 'agendador (POST /api/admin/scheduled/run | /cron) + e-mail opcional',
      idempotente: true,
      marcador: 'lembrete_enviado_em',
    },
  });
}

// ----------------------------------------------------------------------------
// LEMBRETES DE ATIVIDADE — disparo idempotente, pelo AGENDADOR EXISTENTE
//
// Sem marca de envio, uma varredura a cada minuto reenviaria o mesmo lembrete
// para sempre. A idempotência aqui é a mesma do resto do ERP: UPDATE
// CONDICIONAL (compare-and-swap) em `lembrete_enviado_em`. Quem consegue gravar
// o carimbo é quem dispara; quem perde a corrida não notifica.
//
// Não há infraestrutura paralela: o canal é o mesmo `notifications.ts` usado
// por estoque/produção, e a execução é a mesma de `scheduled.ts`. Nada de
// polling no navegador.
// ----------------------------------------------------------------------------
export async function dispararLembretesCrm(
  agora: Date = new Date()
): Promise<{ analisados: number; disparados: number; empresas: number; canal: string }> {
  // Import dinâmico: `notifications` depende de `services`, que depende deste
  // módulo — importar no topo criaria ciclo.
  const canal = await import('./notifications');
  // Canal DESLIGADO: não carimbamos `lembrete_enviado_em`, senão a trilha
  // diria "enviado" para algo que nunca saiu. O lembrete segue visível na
  // Agenda; o carimbo só acontece quando há entrega de verdade.
  if (!canal.crmLembreteHabilitado()) {
    return { analisados: 0, disparados: 0, empresas: 0, canal: 'desabilitado' };
  }

  const s = getStore();
  const limite = agora.getTime();
  // `empresas` é o cadastro de TENANTS — não tem `empresa_id`, então usa a
  // listagem crua (sem o filtro de escopo dos recursos multiempresa).
  const empresas = (await s.list(getResource('empresas')!, { page: 1, pageSize: 1000 })).rows;
  const ids = empresas.length ? empresas.map((e) => Number(e.id)) : [EMPRESA_PADRAO];

  let analisados = 0;
  let disparados = 0;
  const notificacoes: { empresaId: number; atividade: Row; lead: Row | null; oportunidade: Row | null }[] = [];

  for (const empresaId of ids) {
    const pendentes = await listarTudo(s, 'crm_atividades', empresaId, { status: 'pendente' });
    for (const atividade of pendentes) {
      const lembrete = atividade.lembrete_em ? new Date(String(atividade.lembrete_em)) : null;
      // Sem lembrete explícito, a própria data da atividade é o lembrete.
      const quando = lembrete ?? (atividade.data_atividade ? new Date(String(atividade.data_atividade)) : null);
      if (!quando || Number.isNaN(quando.getTime())) continue;
      if (quando.getTime() > limite) continue; // ainda não venceu
      if (atividade.lembrete_enviado_em) continue;
      analisados += 1;

      const reivindicado = await s.tryUpdateIf(
        R_ATIVIDADE(),
        Number(atividade.id),
        { lembrete_enviado_em: null },
        { lembrete_enviado_em: agora.toISOString() }
      );
      if (!reivindicado) continue; // outra execução já notificou
      disparados += 1;

      const leadId = num(atividade.lead_id);
      const oppId = num(atividade.oportunidade_id);
      const lead = leadId === null ? null : await s.findOneWhere(R_LEAD(), { id: leadId, empresa_id: empresaId });
      const oportunidade = oppId === null ? null : await s.findOneWhere(R_OPORTUNIDADE(), { id: oppId, empresa_id: empresaId });
      notificacoes.push({ empresaId, atividade: reivindicado, lead, oportunidade });
    }
  }

  if (notificacoes.length) {
    for (const n of notificacoes) {
      await canal.notificarLembreteCrm({
        empresaId: n.empresaId,
        atividadeId: Number(n.atividade.id),
        tipo: String(n.atividade.tipo ?? 'tarefa'),
        resumo: String(n.atividade.resumo ?? ''),
        quando: n.atividade.lembrete_em ?? n.atividade.data_atividade ?? null,
        prioridade: String(n.atividade.prioridade ?? 'media'),
        lead: n.lead ? String(n.lead.nome ?? `#${n.atividade.lead_id}`) : null,
        oportunidade: n.oportunidade ? String(n.oportunidade.nome ?? `#${n.atividade.oportunidade_id}`) : null,
      }).catch(() => undefined); // canal indisponível nunca derruba o agendador
    }
  }

  return { analisados, disparados, empresas: ids.length, canal: 'habilitado' };
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
  // A lista de etapas do relatório vem do CADASTRO (ordenada por `ordem`).
  // Chaves que só existem em oportunidade antiga (sem cadastro) entram no fim,
  // para o relatório não "perder" receita histórica.
  const etapasRelatorio = chavesDoFunil(etapas, oportunidades);
  const porEtapa = etapasRelatorio.map((etapa) => {
    const lista = linhas.filter((l) => l.etapa === etapa);
    return {
      etapa,
      nome: String(etapas.find((e) => String(e.chave) === etapa)?.nome ?? etapa),
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
/**
 * Filtros do painel de conversão.
 *
 * Todos são OPCIONAIS e todos são aplicados no SERVIDOR: a tela não recalcula
 * nada (nada de duplicar a regra no frontend). Os parâmetros chegam por query
 * string e são validados aqui — valor inválido é 400, não é ignorado em
 * silêncio (filtro que "não filtra" produz relatório errado sem avisar).
 */
export type FiltrosPainelCrm = {
  de: string | null;
  ate: string | null;
  funilId: number | null;
  origem: string | null;
  origemId: number | null;
  etapa: string | null;
  etapaId: number | null;
  status: string | null;
  responsavelId: number | null;
};

const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

function inteiroOpcional(valor: unknown, campo: string): number | null {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `O filtro "${campo}" precisa ser um id inteiro positivo.`);
  return n;
}

export function filtrosDoPainel(req: Request): FiltrosPainelCrm {
  const q = req.query as Record<string, unknown>;
  const texto = (v: unknown): string | null => {
    if (v === undefined || v === null) return null;
    const t = String(v).trim();
    return t === '' ? null : t;
  };
  const de = texto(q.de);
  const ate = texto(q.ate);
  if (de !== null && !DATA_ISO.test(de)) throw new HttpError(400, 'A data inicial (`de`) precisa estar no formato AAAA-MM-DD.');
  if (ate !== null && !DATA_ISO.test(ate)) throw new HttpError(400, 'A data final (`ate`) precisa estar no formato AAAA-MM-DD.');
  if (de && ate && ate < de) throw new HttpError(400, 'A data final não pode ser anterior à inicial.');
  const status = texto(q.status);
  if (status !== null && !['aberta', 'ganha', 'perdida'].includes(status)) {
    throw new HttpError(400, 'O filtro "status" aceita apenas aberta, ganha ou perdida.');
  }
  return {
    de,
    ate,
    funilId: inteiroOpcional(q.funil_id, 'funil_id'),
    origem: texto(q.origem),
    origemId: inteiroOpcional(q.origem_id, 'origem_id'),
    etapa: texto(q.etapa),
    etapaId: inteiroOpcional(q.etapa_id, 'etapa_id'),
    status,
    responsavelId: inteiroOpcional(q.responsavel_id, 'responsavel_id'),
  };
}

/** `data` dentro da janela [de, ate] (comparação por dia, inclusiva). */
function dentroDaJanela(valor: unknown, de: string | null, ate: string | null): boolean {
  if (!de && !ate) return true;
  const dia = diaISO(valor);
  if (!dia) return false;
  if (de && dia < de) return false;
  if (ate && dia > ate) return false;
  return true;
}

export async function painelCrm(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_LEAD(), actor, 'read');
  checkAccess(R_OPORTUNIDADE(), actor, 'read');
  const escopo = escopoDoAtor(actor);
  const s = getStore();
  const filtros = filtrosDoPainel(req);
  const [todosLeads, todasOportunidades, todasAtividades, etapas, origens, campanhas, usuarios, motivosPerda] = await Promise.all([
    listarTudo(s, 'crm_leads', escopo.empresaId),
    listarTudo(s, 'crm_oportunidades', escopo.empresaId),
    listarTudo(s, 'crm_atividades', escopo.empresaId),
    listarTudo(s, 'crm_etapas', escopo.empresaId),
    listarTudo(s, 'crm_origens', escopo.empresaId),
    listarTudo(s, 'crm_campanhas', escopo.empresaId),
    listarTudo(s, 'usuarios', escopo.empresaId),
    listarTudo(s, 'crm_motivos_perda', escopo.empresaId),
  ]);

  // ---------------------------------------------------------------------------
  // APLICAÇÃO DOS FILTROS (documentada na resposta, em `filtros.aplicacao`)
  //
  //   período  → LEADS por `criado_em` (captação) e OPORTUNIDADES por
  //              `data_fechamento` quando encerrada, senão `criado_em`
  //              (entrada no pipeline). Um único recorte temporal para os dois
  //              lados: comparar janelas diferentes é o jeito mais fácil de
  //              produzir uma taxa de conversão que não existe.
  //   funil    → oportunidades do funil (e, quando informado, o pipeline é
  //              desenhado só com as etapas desse funil).
  //   origem   → leads por origem controlada (`origem_id`) ou texto (`origem`);
  //              a oportunidade herda a origem do lead de origem.
  //   etapa    → oportunidades naquela etapa (chave ou id).
  //   status   → aberta / ganha / perdida.
  //   resp.    → `responsavel_id` em leads E oportunidades.
  // ---------------------------------------------------------------------------
  const etapaIdPorChave = new Map(etapas.map((e) => [String(e.chave), Number(e.id)]));
  const chavePorEtapaId = new Map(etapas.map((e) => [Number(e.id), String(e.chave)]));

  const leads = todosLeads.filter((l) => {
    if (!dentroDaJanela(l.criado_em, filtros.de, filtros.ate)) return false;
    if (filtros.origemId !== null && num(l.origem_id) !== filtros.origemId) return false;
    if (filtros.origem !== null) {
      const alvo = filtros.origem.toLowerCase();
      const textoOrigem = String(l.origem ?? '').toLowerCase();
      const nomeOrigem = (() => {
        const id = num(l.origem_id);
        if (id === null) return '';
        const o = origens.find((x) => Number(x.id) === id);
        return String(o?.nome ?? '').toLowerCase();
      })();
      if (textoOrigem !== alvo && nomeOrigem !== alvo) return false;
    }
    if (filtros.responsavelId !== null && num(l.responsavel_id) !== filtros.responsavelId) return false;
    return true;
  });
  const idsLeads = new Set(leads.map((l) => Number(l.id)));

  const oportunidades = todasOportunidades.filter((o) => {
    const encerrada = String(o.status) !== 'aberta';
    const referencia = encerrada && o.data_fechamento ? o.data_fechamento : o.criado_em;
    if (!dentroDaJanela(referencia, filtros.de, filtros.ate)) return false;
    if (filtros.funilId !== null && num(o.funil_id) !== filtros.funilId) return false;
    if (filtros.status !== null && String(o.status ?? 'aberta') !== filtros.status) return false;
    if (filtros.responsavelId !== null && num(o.responsavel_id) !== filtros.responsavelId) return false;
    if (filtros.etapaId !== null) {
      if (num(o.etapa_id) !== filtros.etapaId) return false;
    } else if (filtros.etapa !== null) {
      const alvo = filtros.etapa.toLowerCase();
      const chave = String(o.etapa ?? '').toLowerCase();
      const id = num(o.etapa_id);
      const chaveDoId = id === null ? '' : String(chavePorEtapaId.get(id) ?? '').toLowerCase();
      if (chave !== alvo && chaveDoId !== alvo) return false;
    }
    // Filtro de origem: a oportunidade vale se o lead de origem passou no
    // recorte de leads — ou se ela própria tem origem declarada via lead.
    if (filtros.origem !== null || filtros.origemId !== null) {
      const leadId = num(o.lead_id);
      if (leadId === null) return false;
      if (!idsLeads.has(leadId)) return false;
    }
    return true;
  });

  const atividades = todasAtividades.filter((a) => {
    if (filtros.responsavelId !== null && num(a.responsavel_id) !== filtros.responsavelId) return false;
    const leadId = num(a.lead_id);
    const oppId = num(a.oportunidade_id);
    if ((filtros.origem !== null || filtros.origemId !== null) && leadId !== null && !idsLeads.has(leadId)) return false;
    if (filtros.funilId !== null && oppId !== null) {
      const opp = todasOportunidades.find((o) => Number(o.id) === oppId);
      if (opp && num(opp.funil_id) !== filtros.funilId) return false;
    }
    return true;
  });

  const filtrosAplicados = {
    de: filtros.de,
    ate: filtros.ate,
    funil_id: filtros.funilId,
    origem: filtros.origem,
    origem_id: filtros.origemId,
    etapa: filtros.etapa,
    etapa_id: filtros.etapaId,
    status: filtros.status,
    responsavel_id: filtros.responsavelId,
    aplicacao: {
      periodo:
        'leads por criado_em (captação); oportunidades por data_fechamento quando encerradas, senão por criado_em — o MESMO recorte nos dois lados',
      universo: {
        leads_na_empresa: todosLeads.length,
        leads_no_filtro: leads.length,
        oportunidades_na_empresa: todasOportunidades.length,
        oportunidades_no_filtro: oportunidades.length,
        atividades_na_empresa: todasAtividades.length,
        atividades_no_filtro: atividades.length,
      },
    },
  };

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
  const funil = chavesDoFunil(etapas, oportunidades).map((etapa, indice) => {
    const cadastro = etapas.find((e) => String(e.chave) === etapa);
    const lista = abertas.filter((o) => String(o.etapa) === etapa);
    return {
      etapa,
      etapa_id: cadastro ? Number(cadastro.id) : null,
      nome: String(cadastro?.nome ?? etapa),
      ordem: num(cadastro?.ordem) ?? indice + 1,
      probabilidade: probPorEtapa.get(etapa) ?? PROBABILIDADE_PADRAO[etapa] ?? 0,
      origem: cadastro ? 'cadastro' : 'compatibilidade',
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

  // PERDAS POR MOTIVO — perda sem motivo declarado aparece como "não
  // informado" em vez de desaparecer da contagem (escondê-la faria o total de
  // perdas do painel não fechar com a lista de oportunidades).
  const motivos = new Map<string, { motivo_id: number | null; motivo: string; perdas: number; valor_perdido: number }>();
  for (const o of perdidas) {
    const id = num(o.motivo_perda_id);
    const cadastro = id === null ? null : motivosPerda.find((m) => Number(m.id) === id);
    const chave = cadastro ? `id:${id}` : 'sem_motivo';
    const atual = motivos.get(chave) ?? {
      motivo_id: id,
      motivo: cadastro ? String(cadastro.nome ?? `#${id}`) : 'não informado',
      perdas: 0,
      valor_perdido: 0,
    };
    atual.perdas += 1;
    atual.valor_perdido += valorDe(o);
    motivos.set(chave, atual);
  }
  const perdasPorMotivo = [...motivos.values()]
    .map((m) => ({ ...m, valor_perdido: round2(m.valor_perdido) }))
    .sort((a, b) => b.perdas - a.perdas || a.motivo.localeCompare(b.motivo));

  res.json({
    gerado_em: new Date().toISOString(),
    /** Recorte aplicado — a tela mostra, não recalcula. */
    filtros: filtrosAplicados,
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
    /** Motivos de perda — inclui "não informado" para o total fechar. */
    perdas: {
      total: perdidas.length,
      valor_perdido: round2(perdidas.reduce((t, o) => t + valorDe(o), 0)),
      por_motivo: perdasPorMotivo,
    },
    conversao_por_origem: porOrigem,
    conversao_por_etapa: funil.map((f) => ({
      etapa: f.etapa,
      etapa_id: f.etapa_id,
      nome: f.nome,
      ordem: f.ordem,
      // Avanços REGISTRADOS no histórico (transições que ENTRARAM na etapa).
      avancos: f.avancos_registrados,
      oportunidades_abertas: f.oportunidades,
      valor_aberto: f.valor,
    })),
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

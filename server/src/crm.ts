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
import type { Row, Tx } from './store';

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

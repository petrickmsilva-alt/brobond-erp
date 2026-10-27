// ============================================================================
// FINANCEIRO 3.0 — BALANCETE E PENDÊNCIAS DE CLASSIFICAÇÃO (migration 0056)
//
// O BROBOND NÃO TEM CONTABILIDADE — e este módulo não a inventa.
// O que ele entrega é a ESTRUTURA já preparada, lida de volta:
//   • plano de contas (cadastro da empresa) com débito/crédito por conta;
//   • documento de origem e competência de cada lançamento;
//   • e a lista honesta do que está SEM classificação.
//
// REGRAS
//   • o fato gerador continua sendo `lancamentos_financeiros` — não existe
//     segundo livro, segunda tabela de lançamento nem partida dobrada gerada
//     por código;
//   • nenhum valor é recalculado: o balancete SOMA o que já está lançado;
//   • lançamento sem conta contábil NÃO é jogado em conta "diversos" inventada:
//     ele aparece em `sem_classificacao`, que é o que o contador precisa ver;
//   • competência ausente usa a data do lançamento (regime de caixa como
//     fallback explícito, nunca silencioso).
// ============================================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, escopoDe, getStore } from './services';
import { currentUser } from './auth';
import { round2 } from './utils';
import type { Row } from './store';

const R_LANCAMENTO = () => getResource('lancamentos_financeiros')!;
const R_PLANO = () => getResource('plano_contas')!;

const competenciaDe = (l: Row): string =>
  String(l.competencia ?? l.data ?? '').slice(0, 7);

/**
 * GET /api/financeiro/balancete?de=AAAA-MM&ate=AAAA-MM
 *
 * Devolve, por conta contábil: débitos, créditos e saldo. E, separadamente, o
 * que não tem classificação — para que a soma do balancete NUNCA pareça fechar
 * escondendo lançamento sem conta.
 */
export async function balanceteFinanceiro(req: Request, res: Response) {
  const r = R_LANCAMENTO();
  const actor = currentUser(req);
  checkAccess(r, actor, 'read');
  const escopo = escopoDe(actor);
  const s = getStore();

  const hoje = new Date().toISOString().slice(0, 7);
  const de = typeof req.query.de === 'string' && /^\d{4}-\d{2}$/.test(req.query.de) ? req.query.de : hoje;
  const ate = typeof req.query.ate === 'string' && /^\d{4}-\d{2}$/.test(req.query.ate) ? req.query.ate : de;
  if (ate < de) throw new HttpError(400, 'A competência final não pode ser anterior à inicial.');

  const lancamentos = (await s.list(r, { page: 1, pageSize: 20000, filter: { empresa_id: escopo.empresaId } })).rows.filter((l) => {
    const comp = competenciaDe(l);
    return comp >= de && comp <= ate;
  });
  const plano = new Map<number, Row>(
    (await s.list(R_PLANO(), { page: 1, pageSize: 2000, filter: { empresa_id: escopo.empresaId } })).rows.map((p) => [Number(p.id), p])
  );

  type Conta = {
    conta_contabil_id: number;
    codigo: string;
    nome: string;
    natureza: string;
    debitos: number;
    creditos: number;
    saldo: number;
    lancamentos: number;
  };
  const porConta = new Map<number, Conta>();
  const semClassificacao: { lancamento_id: number; data: string; descricao: string; tipo: string; valor: number; motivo: string }[] = [];
  let totalDebitos = 0;
  let totalCreditos = 0;

  for (const l of lancamentos) {
    const valor = Number(l.valor_liquido ?? l.valor ?? 0);
    const contaId = l.conta_contabil_id ? Number(l.conta_contabil_id) : null;
    const natureza = l.natureza_lancamento ? String(l.natureza_lancamento) : null;
    if (!contaId || !natureza) {
      semClassificacao.push({
        lancamento_id: Number(l.id),
        data: String(l.data ?? ''),
        descricao: String(l.descricao ?? ''),
        tipo: String(l.tipo ?? ''),
        valor,
        motivo: !contaId ? 'Sem conta contábil' : 'Sem natureza (débito/crédito)',
      });
      continue;
    }
    const conta = plano.get(contaId);
    const atual = porConta.get(contaId) ?? {
      conta_contabil_id: contaId,
      codigo: String(conta?.codigo ?? ''),
      nome: String(conta?.nome ?? `Conta #${contaId}`),
      natureza: String(conta?.natureza ?? ''),
      debitos: 0,
      creditos: 0,
      saldo: 0,
      lancamentos: 0,
    };
    if (natureza === 'debito') {
      atual.debitos = round2(atual.debitos + valor);
      totalDebitos = round2(totalDebitos + valor);
    } else {
      atual.creditos = round2(atual.creditos + valor);
      totalCreditos = round2(totalCreditos + valor);
    }
    atual.lancamentos += 1;
    atual.saldo = round2(atual.debitos - atual.creditos);
    porConta.set(contaId, atual);
  }

  const contas = [...porConta.values()].sort((a, b) => a.codigo.localeCompare(b.codigo));

  // Origem dos lançamentos classificados — o elo com o documento que gerou o fato.
  const porOrigem = new Map<string, { recurso: string; registros: number; valor: number }>();
  for (const l of lancamentos) {
    const recurso = l.documento_origem_recurso ? String(l.documento_origem_recurso) : '(manual)';
    const atual = porOrigem.get(recurso) ?? { recurso, registros: 0, valor: 0 };
    atual.registros += 1;
    atual.valor = round2(atual.valor + Number(l.valor_liquido ?? l.valor ?? 0));
    porOrigem.set(recurso, atual);
  }

  return res.json({
    de,
    ate,
    regra:
      'O balancete SOMA o livro-caixa existente. O ERP não gera partida dobrada nem rateia conta por conta própria: lançamento sem classificação aparece em “sem_classificacao”.',
    resumo: {
      lancamentos_no_periodo: lancamentos.length,
      classificados: lancamentos.length - semClassificacao.length,
      sem_classificacao: semClassificacao.length,
      total_debitos: totalDebitos,
      total_creditos: totalCreditos,
      diferenca: round2(totalDebitos - totalCreditos),
      contas_com_movimento: contas.length,
      plano_de_contas: plano.size,
    },
    contas,
    sem_classificacao: semClassificacao.slice(0, 100),
    por_origem: [...porOrigem.values()].sort((a, b) => b.valor - a.valor),
  });
}

/**
 * GET /api/financeiro/plano-contas/resumo
 * Usa do plano o que ele é: hierarquia + natureza. Não sugere mapeamento.
 */
export async function resumoPlanoContas(req: Request, res: Response) {
  const r = R_PLANO();
  const actor = currentUser(req);
  checkAccess(r, actor, 'read');
  const s = getStore();
  const escopo = escopoDe(actor);
  const contas = (await s.list(r, { page: 1, pageSize: 2000, filter: { empresa_id: escopo.empresaId }, sort: 'codigo', dir: 'asc' })).rows;
  const porNatureza = new Map<string, number>();
  for (const c of contas) {
    const n = String(c.natureza ?? 'outro');
    porNatureza.set(n, (porNatureza.get(n) ?? 0) + 1);
  }
  return res.json({
    total: contas.length,
    analiticas: contas.filter((c) => String(c.tipo) === 'analitica').length,
    sinteticas: contas.filter((c) => String(c.tipo) === 'sintetica').length,
    por_natureza: Object.fromEntries(porNatureza),
    aviso:
      contas.length === 0
        ? 'Nenhuma conta contábil cadastrada: os lançamentos ficam sem classificação até o plano de contas da empresa ser importado/cadastrado.'
        : null,
    contas: contas.map((c) => ({ id: Number(c.id), codigo: c.codigo, nome: c.nome, natureza: c.natureza, tipo: c.tipo, pai_id: c.pai_id ?? null, ativo: !!c.ativo })),
  });
}

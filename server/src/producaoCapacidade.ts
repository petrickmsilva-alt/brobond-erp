// ============================================================================
// PRODUÇÃO 3.0 — CAPACIDADE, CARGA E MRP (migration 0054)
//
// DUAS PERGUNTAS QUE O ERP NÃO SABIA RESPONDER
//   1) "Quanto cabe?" — capacidade do recurso (peças/dia informadas pela
//      engenharia) × dias úteis do período × eficiência, contra a carga real
//      (o que ainda falta produzir nas OPs alocadas ao recurso). Daí sai a
//      OCUPAÇÃO e o GARGALO da semana.
//   2) "O que comprar?" — MRP de verdade: demanda (vendas em aberto + OPs
//      abertas) contra oferta (estoque físico + compras em aberto), explodida
//      pela ficha técnica COM perda. O resultado é uma NECESSIDADE informada.
//
// REGRAS INVIOLÁVEIS
//   • NENHUM pedido de compra é criado aqui. MRP sugere; comprar é decisão
//     humana (POST explícito). Sem "auto-PO".
//   • Nada é gravado: capacidade é cadastro, carga é soma de OPs, MRP é leitura.
//   • OP sem recurso não é descartada: entra como "sem recurso" — esconder
//     isso faria o gargalo parecer menor do que é.
//   • Produto sem ficha técnica não é inventado: aparece em `sem_ficha`, porque
//     sem BOM não existe explosão de insumos honesta.
// ============================================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, escopoDe, getStore } from './services';
import { currentUser } from './auth';
import { diaISO, round2, round3 } from './utils';
import {
  fichaDoProduto,
  itensProducao,
  necessidadeDaFicha,
  segundaDaSemana,
} from './producao';
import type { EscopoEmpresa } from './empresa';
import type { Row } from './store';

const R_ORDEM = () => getResource('ordens')!;
const R_RECURSO = () => getResource('producao_recursos')!;
const R_PRODUTO = () => getResource('produtos')!;
const R_ESTOQUE = () => getResource('estoques')!;
const R_RESERVA = () => getResource('estoque_reservas')!;
const R_VENDA = () => getResource('vendas')!;
const R_ITEM_VENDA = () => getResource('itens_venda')!;
const R_COMPRA = () => getResource('compras')!;
const R_ITEM_COMPRA = () => getResource('itens_compra')!;

/** Status de OP que ainda exigem produção (carga viva). */
const OP_ABERTAS = ['planejada', 'liberada', 'em_producao', 'parcial'];
/** Status de venda que representam demanda ainda não atendida. */
const VENDA_EM_ABERTO = ['cotacao', 'aberta'];
/** Status de compra que representam oferta futura de insumo. */
const COMPRA_EM_ABERTO = ['pendente', 'aprovado', 'parcial'];

const diasEntre = (de: string, ate: string): string[] => {
  const out: string[] = [];
  const d = new Date(`${de}T12:00:00Z`);
  const fim = new Date(`${ate}T12:00:00Z`);
  while (d.getTime() <= fim.getTime()) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
};

/** Dias úteis (seg–sex) do intervalo — a capacidade é diária, não corrida. */
const diasUteis = (de: string, ate: string): number =>
  diasEntre(de, ate).filter((d) => {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    return dow !== 0 && dow !== 6;
  }).length;

const periodoPadrao = (req: Request): { de: string; ate: string } => {
  const hoje = diaISO(new Date().toISOString()) || new Date().toISOString().slice(0, 10);
  const de = typeof req.query.de === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.de) ? req.query.de : segundaDaSemana(hoje);
  const ate = typeof req.query.ate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.ate)
    ? req.query.ate
    : (() => {
        const d = new Date(`${de}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 55);
        return d.toISOString().slice(0, 10);
      })();
  if (ate < de) throw new HttpError(400, 'A data final não pode ser anterior à inicial.');
  return { de, ate };
};

/**
 * Falta produzir de uma OP: planejado (itens por tamanho) − já produzido, menos
 * perdas. Nunca negativo — peça perdida não "volta" para a carga.
 */
async function faltamDaOrdem(op: Row, escopo: EscopoEmpresa): Promise<number> {
  const itens = await itensProducao(op, escopo);
  const planejadas = itens.reduce((a, i) => a + i.quantidade, 0);
  const produzidas = Number(op.quantidade_produzida || 0);
  return Math.max(0, planejadas - produzidas);
}

// ----------------------------------------------------------------------------
// GET /api/producao/capacidade
// ----------------------------------------------------------------------------
export async function capacidadeProducao(req: Request, res: Response) {
  const r = R_ORDEM();
  const actor = currentUser(req);
  checkAccess(r, actor, 'read');
  const escopo = escopoDe(actor);
  const s = getStore();
  const { de, ate } = periodoPadrao(req);

  const uteis = diasUteis(de, ate);
  const recursos = (await s.list(R_RECURSO(), { page: 1, pageSize: 500, filter: { empresa_id: escopo.empresaId, ativo: true }, sort: 'nome', dir: 'asc' })).rows;
  const ordens = (await s.list(R_ORDEM(), { page: 1, pageSize: 5000, filter: { empresa_id: escopo.empresaId }, sort: 'id', dir: 'desc' })).rows.filter((o) =>
    OP_ABERTAS.includes(String(o.status))
  );

  type Linha = {
    recurso_id: number;
    nome: string;
    tipo: string;
    capacidade_diaria: number;
    eficiencia_pct: number;
    capacidade_periodo: number;
    carga: number;
    ocupacao_pct: number;
    ops: number;
    gargalo: boolean;
  };

  const porRecurso = new Map<number, Linha>();
  for (const rec of recursos) {
    const capacidadeDiaria = Number(rec.capacidade_diaria || 0);
    const eficiencia = Number(rec.eficiencia_pct ?? 100);
    porRecurso.set(Number(rec.id), {
      recurso_id: Number(rec.id),
      nome: String(rec.nome),
      tipo: String(rec.tipo ?? 'outro'),
      capacidade_diaria: capacidadeDiaria,
      eficiencia_pct: eficiencia,
      capacidade_periodo: Math.round(capacidadeDiaria * uteis * (eficiencia / 100)),
      carga: 0,
      ocupacao_pct: 0,
      ops: 0,
      gargalo: false,
    });
  }

  const semRecurso: { ordem_id: number; produto: string | null; faltam: number; previsao: string | null }[] = [];
  const foraDoPeriodo: number[] = [];

  for (const op of ordens) {
    const dia = diaISO(op.previsao || op.criado_em) || de;
    const dentro = dia >= de && dia <= ate;
    const faltam = await faltamDaOrdem(op, escopo);
    if (faltam <= 0) continue;
    const recursoId = op.recurso_id ? Number(op.recurso_id) : null;
    if (!recursoId) {
      if (dentro) {
        semRecurso.push({
          ordem_id: Number(op.id),
          produto: op.produto_id__label ? String(op.produto_id__label) : null,
          faltam,
          previsao: op.previsao ? diaISO(op.previsao) : null,
        });
      }
      continue;
    }
    if (!dentro) {
      foraDoPeriodo.push(Number(op.id));
      continue;
    }
    const linha = porRecurso.get(recursoId);
    if (!linha) {
      // OP apontando para recurso inativo: não some da conta, vira "sem recurso".
      semRecurso.push({ ordem_id: Number(op.id), produto: null, faltam, previsao: op.previsao ? diaISO(op.previsao) : null });
      continue;
    }
    linha.carga += faltam;
    linha.ops += 1;
  }

  const linhas = [...porRecurso.values()].map((l) => ({
    ...l,
    ocupacao_pct: l.capacidade_periodo > 0 ? round2((l.carga / l.capacidade_periodo) * 100) : l.carga > 0 ? 100 : 0,
  }));
  linhas.sort((a, b) => b.ocupacao_pct - a.ocupacao_pct || a.nome.localeCompare(b.nome));

  const gargalo = linhas.find((l) => l.carga > 0) ?? null;
  if (gargalo) gargalo.gargalo = true;

  const cargaTotal = linhas.reduce((a, l) => a + l.carga, 0);
  const capacidadeTotal = linhas.reduce((a, l) => a + l.capacidade_periodo, 0);

  return res.json({
    de,
    ate,
    dias_uteis: uteis,
    regra:
      'Capacidade = capacidade diária do recurso × dias úteis do período × eficiência. Carga = peças que ainda faltam produzir nas OPs alocadas ao recurso com previsão no período. Nada é gravado.',
    resumo: {
      recursos: linhas.length,
      capacidade_periodo: capacidadeTotal,
      carga: cargaTotal,
      ocupacao_pct: capacidadeTotal > 0 ? round2((cargaTotal / capacidadeTotal) * 100) : null,
      gargalo: gargalo ? { recurso_id: gargalo.recurso_id, nome: gargalo.nome, ocupacao_pct: gargalo.ocupacao_pct } : null,
      ordens_sem_recurso: semRecurso.length,
      pecas_sem_recurso: semRecurso.reduce((a, x) => a + x.faltam, 0),
      ordens_fora_do_periodo: foraDoPeriodo.length,
    },
    recursos: linhas,
    sem_recurso: semRecurso.sort((a, b) => b.faltam - a.faltam),
  });
}

// ----------------------------------------------------------------------------
// GET /api/producao/mrp
//
// CLASSIFICAÇÃO (honesta, para não vender o que não é):
//   **MRP 3.0 = MRP DE PLANEJAMENTO/NECESSIDADE.** Ele responde "quanto falta
//   comprar/produzir para atender a demanda conhecida", a partir de demanda,
//   estoque, OPs abertas, compras abertas e ficha técnica. NÃO é MRP industrial
//   completo — ver `escopo_do_calculo.nao_coberto` na resposta.
//
// FÓRMULA (tudo derivado, nada gravado):
//
//   demanda_produto   = itens de venda em aberto (cotacao/aberta)
//                       + falta de ESTOQUE MÍNIMO (só o que falta para chegar
//                         ao mínimo, nunca o mínimo inteiro)
//   oferta_produto    = disponível (físico − reservado − bloqueado − empenhado)
//                       + em produção (o que ainda FALTA produzir nas OPs abertas)
//   falta_produto     = max(0, demanda_produto − oferta_produto)
//
//   necessidade_insumo = consumo da ficha (com perda) × (falta das OPs abertas
//                        + falta_produto que exigiria OP nova)
//   oferta_insumo      = saldo do insumo + compras em aberto (pedido − recebido)
//   falta_insumo       = max(0, necessidade_insumo − oferta_insumo)
//
// REGRAS ANTI-DUPLA-CONTAGEM (cada quantidade entra UMA vez):
//   1) Estoque físico NÃO é somado ao "em produção": são ofertas distintas
//      (um já existe, o outro ainda será produzido) — e a reserva ativa é
//      DEDUZIDA do físico, porque já está comprometida com outro documento.
//   2) OP aberta entra pela quantidade que ainda FALTA produzir
//      (planejado − produzido), nunca pelo total; o que já foi produzido está
//      no estoque e seria contado duas vezes.
//   3) Compra aberta entra por (pedido − recebido): a parte recebida já virou
//      saldo de insumo (movimentação de entrada).
//   4) A falta de produto gera necessidade de insumo; a OP que já existe é
//      contada no seu próprio `faltam` — nunca nos dois lugares.
//   5) Estoque mínimo entra apenas como DEFICIT (mínimo − cobertura), nunca
//      como demanda cheia em cima da demanda de venda.
//   6) Cada venda/item entra uma única vez (o conjunto de ids de venda é
//      único e os itens são filtrados por ele).
//
// MRP NÃO CRIA PEDIDO DE COMPRA. A saída é necessidade + recomendação; a
// decisão continua humana (Compras › Sugestão de compra, com confirmação).
// ----------------------------------------------------------------------------
export async function mrpProducao(req: Request, res: Response) {
  const r = R_ORDEM();
  const actor = currentUser(req);
  checkAccess(r, actor, 'read');
  const escopo = escopoDe(actor);
  const s = getStore();

  // --- 1) Demanda de produtos: vendas em aberto --------------------------------
  const vendas = (await s.list(R_VENDA(), { page: 1, pageSize: 5000, filter: { empresa_id: escopo.empresaId } })).rows.filter((v) =>
    VENDA_EM_ABERTO.includes(String(v.status))
  );
  const vendaIds = new Set(vendas.map((v) => Number(v.id)));
  const itensVenda = (await s.list(R_ITEM_VENDA(), { page: 1, pageSize: 5000, filter: { empresa_id: escopo.empresaId } })).rows.filter((i) => vendaIds.has(Number(i.venda_id)));

  type Demanda = { produto_id: number; tamanho_id: number | null; quantidade: number; vendas: number };
  const demanda = new Map<string, Demanda>();
  const chave = (p: number, t: number | null) => `${p}#${t ?? 0}`;
  for (const it of itensVenda) {
    const pid = Number(it.produto_id);
    if (!pid) continue;
    const k = chave(pid, it.tamanho_id ? Number(it.tamanho_id) : null);
    const atual = demanda.get(k) ?? { produto_id: pid, tamanho_id: it.tamanho_id ? Number(it.tamanho_id) : null, quantidade: 0, vendas: 0 };
    atual.quantidade += Number(it.quantidade ?? 0);
    atual.vendas += 1;
    demanda.set(k, atual);
  }

  // --- 2) Oferta de produto: DISPONÍVEL (físico − comprometido) ---------------
  //
  // A oferta usa o DISPONÍVEL, não o físico bruto: quantidade reservada,
  // empenhada ou bloqueada já está comprometida com outro documento e não
  // pode cobrir esta demanda (senão a mesma peça cobriria duas necessidades).
  const estoques = (await s.list(R_ESTOQUE(), { page: 1, pageSize: 5000, filter: { empresa_id: escopo.empresaId } })).rows;
  const saldoFisico = new Map<string, number>();
  const minimos = new Map<number, number>();
  for (const e of estoques) {
    const k = chave(Number(e.produto_id), e.tamanho_id ? Number(e.tamanho_id) : null);
    saldoFisico.set(k, (saldoFisico.get(k) ?? 0) + Number(e.quantidade ?? 0));
    const pid = Number(e.produto_id);
    minimos.set(pid, (minimos.get(pid) ?? 0) + Number(e.estoque_min ?? 0));
  }

  // Comprometido = reservas ATIVAS (reserva + empenho + bloqueio).
  const reservasAtivas = (
    await s.list(R_RESERVA(), { page: 1, pageSize: 5000, filter: { empresa_id: escopo.empresaId, status: 'ativa' } })
  ).rows;
  const comprometido = new Map<string, { reservado: number; empenhado: number; bloqueado: number }>();
  for (const r of reservasAtivas) {
    const k = chave(Number(r.produto_id), r.tamanho_id ? Number(r.tamanho_id) : null);
    const atual = comprometido.get(k) ?? { reservado: 0, empenhado: 0, bloqueado: 0 };
    const qtd = Number(r.quantidade ?? 0);
    const tipo = String(r.tipo ?? 'reserva');
    if (tipo === 'bloqueio') atual.bloqueado += qtd;
    else if (tipo === 'empenho') atual.empenhado += qtd;
    else atual.reservado += qtd;
    comprometido.set(k, atual);
  }
  const saldo = new Map<string, number>();
  for (const [k, fisico] of saldoFisico) {
    const c = comprometido.get(k);
    const disponivel = c ? fisico - c.reservado - c.empenhado - c.bloqueado : fisico;
    saldo.set(k, round3(Math.max(0, disponivel)));
  }

  const ordens = (await s.list(R_ORDEM(), { page: 1, pageSize: 5000, filter: { empresa_id: escopo.empresaId } })).rows.filter((o) => OP_ABERTAS.includes(String(o.status)));
  const emProducao = new Map<string, number>();
  for (const op of ordens) {
    const faltam = await faltamDaOrdem(op, escopo);
    if (faltam <= 0) continue;
    const pid = Number(op.produto_id);
    if (op.tipo === 'grade') {
      const itens = await itensProducao(op, escopo);
      const total = itens.reduce((a, i) => a + i.quantidade, 0);
      const fator = total > 0 ? faltam / total : 0;
      for (const it of itens) {
        const k = chave(pid, it.tamanho_id ?? null);
        emProducao.set(k, (emProducao.get(k) ?? 0) + it.quantidade * fator);
      }
    } else {
      const k = chave(pid, op.tamanho_id ? Number(op.tamanho_id) : null);
      emProducao.set(k, (emProducao.get(k) ?? 0) + faltam);
    }
  }

  // --- 3) Falta de produto: demanda de venda + DÉFICIT de estoque mínimo -------
  //
  // O estoque mínimo entra só como o que FALTA para chegar nele (mínimo −
  // cobertura). Somar o mínimo inteiro em cima da demanda de venda contaria
  // duas vezes a mesma peça.
  const produtos = new Map<number, Row>(
    (await s.list(R_PRODUTO(), { page: 1, pageSize: 5000, filter: { empresa_id: escopo.empresaId } })).rows.map((p) => [Number(p.id), p])
  );

  const coberturaPorProduto = new Map<number, number>();
  for (const [k, qtd] of saldo) coberturaPorProduto.set(Number(k.split('#')[0]), round3((coberturaPorProduto.get(Number(k.split('#')[0])) ?? 0) + qtd));
  for (const [k, qtd] of emProducao) coberturaPorProduto.set(Number(k.split('#')[0]), round3((coberturaPorProduto.get(Number(k.split('#')[0])) ?? 0) + qtd));

  const deficitMinimo = new Map<number, number>();
  for (const [pid, minimo] of minimos) {
    if (!(minimo > 0)) continue;
    const deficit = round3(Math.max(0, minimo - (coberturaPorProduto.get(pid) ?? 0)));
    if (deficit > 0) deficitMinimo.set(pid, deficit);
  }

  const chaves = new Set<string>([...demanda.keys(), ...emProducao.keys()]);
  const faltasProduto: {
    produto_id: number;
    produto: string;
    tamanho_id: number | null;
    demanda_vendas: number;
    demanda_estoque_minimo: number;
    demanda: number;
    estoque_fisico: number;
    reservado: number;
    empenhado: number;
    bloqueado: number;
    estoque_disponivel: number;
    /** alias de `estoque_disponivel` (compatibilidade com o contrato anterior) */
    estoque: number;
    em_producao: number;
    falta: number;
  }[] = [];
  // Déficit de mínimo de produto SEM venda nem OP também é necessidade.
  for (const pid of deficitMinimo.keys()) {
    const temLinha = [...chaves].some((k) => Number(k.split('#')[0]) === pid);
    if (!temLinha) chaves.add(chave(pid, null));
  }

  for (const k of chaves) {
    const d = demanda.get(k);
    const pid = d?.produto_id ?? Number(k.split('#')[0]);
    const tid = d?.tamanho_id ?? (Number(k.split('#')[1]) || null);
    const demVendas = d?.quantidade ?? 0;
    // Déficit de mínimo é por PRODUTO: fica na linha sem tamanho para não
    // duplicar por grade.
    const demMinimo = tid === null ? deficitMinimo.get(pid) ?? 0 : 0;
    const dem = round3(demVendas + demMinimo);
    const fisico = saldoFisico.get(k) ?? 0;
    const c = comprometido.get(k) ?? { reservado: 0, empenhado: 0, bloqueado: 0 };
    const est = saldo.get(k) ?? 0;
    const prod = emProducao.get(k) ?? 0;
    const falta = Math.max(0, dem - est - prod);
    if (falta <= 0) continue;
    faltasProduto.push({
      produto_id: pid,
      produto: String(produtos.get(pid)?.nome ?? `Produto #${pid}`),
      tamanho_id: tid,
      demanda_vendas: round3(demVendas),
      demanda_estoque_minimo: round3(demMinimo),
      demanda: round3(dem),
      estoque_fisico: round3(fisico),
      reservado: round3(c.reservado),
      empenhado: round3(c.empenhado),
      bloqueado: round3(c.bloqueado),
      estoque_disponivel: round3(est),
      estoque: round3(est),
      em_producao: round3(prod),
      falta: round3(falta),
    });
  }
  faltasProduto.sort((a, b) => b.falta - a.falta);

  // --- 4) Necessidade de insumos = OPs abertas + faltas que exigiriam nova OP --
  const necessidade = new Map<number, { insumo_id: number; nome: string; unidade: string; necessaria: number; disponivel: number }>();
  const semFicha = new Set<number>();

  const acumular = async (produtoId: number, pecas: number) => {
    if (pecas <= 0) return;
    const ficha = await fichaDoProduto(produtoId, escopo);
    if (!ficha) {
      semFicha.add(produtoId);
      return;
    }
    const mapa = await necessidadeDaFicha(ficha, pecas, escopo);
    for (const [insumoId, linha] of mapa) {
      const atual = necessidade.get(insumoId) ?? {
        insumo_id: insumoId,
        nome: linha.nome,
        unidade: linha.unidade,
        necessaria: 0,
        disponivel: round3(await s.insumoStock(insumoId, undefined, escopo.empresaId)),
      };
      atual.necessaria = round3(atual.necessaria + linha.necessidade);
      necessidade.set(insumoId, atual);
    }
  };

  for (const op of ordens) {
    await acumular(Number(op.produto_id), await faltamDaOrdem(op, escopo));
  }
  for (const f of faltasProduto) {
    await acumular(f.produto_id, f.falta);
  }

  // --- 5) Oferta de insumos: compras em aberto --------------------------------
  const comprasAbertas = (await s.list(R_COMPRA(), { page: 1, pageSize: 5000, filter: { empresa_id: escopo.empresaId } })).rows.filter((c) =>
    COMPRA_EM_ABERTO.includes(String(c.status))
  );
  const comprasIds = new Set(comprasAbertas.map((c) => Number(c.id)));
  const itensCompra = (await s.list(R_ITEM_COMPRA(), { page: 1, pageSize: 10000, filter: { empresa_id: escopo.empresaId } })).rows.filter((i) =>
    comprasIds.has(Number(i.compra_id))
  );
  const aCaminho = new Map<number, number>();
  for (const it of itensCompra) {
    const insumoId = Number(it.insumo_id ?? 0);
    if (!insumoId) continue;
    const pedido = Number(it.quantidade ?? 0);
    const recebido = Number(it.quantidade_recebida ?? 0);
    aCaminho.set(insumoId, round3((aCaminho.get(insumoId) ?? 0) + Math.max(0, pedido - recebido)));
  }

  const insumos = [...necessidade.values()]
    .map((i) => {
      const emTransito = aCaminho.get(i.insumo_id) ?? 0;
      return {
        ...i,
        em_compra: emTransito,
        cobertura: round3(i.disponivel + emTransito),
        faltando: round3(Math.max(0, i.necessaria - i.disponivel - emTransito)),
      };
    })
    .sort((a, b) => b.faltando - a.faltando || a.nome.localeCompare(b.nome));

  return res.json({
    gerado_em: new Date().toISOString(),
    /**
     * CLASSIFICAÇÃO EXPLÍCITA — o que este cálculo é (e o que não é).
     *
     * O PR #92 chamou isto de "MRP"; a correção delimita: é MRP de
     * PLANEJAMENTO/NECESSIDADE. Declarar "MRP industrial completo" seria
     * mentira enquanto não houver lead time, lote, capacidade finita e datas
     * de necessidade.
     */
    calculo: {
      tipo: 'mrp_planejamento_necessidade',
      titulo: 'MRP de planejamento/necessidade',
      descricao:
        'Deriva necessidade de produto e de insumo a partir de demanda, disponibilidade, OPs abertas, compras abertas e ficha técnica. Não é MRP industrial completo.',
      cria_pedido_de_compra: false,
      coberto: [
        'demanda de vendas em aberto',
        'déficit de estoque mínimo',
        'disponibilidade (físico − reservado − empenhado − bloqueado)',
        'OPs abertas pela quantidade que ainda falta produzir',
        'compras abertas por (pedido − recebido)',
        'explosão por ficha técnica com perda',
        'produto sem ficha aparece em `sem_ficha`',
      ],
      nao_coberto: [
        'lead time de compra e de produção',
        'lote mínimo / múltiplo de compra / lote econômico',
        'calendário produtivo (feriados) e capacidade finita',
        'ordens planejadas e datas de necessidade por componente (pegging)',
        'consumo real por OP (backflush) e reserva de material por OP',
        'horizonte temporal com buckets (semana/mês)',
        'planejamento por componente com nível (BOM multinível)',
      ],
      horizonte: 'demanda conhecida hoje (sem datas de necessidade)',
    },
    regra:
      'MRP sugere, não compra: nenhum pedido é criado por esta rota. Demanda = vendas em aberto + déficit de estoque mínimo; oferta = disponível (físico − reservado − empenhado − bloqueado) + OPs abertas pelo que falta produzir; insumo = ficha com perda × (OPs abertas + falta de produto) contra saldo + compras em aberto (pedido − recebido).',
    resumo: {
      vendas_em_aberto: vendas.length,
      ordens_abertas: ordens.length,
      produtos_em_falta: faltasProduto.length,
      pecas_em_falta: round3(faltasProduto.reduce((a, f) => a + f.falta, 0)),
      insumos_em_falta: insumos.filter((i) => i.faltando > 0).length,
      produtos_sem_ficha: semFicha.size,
      // Transparência do comprometido: o que saiu do físico e por quê.
      reservas_ativas: reservasAtivas.length,
    },
    produtos: faltasProduto,
    insumos,
    sem_ficha: [...semFicha].map((id) => ({ produto_id: id, produto: String(produtos.get(id)?.nome ?? `Produto #${id}`) })),
    proxima_acao:
      'Para transformar a necessidade em pedido, use Compras › Sugestão de compra (a geração exige confirmação explícita do usuário).',
  });
}

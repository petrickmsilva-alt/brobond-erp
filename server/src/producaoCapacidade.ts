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
import { necessidadeNaUnidadeDeCompra } from './unidades';
import { calendarioDoPeriodo, type CalendarioPeriodo } from './calendario';
import { currentUser } from './auth';
import { diaISO, round2, round3 } from './utils';
import {
  consumoLiquidoDaOrdem,
  fichaDoProduto,
  itensProducao,
  listarTodos,
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

// Calendário produtivo (0062): seg–sex MENOS os feriados cadastrados pela
// empresa. Antes da 0062 a contagem era fixa em seg–sex, e isso inflava a
// capacidade em toda semana com feriado — o gargalo desaparecia no papel.
// A lista de feriados usada volta na resposta (`calendario`), então o número é
// auditável.

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

  const calendario = await calendarioDoPeriodo(escopo.empresaId, de, ate);
  const uteis = calendario.dias_uteis;
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
    // O calendário inteiro: quantos dias corridos, quantos fins de semana e
    // QUAIS feriados entraram no cálculo. Sem isso o número não é conferível.
    calendario,
    regra:
      'Capacidade = capacidade diária do recurso × dias úteis do período × eficiência. Dias úteis = seg–sex menos os feriados cadastrados pela empresa (feriado móvel precisa estar cadastrado; nada é derivado). Carga = peças que ainda faltam produzir nas OPs alocadas ao recurso com previsão no período. Nada é gravado.',
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
//   **MRP 3.0 = MRP DE PLANEJAMENTO/NECESSIDADE.** Responde "quanto falta
//   comprar/produzir para a demanda conhecida", a partir de demanda, estoque,
//   OPs abertas, compras abertas, BOM e consumo real. Continua NÃO sendo MRP
//   industrial fechado (sem lote econômico, sem calendário de feriados, sem
//   otimização de sequência) — ver `calculo.nao_coberto`.
//
// FÓRMULA (tudo derivado, nada gravado):
//
//   demanda_produto   = itens de venda em aberto (cotacao/aberta)
//                       + falta de ESTOQUE MÍNIMO (só o déficit)
//   oferta_produto    = disponível (físico − reservado − empenhado − bloqueado)
//                       + em produção (o que ainda FALTA produzir nas OPs abertas)
//   falta_produto     = max(0, demanda_produto − oferta_produto)
//
//   necessidade_de_producao(produto) = falta das OPs abertas + falta_produto
//
//   explosão BOM (multinível) sobre necessidade_de_producao:
//       nível 0  produto
//       nível 1+ componentes de `produto_composicao` (fator de quantidade)
//       folhas   insumos da ficha técnica (com perda)
//
//   necessidade_insumo = Σ explosão (bruta)
//   consumo_real       = Σ já baixado nas OPs (movimentações ligadas por ordem_id)
//   necessidade_liquida = max(0, necessidade_insumo − consumo_real)
//
//   oferta_insumo   = saldo do insumo + compras abertas (pedido − recebido)
//                     cuja data ESPERADA de recebimento cai no horizonte
//   falta_insumo    = max(0, necessidade_liquida − oferta_insumo)
//
// REGRAS ANTI-DUPLA-CONTAGEM (cada quantidade entra UMA vez):
//   1) Estoque físico NÃO é somado ao "em produção": são ofertas distintas.
//      A reserva ATIVA é deduzida do físico; reserva vencida/liberada/
//      consumida NÃO deduz (já não compromete nada).
//   2) OP aberta entra pela quantidade que ainda FALTA produzir
//      (planejado − produzido). Material JÁ CONSUMIDO pela OP também é
//      deduzido da necessidade (ver 7) — foi baixado do estoque de verdade.
//   3) Compra aberta entra por (pedido − recebido): a parte recebida já virou
//      saldo de insumo.
//   4) A falta de produto gera necessidade de produção; a OP que já existe é
//      contada no `faltam` dela — nunca nos dois lugares.
//   5) Estoque mínimo entra só como DÉFICIT (mínimo − cobertura).
//   6) Cada venda/item entra uma única vez (ids de venda únicos).
//   7) O consumo real da OP é o consumo LÍQUIDO (saídas − devoluções de
//      estorno). Sem isso, material já baixado seria pedido de novo.
//   8) Componente compartilhado (usado por dois produtos) soma quantidades;
//      ele NÃO é duplicado por caminho — soma é legítima, repetição não.
//   9) Ciclo de BOM não explode: o ramo é cortado e denunciado em `ciclos`.
//
// LEAD TIME E HORIZONTE (sem inventar parâmetro)
//   • lead time = `fornecedores.prazo_entrega_dias` do fornecedor da última
//     compra daquele insumo. Não existe coluna de lead time própria do insumo —
//     então não há valor inventado: sem dado, o campo volta `null`.
//   • horizonte = `?de`/`?ate` (ou `?horizonte_dias`, default 30). Compra com
//     data esperada FORA do horizonte não cobre a necessidade (fica visível
//     em `compras_fora_do_horizonte`).
//
// MRP NÃO CRIA PEDIDO DE COMPRA. A saída é necessidade + recomendação; a
// decisão continua humana (Compras › Sugestão de compra, com confirmação).
// ----------------------------------------------------------------------------

const R_COMPOSICAO = () => getResource('produto_composicao')!;
const R_FORNECEDOR = () => getResource('fornecedores')!;
const R_INSUMO = () => getResource('insumos')!;

/** Profundidade máxima da explosão: BOM de confecção raramente passa de 4. */
const BOM_PROFUNDIDADE_MAXIMA = 12;

type ExplosaoBom = {
  /** insumo_id → quantidade necessária (bruta, ainda sem consumo real). */
  insumos: Map<number, number>;
  /** componente (produto) → quantidade necessária acumulada. */
  componentes: Map<number, number>;
  /** produto → menor nível em que apareceu na BOM. */
  niveis: Map<number, number>;
  /** produtos sem ficha técnica e sem composição (não há como explodir). */
  sem_ficha: Set<number>;
  /** ciclos detectados (ramo cortado, nada é somado além do ponto). */
  ciclos: { produto_id: number; caminho: number[] }[];
  /** maior nível efetivamente alcançado. */
  profundidade: number;
};

/**
 * Explosão MULTINÍVEL da estrutura existente.
 *
 * Fontes, ambas do modelo atual (nenhuma tabela nova):
 *   • `produto_composicao` — produto → componente (produto), com fator de
 *     quantidade. É a estrutura multinível (kit/montagem/subconjunto).
 *   • `fichas_tecnicas` + `itens_ficha_tecnica` — produto → INSUMOS, com perda.
 *
 * As duas se somam sem dupla contagem porque falam de coisas diferentes:
 * componente é PRODUTO (que também será produzido), insumo é MATERIAL (que só
 * pode ser comprado). Um produto pode ter as duas coisas.
 *
 * Ciclo (`A → B → A`) não é explodido: o ramo é cortado e registrado. Sem esse
 * corte, uma autorreferência indireta viraria recursão infinita — e um BOM
 * circular é erro de cadastro, não demanda infinita.
 */
async function explodirBom(
  produtoRaiz: number,
  quantidade: number,
  escopo: EscopoEmpresa
): Promise<ExplosaoBom> {
  const s = getStore();
  const resultado: ExplosaoBom = {
    insumos: new Map(),
    componentes: new Map(),
    niveis: new Map(),
    sem_ficha: new Set(),
    ciclos: [],
    profundidade: 0,
  };
  if (!(quantidade > 0)) return resultado;

  const visitados = new Set<number>();

  const visitar = async (produtoId: number, qtd: number, nivel: number, caminho: number[]): Promise<void> => {
    if (nivel > BOM_PROFUNDIDADE_MAXIMA) return;
    if (caminho.includes(produtoId)) {
      // Ciclo: registra UMA vez e corta o ramo.
      if (!resultado.ciclos.some((c) => c.produto_id === produtoId)) {
        resultado.ciclos.push({ produto_id: produtoId, caminho: [...caminho, produtoId] });
      }
      return;
    }
    const atual = resultado.niveis.get(produtoId);
    if (atual === undefined || nivel < atual) resultado.niveis.set(produtoId, nivel);
    resultado.profundidade = Math.max(resultado.profundidade, nivel);

    // 1) INSUMOS da ficha técnica deste produto (com perda).
    const ficha = await fichaDoProduto(produtoId, escopo);
    let temFicha = false;
    if (ficha) {
      const linhas = await necessidadeDaFicha(ficha, qtd, escopo);
      for (const [insumoId, linha] of linhas) {
        resultado.insumos.set(insumoId, round3((resultado.insumos.get(insumoId) ?? 0) + linha.necessidade));
        temFicha = true;
      }
    }

    // 2) COMPONENTES (multinível) — fator de quantidade por linha.
    const composicao = await listarTodos(
      R_COMPOSICAO(),
      { empresa_id: escopo.empresaId, produto_id: produtoId },
      undefined,
      { pageSize: 500 }
    );
    let temComponente = false;
    for (const linha of composicao) {
      const componenteId = Number(linha.componente_id);
      const fator = Number(linha.quantidade ?? 0);
      if (!componenteId || !(fator > 0)) continue;
      temComponente = true;
      const qtdComponente = qtd * fator;
      resultado.componentes.set(componenteId, round3((resultado.componentes.get(componenteId) ?? 0) + qtdComponente));
      if (!caminho.includes(componenteId)) {
        await visitar(componenteId, qtdComponente, nivel + 1, [...caminho, produtoId]);
      } else if (!resultado.ciclos.some((c) => c.produto_id === componenteId)) {
        resultado.ciclos.push({ produto_id: componenteId, caminho: [...caminho, produtoId, componenteId] });
      }
    }

    // Produto que não tem nem ficha técnica nem composição não tem como ser
    // explodido — inclusive o de NÍVEL 0. Escondê-lo faria o plano parecer
    // completo quando falta a estrutura.
    if (!temFicha && !temComponente) resultado.sem_ficha.add(produtoId);
    visitados.add(produtoId);
  };

  await visitar(produtoRaiz, quantidade, 0, []);
  return resultado;
}

/** Soma uma explosão no acumulador global (sem duplicar por caminho). */
function acumularExplosao(
  destino: Map<number, number>,
  nova: Map<number, number>
): void {
  for (const [id, qtd] of nova) destino.set(id, round3((destino.get(id) ?? 0) + qtd));
}

export async function mrpProducao(req: Request, res: Response) {
  const r = R_ORDEM();
  const actor = currentUser(req);
  checkAccess(r, actor, 'read');
  const escopo = escopoDe(actor);
  const s = getStore();

  const hoje = diaISO(new Date().toISOString()) || new Date().toISOString().slice(0, 10);

  // --- 0) HORIZONTE DE PLANEJAMENTO (explícito) --------------------------------
  const horizonteDias = (() => {
    if (typeof req.query.horizonte_dias !== 'string') return 30;
    const n = Number(req.query.horizonte_dias);
    if (!Number.isInteger(n) || n <= 0 || n > 730) {
      throw new HttpError(400, '`horizonte_dias` deve ser um inteiro entre 1 e 730.');
    }
    return n;
  })();
  const de = typeof req.query.de === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.de) ? req.query.de : hoje;
  const ate = (() => {
    if (typeof req.query.ate === 'string') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query.ate)) throw new HttpError(400, '`ate` deve estar no formato AAAA-MM-DD.');
      return req.query.ate;
    }
    const d = new Date(`${de}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + horizonteDias);
    return d.toISOString().slice(0, 10);
  })();
  if (ate < de) throw new HttpError(400, 'A data final não pode ser anterior à inicial.');

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

  // --- 2) Oferta de produto: DISPONÍVEL (físico − comprometido) -----------------
  //
  // A oferta usa o DISPONÍVEL, não o físico bruto: quantidade reservada,
  // empenhada ou bloqueada já está comprometida com outro documento e não pode
  // cobrir esta demanda. Mas só conta o compromisso VIGENTE: reserva liberada,
  // consumida ou vencida não reduz disponibilidade (ela já não existe).
  const estoques = (await s.list(R_ESTOQUE(), { page: 1, pageSize: 5000, filter: { empresa_id: escopo.empresaId } })).rows;
  const saldoFisico = new Map<string, number>();
  const minimos = new Map<number, number>();
  for (const e of estoques) {
    const k = chave(Number(e.produto_id), e.tamanho_id ? Number(e.tamanho_id) : null);
    saldoFisico.set(k, (saldoFisico.get(k) ?? 0) + Number(e.quantidade ?? 0));
    const pid = Number(e.produto_id);
    minimos.set(pid, (minimos.get(pid) ?? 0) + Number(e.estoque_min ?? 0));
  }

  const reservas = (await s.list(R_RESERVA(), { page: 1, pageSize: 5000, filter: { empresa_id: escopo.empresaId } })).rows;
  const reservasAtivas = reservas.filter((r) => {
    if (String(r.status) !== 'ativa') return false;
    // Reserva 'ativa' com validade vencida não compromete: a data manda.
    const expira = diaISO(r.expira_em);
    return !(expira && expira < hoje);
  });
  const reservasExpiradas = reservas.filter((r) => {
    const expira = diaISO(r.expira_em);
    return String(r.status) === 'ativa' && !!expira && expira < hoje;
  }).length;

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

  // --- 3) ORDENS DE PRODUÇÃO: planejado × produzido × restante ------------------
  const ordens = (await s.list(R_ORDEM(), { page: 1, pageSize: 5000, filter: { empresa_id: escopo.empresaId } })).rows.filter((o) =>
    OP_ABERTAS.includes(String(o.status))
  );

  type OrdemInfo = {
    ordem_id: number;
    produto_id: number;
    planejado: number;
    produzido: number;
    restante: number;
    previsao: string | null;
    recurso_id: number | null;
    dentro_do_horizonte: boolean;
    consumo_liquido: Map<number, number>;
  };
  const infos: OrdemInfo[] = [];
  for (const op of ordens) {
    const itens = await itensProducao(op, escopo);
    const planejado = itens.reduce((a, i) => a + i.quantidade, 0);
    const produzido = Number(op.quantidade_produzida || 0);
    const restante = round3(Math.max(0, planejado - produzido));
    const previsao = op.previsao ? diaISO(op.previsao) : null;
    const consumo = await consumoLiquidoDaOrdem(Number(op.id), escopo);
    const consumoLiquido = new Map<number, number>();
    for (const [insumoId, c] of consumo) if (c.qtd > 0) consumoLiquido.set(insumoId, round3(c.qtd));
    // OP sem previsão conta como necessidade IMEDIATA (não desaparece do plano).
    const dentro = previsao === null || (previsao >= de && previsao <= ate);
    infos.push({
      ordem_id: Number(op.id),
      produto_id: Number(op.produto_id),
      planejado: round3(planejado),
      produzido: round3(produzido),
      restante,
      previsao,
      recurso_id: op.recurso_id ? Number(op.recurso_id) : null,
      dentro_do_horizonte: dentro,
      consumo_liquido: consumoLiquido,
    });
  }

  const emProducao = new Map<string, number>();
  for (const info of infos) {
    if (info.restante <= 0) continue;
    const op = ordens.find((o) => Number(o.id) === info.ordem_id)!;
    if (op.tipo === 'grade') {
      const itens = await itensProducao(op, escopo);
      const total = itens.reduce((a, i) => a + i.quantidade, 0);
      const fator = total > 0 ? info.restante / total : 0;
      for (const it of itens) {
        const k = chave(info.produto_id, it.tamanho_id ?? null);
        emProducao.set(k, (emProducao.get(k) ?? 0) + it.quantidade * fator);
      }
    } else {
      const k = chave(info.produto_id, op.tamanho_id ? Number(op.tamanho_id) : null);
      emProducao.set(k, (emProducao.get(k) ?? 0) + info.restante);
    }
  }

  // --- 4) Falta de produto: demanda de venda + DÉFICIT de estoque mínimo --------
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
    data_necessidade: string;
  }[] = [];
  for (const pid of deficitMinimo.keys()) {
    const temLinha = [...chaves].some((k) => Number(k.split('#')[0]) === pid);
    if (!temLinha) chaves.add(chave(pid, null));
  }

  for (const k of chaves) {
    const d = demanda.get(k);
    const pid = d?.produto_id ?? Number(k.split('#')[0]);
    const tid = d?.tamanho_id ?? (Number(k.split('#')[1]) || null);
    const demVendas = d?.quantidade ?? 0;
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
      // Falta de produto é necessidade de HOJE (não há data futura conhecida).
      data_necessidade: hoje,
    });
  }
  faltasProduto.sort((a, b) => b.falta - a.falta);

  // --- 5) NECESSIDADE DE PRODUÇÃO por produto (OP aberta + falta) ----------------
  //
  // É a quantidade que a BOM precisa explodir. A OP entra pelo que falta
  // produzir; a falta de produto entra como OP que ainda não existe.
  const necessidadeProducao = new Map<number, number>();
  for (const info of infos) {
    if (info.restante <= 0) continue;
    necessidadeProducao.set(info.produto_id, round3((necessidadeProducao.get(info.produto_id) ?? 0) + info.restante));
  }
  for (const f of faltasProduto) {
    necessidadeProducao.set(f.produto_id, round3((necessidadeProducao.get(f.produto_id) ?? 0) + f.falta));
  }

  // --- 6) EXPLOSÃO MULTINÍVEL da BOM -------------------------------------------
  const necessidadeInsumos = new Map<number, number>();
  const insumosPorOrdem = new Map<number, number>(); // consumo real acumulado por insumo
  const componentesNecessarios = new Map<number, number>();
  const niveisProduto = new Map<number, number>();
  const semFicha = new Set<number>();
  const ciclos: { produto_id: number; caminho: number[] }[] = [];
  let profundidadeMaxima = 0;

  for (const [produtoId, qtd] of necessidadeProducao) {
    const explo = await explodirBom(produtoId, qtd, escopo);
    acumularExplosao(necessidadeInsumos, explo.insumos);
    acumularExplosao(componentesNecessarios, explo.componentes);
    for (const [pid, nivel] of explo.niveis) {
      const atual = niveisProduto.get(pid);
      if (atual === undefined || nivel < atual) niveisProduto.set(pid, nivel);
    }
    for (const id of explo.sem_ficha) semFicha.add(id);
    for (const c of explo.ciclos) if (!ciclos.some((x) => x.produto_id === c.produto_id)) ciclos.push(c);
    profundidadeMaxima = Math.max(profundidadeMaxima, explo.profundidade);
  }
  // Consumo REAL: só o que pertence a OPs que estão neste plano.
  for (const info of infos) {
    if (info.restante <= 0) continue;
    for (const [insumoId, qtd] of info.consumo_liquido) {
      insumosPorOrdem.set(insumoId, round3((insumosPorOrdem.get(insumoId) ?? 0) + qtd));
    }
  }

  // --- 7) Oferta de insumos: compras abertas com data esperada ------------------
  const comprasAbertas = (await s.list(R_COMPRA(), { page: 1, pageSize: 5000, filter: { empresa_id: escopo.empresaId } })).rows.filter((c) =>
    COMPRA_EM_ABERTO.includes(String(c.status))
  );
  const comprasIds = new Set(comprasAbertas.map((c) => Number(c.id)));
  const itensCompra = (await s.list(R_ITEM_COMPRA(), { page: 1, pageSize: 10000, filter: { empresa_id: escopo.empresaId } })).rows.filter((i) =>
    comprasIds.has(Number(i.compra_id))
  );

  const fornecedores = new Map<number, Row>(
    (await s.list(R_FORNECEDOR(), { page: 1, pageSize: 2000, filter: { empresa_id: escopo.empresaId } })).rows.map((f) => [Number(f.id), f])
  );

  const aCaminho = new Map<number, number>();
  const aCaminhoForaDoHorizonte = new Map<number, number>();
  const leadTimePorInsumo = new Map<number, { dias: number; fornecedor: string }>();
  for (const it of itensCompra) {
    const insumoId = Number(it.insumo_id ?? 0);
    if (!insumoId) continue;
    const pedido = Number(it.quantidade ?? 0);
    const recebido = Number(it.quantidade_recebida ?? 0);
    const aberto = round3(Math.max(0, pedido - recebido));
    if (aberto <= 0) continue;
    const compra = comprasAbertas.find((c) => Number(c.id) === Number(it.compra_id));
    const fornecedor = compra && compra.fornecedor_id ? fornecedores.get(Number(compra.fornecedor_id)) : null;
    const leadTime = fornecedor && fornecedor.prazo_entrega_dias !== null && fornecedor.prazo_entrega_dias !== undefined
      ? Number(fornecedor.prazo_entrega_dias)
      : null;
    // Data esperada = data do pedido + prazo de entrega do fornecedor (quando
    // o cadastro tem esse dado). Sem prazo cadastrado, a data é a do pedido —
    // e a resposta diz que o lead time é desconhecido.
    const dataBase = diaISO(compra?.data) ?? hoje;
    const esperada = (() => {
      if (leadTime === null || !Number.isFinite(leadTime)) return dataBase;
      const d = new Date(`${dataBase}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + leadTime);
      return d.toISOString().slice(0, 10);
    })();
    if (leadTime !== null && !leadTimePorInsumo.has(insumoId)) {
      leadTimePorInsumo.set(insumoId, { dias: leadTime, fornecedor: String(fornecedor?.nome ?? `#${compra?.fornecedor_id}`) });
    }
    if (esperada <= ate) aCaminho.set(insumoId, round3((aCaminho.get(insumoId) ?? 0) + aberto));
    else aCaminhoForaDoHorizonte.set(insumoId, round3((aCaminhoForaDoHorizonte.get(insumoId) ?? 0) + aberto));
  }

  // Data de necessidade por insumo: a MENOR previsão das OPs que o consomem;
  // necessidade que vem de falta de produto é imediata.
  const dataNecessidade = new Map<number, string>();
  for (const info of infos) {
    if (info.restante <= 0) continue;
    const ficha = await fichaDoProduto(info.produto_id, escopo);
    if (!ficha) continue;
    const linhas = await necessidadeDaFicha(ficha, info.restante, escopo);
    const dia = info.previsao ?? hoje;
    for (const insumoId of linhas.keys()) {
      const atual = dataNecessidade.get(insumoId);
      if (atual === undefined || dia < atual) dataNecessidade.set(insumoId, dia);
    }
  }
  for (const f of faltasProduto) {
    const ficha = await fichaDoProduto(f.produto_id, escopo);
    if (!ficha) continue;
    const linhas = await necessidadeDaFicha(ficha, f.falta, escopo);
    for (const insumoId of linhas.keys()) {
      const atual = dataNecessidade.get(insumoId);
      if (atual === undefined || hoje < atual) dataNecessidade.set(insumoId, hoje);
    }
  }

  const insumos: {
    insumo_id: number;
    nome: string;
    unidade: string;
    necessaria: number;
    consumo_real: number;
    necessario_comprar: number;
    disponivel: number;
    em_compra: number;
    em_compra_fora_do_horizonte: number;
    lead_time_dias: number | null;
    lead_time_fornecedor: string | null;
    data_necessidade: string | null;
    data_esperada_recebimento: string | null;
    necessidade_imediata: number;
    necessidade_futura: number;
    cobertura: number;
    faltando: number;
    unidade_compra: string;
    fator_conversao: number | null;
    necessario_comprar_na_unidade_compra: number | null;
    conversao_ausente: boolean;
  }[] = [];

  const todosInsumos = new Set<number>([...necessidadeInsumos.keys(), ...insumosPorOrdem.keys()]);
  for (const insumoId of todosInsumos) {
    const insumo = await s.findOneWhere(R_INSUMO(), { id: insumoId, empresa_id: escopo.empresaId });
    if (!insumo) continue;
    const bruta = necessidadeInsumos.get(insumoId) ?? 0;
    const consumida = insumosPorOrdem.get(insumoId) ?? 0;
    // Material JÁ BAIXADO pela OP não é pedido de novo.
    const liquida = round3(Math.max(0, bruta - consumida));
    const disponivel = round3(await s.insumoStock(insumoId, undefined, escopo.empresaId));
    const emTransito = aCaminho.get(insumoId) ?? 0;
    const cobertura = round3(disponivel + emTransito);
    const dia = dataNecessidade.get(insumoId) ?? null;
    const lead = leadTimePorInsumo.get(insumoId) ?? null;
    const recebimentoEsperado = (() => {
      if (lead === null) return null;
      const d = new Date(`${hoje}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + lead.dias);
      return d.toISOString().slice(0, 10);
    })();
    const imediata = dia !== null && dia <= hoje ? liquida : 0;
    const futura = round3(Math.max(0, liquida - imediata));
    // UNIDADE DE COMPRA (P3-04/0060): compra-se em rolo, consome-se em metro. A
    // conversão vem SÓ de regra declarada; sem regra, `conversao_ausente` é true
    // e o MRP não inventa fator.
    const naCompra = await necessidadeNaUnidadeDeCompra(escopo.empresaId, insumo, liquida);
    insumos.push({
      insumo_id: insumoId,
      nome: labelDoInsumo(insumo),
      unidade: String(insumo.unidade || 'un'),
      necessaria: round3(bruta),
      consumo_real: round3(consumida),
      necessario_comprar: liquida,
      disponivel,
      em_compra: round3(emTransito),
      em_compra_fora_do_horizonte: round3(aCaminhoForaDoHorizonte.get(insumoId) ?? 0),
      lead_time_dias: lead ? lead.dias : null,
      lead_time_fornecedor: lead ? lead.fornecedor : null,
      data_necessidade: dia,
      data_esperada_recebimento: recebimentoEsperado,
      necessidade_imediata: round3(imediata),
      necessidade_futura: futura,
      cobertura,
      faltando: round3(Math.max(0, liquida - cobertura)),
      unidade_compra: naCompra ? naCompra.unidade_compra : String(insumo.unidade || 'un'),
      fator_conversao: naCompra ? Number(naCompra.conversao.fator.toFixed(6)) : null,
      necessario_comprar_na_unidade_compra: naCompra ? naCompra.quantidade : null,
      conversao_ausente:
        !naCompra && Boolean(String(insumo.unidade_compra ?? '').trim()) && String(insumo.unidade_compra).trim().toLowerCase() !== String(insumo.unidade ?? '').trim().toLowerCase(),
    });
  }
  insumos.sort((a, b) => b.faltando - a.faltando || a.nome.localeCompare(b.nome));

  // --- 8) CAPACIDADE: necessidade acima do que cabe produzir -------------------
  const recursos = (await s.list(R_RECURSO(), { page: 1, pageSize: 500, filter: { empresa_id: escopo.empresaId, ativo: true } })).rows;
  const calendarioHorizonte = await calendarioDoPeriodo(escopo.empresaId, de, ate);
  const diasUteisHorizonte = calendarioHorizonte.dias_uteis;
  const cargaPorRecurso = new Map<number, { carga: number; ordens: number }>();
  for (const info of infos) {
    if (info.restante <= 0 || info.recurso_id === null) continue;
    if (!info.dentro_do_horizonte) continue;
    const atual = cargaPorRecurso.get(info.recurso_id) ?? { carga: 0, ordens: 0 };
    atual.carga = round3(atual.carga + info.restante);
    atual.ordens += 1;
    cargaPorRecurso.set(info.recurso_id, atual);
  }
  const capacidade = recursos.map((rec) => {
    const diaria = Number(rec.capacidade_diaria || 0);
    const eficiencia = Number(rec.eficiencia_pct ?? 100);
    const periodo = Math.round(diaria * diasUteisHorizonte * (eficiencia / 100));
    const carga = cargaPorRecurso.get(Number(rec.id))?.carga ?? 0;
    return {
      recurso_id: Number(rec.id),
      nome: String(rec.nome),
      capacidade_periodo: periodo,
      carga,
      saldo: round2(periodo - carga),
      ocupacao_pct: periodo > 0 ? round2((carga / periodo) * 100) : carga > 0 ? 100 : 0,
      acima_da_capacidade: periodo > 0 ? carga > periodo : carga > 0,
      ordens: cargaPorRecurso.get(Number(rec.id))?.ordens ?? 0,
    };
  }).sort((a, b) => b.ocupacao_pct - a.ocupacao_pct);
  const ordensSemRecurso = infos.filter((i) => i.restante > 0 && i.recurso_id === null).length;
  const acimaDaCapacidade = capacidade.filter((c) => c.acima_da_capacidade);

  // --- 9) RESPOSTA --------------------------------------------------------------
  return res.json({
    gerado_em: new Date().toISOString(),
    calculo: {
      tipo: 'mrp_planejamento_necessidade',
      titulo: 'MRP de planejamento/necessidade',
      descricao:
        'Deriva necessidade de produto e de insumo a partir de demanda, disponibilidade, OPs abertas (planejado − produzido − consumido), compras abertas, BOM multinível e lead time cadastrado. Não é MRP industrial completo.',
      cria_pedido_de_compra: false,
      calendario: calendarioHorizonte,
      coberto: [
        'demanda de vendas em aberto',
        'déficit de estoque mínimo',
        'disponibilidade (físico − reservado − empenhado − bloqueado, só reserva vigente)',
        'OPs abertas pelo que falta produzir (planejado − produzido)',
        'consumo REAL de insumos por OP (consumo líquido: saídas − estornos)',
        'compras abertas por (pedido − recebido), com data esperada de recebimento',
        'explosão por ficha técnica com perda',
        'explosão multinível por composição de produto (níveis 0..N) com controle de ciclo',
        'lead time de compra (fornecedores.prazo_entrega_dias) e horizonte explícito',
        'data de necessidade por insumo e separação imediata × futura',
        'capacidade produtiva contra a carga do horizonte',
        'calendário produtivo: dias úteis = seg–sex menos os feriados cadastrados (feriado móvel precisa estar cadastrado — não é derivado)',
      ],
      nao_coberto: [
        'lote mínimo / múltiplo de compra / lote econômico',
        'sequenciamento e otimização de fila (APS)',
        'ordens planejadas sugeridas com pegging por documento',
        'reserva de material por OP (o MRP deduz consumo real, não reserva de insumo)',
      ],
      horizonte: { de, ate, dias: horizonteDias },
      bom_multinivel: {
        profundidade_maxima_alcancada: profundidadeMaxima,
        limite_de_profundidade: BOM_PROFUNDIDADE_MAXIMA,
        niveis_explodidos: [...niveisProduto.entries()]
          .sort((a, b) => a[1] - b[1] || a[0] - b[0])
          .map(([produtoId, nivel]) => ({ produto_id: produtoId, produto: String(produtos.get(produtoId)?.nome ?? `Produto #${produtoId}`), nivel })),
        componentes: [...componentesNecessarios.entries()].map(([produtoId, qtd]) => ({
          produto_id: produtoId,
          produto: String(produtos.get(produtoId)?.nome ?? `Produto #${produtoId}`),
          quantidade: round3(qtd),
          nivel: niveisProduto.get(produtoId) ?? null,
        })),
        ciclos,
      },
    },
    regra:
      'MRP sugere, não compra: nenhum pedido é criado por esta rota. Necessidade de produção = falta das OPs abertas (planejado − produzido) + falta de produto; necessidade de insumo = explosão multinível da BOM menos o que a OP JÁ consumiu; oferta = saldo + compras abertas dentro do horizonte.',
    filtros: { de, ate, horizonte_dias: horizonteDias },
    resumo: {
      vendas_em_aberto: vendas.length,
      ordens_abertas: ordens.length,
      ordens_no_horizonte: infos.filter((i) => i.dentro_do_horizonte && i.restante > 0).length,
      produtos_em_falta: faltasProduto.length,
      pecas_em_falta: round3(faltasProduto.reduce((a, f) => a + f.falta, 0)),
      insumos_em_falta: insumos.filter((i) => i.faltando > 0).length,
      produtos_sem_ficha: semFicha.size,
      ciclos_bom: ciclos.length,
      reservas_ativas: reservasAtivas.length,
      reservas_expiradas_ignoradas: reservasExpiradas,
      consumo_real_considerado: round3([...insumosPorOrdem.values()].reduce((a, b) => a + b, 0)),
      acima_da_capacidade: acimaDaCapacidade.length,
    },
    ordens: infos.map((i) => ({
      ordem_id: i.ordem_id,
      produto_id: i.produto_id,
      produto: String(produtos.get(i.produto_id)?.nome ?? `Produto #${i.produto_id}`),
      planejado: i.planejado,
      produzido: i.produzido,
      restante: i.restante,
      previsao: i.previsao,
      dentro_do_horizonte: i.dentro_do_horizonte,
      recurso_id: i.recurso_id,
      consumo_insumos: [...i.consumo_liquido.entries()].map(([insumoId, qtd]) => ({ insumo_id: insumoId, quantidade: round3(qtd) })),
    })),
    produtos: faltasProduto,
    insumos,
    capacidade: {
      dias_uteis: diasUteisHorizonte,
      recursos: capacidade,
      acima_da_capacidade: acimaDaCapacidade,
      ordens_sem_recurso: ordensSemRecurso,
    },
    sem_ficha: [...semFicha].map((id) => ({ produto_id: id, produto: String(produtos.get(id)?.nome ?? `Produto #${id}`) })),
    proxima_acao:
      'Para transformar a necessidade em pedido, use Compras › Sugestão de compra (a geração exige confirmação explícita do usuário).',
  });
}

/** Rótulo do insumo para a resposta (nome, com fallback pelo id). */
function labelDoInsumo(insumo: Row): string {
  const nome = insumo.nome === null || insumo.nome === undefined ? '' : String(insumo.nome).trim();
  return nome || `Insumo #${Number(insumo.id)}`;
}

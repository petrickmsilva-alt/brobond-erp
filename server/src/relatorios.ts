// ============================================================
// Fase 5 — Relatórios.
//
// Cada relatório é um endpoint GET /api/relatorios/<nome> que devolve
// { nome, resumo, colunas, linhas }. Com ?format=csv|xlsx o mesmo endpoint
// baixa o arquivo exportado (mesma estrutura do export de listas).
// ============================================================
import type { Request, Response } from 'express';
import { RESOURCES } from './resources';
import { checkAccess, getStore , storeDoAtor } from './services';
import { currentUser } from './auth';
import { enviarArquivo, type ColunaExport } from './export';
import type { Row } from './store';
import { labelOf } from './store';
import { HttpError } from './errors';
import { round2, somaMoeda } from './utils';

const FATURADAS = ['faturada', 'entregue'];

function periodo(req: Request): { de: string | null; ate: string | null } {
  const de = typeof req.query.de === 'string' && req.query.de ? String(req.query.de).slice(0, 10) : null;
  const ate = typeof req.query.ate === 'string' && req.query.ate ? String(req.query.ate).slice(0, 10) : null;
  return { de, ate };
}

async function responder(
  req: Request,
  res: Response,
  relatorio: { nome: string; titulo: string; colunas: ColunaExport[]; linhas: Row[]; resumo?: Row; grafico?: { rotulos: string[]; valores: number[]; formato?: 'money' | 'number' } }
) {
  const formato = typeof req.query.format === 'string' ? req.query.format : '';
  if (formato === 'csv' || formato === 'xlsx') {
    await enviarArquivo(res, relatorio.nome, formato, relatorio.colunas, relatorio.linhas, relatorio.titulo);
    return;
  }
  res.json({
    nome: relatorio.nome,
    titulo: relatorio.titulo,
    colunas: relatorio.colunas,
    linhas: relatorio.linhas,
    resumo: relatorio.resumo ?? null,
    grafico: relatorio.grafico ?? null,
  });
}

// ----------------------------------------------------------------------------
// 1) Posição de estoque valorizada (por produto/categoria/coleção/local)
// ----------------------------------------------------------------------------
async function relEstoquePosicao(req: Request, res: Response) {
  const s = storeDoAtor(currentUser(req));
  const grupo = String(req.query.grupo || 'produto');
  const { de: _de, ate: _ate } = periodo(req);
  void _de;
  void _ate;
  const local = typeof req.query.local === 'string' && req.query.local ? String(req.query.local) : null;

  const [produtos, estoques] = await Promise.all([
    s.list(RESOURCES.produtos, { page: 1, pageSize: 2000 }),
    s.list(RESOURCES.estoques, { page: 1, pageSize: 5000, filter: local ? { local } : {} }),
  ]);
  const porProduto = new Map<number, { produto: string; pecas: number; valor: number; sku: string }>();
  for (const e of estoques.rows) {
    const pid = Number(e.produto_id);
    const p = produtos.rows.find((x) => Number(x.id) === pid);
    const qtd = Number(e.quantidade || 0);
    const custo = Number(p?.custo || 0);
    const atual = porProduto.get(pid) || { produto: p ? labelOf(RESOURCES.produtos, p) : `#${pid}`, sku: p?.sku || '', pecas: 0, valor: 0 };
    atual.pecas += qtd;
    atual.valor += qtd * custo;
    porProduto.set(pid, atual);
  }

  if (grupo === 'local') {
    const porLocal = new Map<string, { local: string; pecas: number; valor: number }>();
    for (const e of estoques.rows) {
      const l = String(e.local || 'loja');
      const p = produtos.rows.find((x) => Number(x.id) === Number(e.produto_id));
      const atual = porLocal.get(l) || { local: l, pecas: 0, valor: 0 };
      atual.pecas += Number(e.quantidade || 0);
      atual.valor += Number(e.quantidade || 0) * Number(p?.custo || 0);
      porLocal.set(l, atual);
    }
    const linhas = [...porLocal.values()].sort((a, b) => b.valor - a.valor);
    return responder(req, res, {
      nome: 'estoque-posicao',
      titulo: 'Posição de estoque por local',
      colunas: [
        { key: 'local', label: 'Local' },
        { key: 'pecas', label: 'Peças', tipo: 'number' },
        { key: 'valor', label: 'Valor (custo)', tipo: 'money' },
      ],
      linhas,
      resumo: { pecas: linhas.reduce((a, l) => a + l.pecas, 0), valor: somaMoeda(linhas.map((l) => l.valor)) },
    });
  }
  if (grupo === 'categoria' || grupo === 'colecao') {
    const campo = grupo === 'categoria' ? 'categoria_id' : 'colecao_id';
    const refKey = grupo === 'categoria' ? 'categorias' : 'colecoes';
    const refs = await s.list(RESOURCES[refKey as 'categorias'], { page: 1, pageSize: 500 });
    const refNome = new Map(refs.rows.map((x) => [Number(x.id), labelOf(RESOURCES[refKey as 'categorias'], x)]));
    const porRef = new Map<string, { grupo: string; pecas: number; valor: number }>();
    for (const [pid, atual] of porProduto) {
      const p = produtos.rows.find((x) => Number(x.id) === pid);
      const nome = refNome.get(Number(p?.[campo])) || 'Sem classificação';
      const g = porRef.get(nome) || { grupo: nome, pecas: 0, valor: 0 };
      g.pecas += atual.pecas;
      g.valor += atual.valor;
      porRef.set(nome, g);
    }
    const linhas = [...porRef.values()].sort((a, b) => b.valor - a.valor);
    return responder(req, res, {
      nome: 'estoque-posicao',
      titulo: `Posição de estoque por ${grupo}`,
      colunas: [
        { key: 'grupo', label: grupo === 'categoria' ? 'Categoria' : 'Coleção' },
        { key: 'pecas', label: 'Peças', tipo: 'number' },
        { key: 'valor', label: 'Valor (custo)', tipo: 'money' },
      ],
      linhas,
      resumo: { pecas: linhas.reduce((a, l) => a + l.pecas, 0), valor: somaMoeda(linhas.map((l) => l.valor)) },
    });
  }
  const linhas = [...porProduto.values()].sort((a, b) => b.valor - a.valor);
  return responder(req, res, {
    nome: 'estoque-posicao',
    titulo: 'Posição de estoque por produto',
    colunas: [
      { key: 'produto', label: 'Produto' },
      { key: 'pecas', label: 'Peças', tipo: 'number' },
      { key: 'valor', label: 'Valor (custo)', tipo: 'money' },
    ],
    linhas,
    resumo: { pecas: linhas.reduce((a, l) => a + l.pecas, 0), valor: somaMoeda(linhas.map((l) => l.valor)) },
  });
}

// ----------------------------------------------------------------------------
// 2) Movimentações por período
// ----------------------------------------------------------------------------
async function relMovimentacoes(req: Request, res: Response) {
  const s = storeDoAtor(currentUser(req));
  const { de, ate } = periodo(req);
  const tipo = typeof req.query.tipo === 'string' && req.query.tipo ? String(req.query.tipo) : null;
  const local = typeof req.query.local === 'string' && req.query.local ? String(req.query.local) : null;
  const [produtos, tamanhos] = await Promise.all([
    s.list(RESOURCES.produtos, { page: 1, pageSize: 2000 }),
    s.list(RESOURCES.tamanhos, { page: 1, pageSize: 200 }),
  ]);
  const movs = await s.list(RESOURCES.movimentacoes, { page: 1, pageSize: 5000, sort: 'data', dir: 'desc', filter: tipo ? { tipo } : {} });
  const pNome = new Map(produtos.rows.map((p) => [Number(p.id), labelOf(RESOURCES.produtos, p)]));
  const tNome = new Map(tamanhos.rows.map((t) => [Number(t.id), String(t.codigo || '')]));
  const linhas: Row[] = [];
  for (const m of movs.rows) {
    const data = String(m.data || '').slice(0, 10);
    if (de && data < de) continue;
    if (ate && data > ate) continue;
    if (local && String(m.local || '') !== local) continue;
    linhas.push({
      data,
      tipo: m.tipo === 'entrada' ? 'Entrada' : m.tipo === 'saida' ? 'Saída' : m.tipo === 'transferencia' ? 'Transferência' : 'Ajuste',
      produto: pNome.get(Number(m.produto_id)) || `#${m.produto_id}`,
      tamanho: tNome.get(Number(m.tamanho_id)) || '',
      local: String(m.local || '') + (m.local_destino ? ` → ${m.local_destino}` : ''),
      quantidade: Number(m.quantidade),
      motivo: String(m.motivo || ''),
    });
  }
  return responder(req, res, {
    nome: 'movimentacoes-periodo',
    titulo: 'Movimentações por período',
    colunas: [
      { key: 'data', label: 'Data', tipo: 'date' },
      { key: 'tipo', label: 'Tipo' },
      { key: 'produto', label: 'Produto' },
      { key: 'tamanho', label: 'Tam.' },
      { key: 'local', label: 'Local' },
      { key: 'quantidade', label: 'Qtd.', tipo: 'number' },
      { key: 'motivo', label: 'Motivo' },
    ],
    linhas,
    resumo: { registros: linhas.length },
  });
}

// ----------------------------------------------------------------------------
// 3) Produção concluída por período
// ----------------------------------------------------------------------------
async function relProducao(req: Request, res: Response) {
  const s = storeDoAtor(currentUser(req));
  const { de, ate } = periodo(req);
  const [produtos] = await Promise.all([s.list(RESOURCES.produtos, { page: 1, pageSize: 2000 })]);
  const pNome = new Map(produtos.rows.map((p) => [Number(p.id), labelOf(RESOURCES.produtos, p)]));
  const ordens = await s.list(RESOURCES.ordens, { page: 1, pageSize: 5000, sort: 'id', dir: 'desc', filter: { status: 'concluida' } });
  const linhas: Row[] = [];
  let totalPecas = 0;
  for (const o of ordens.rows) {
    const data = String(o.concluida_em || o.atualizado_em || o.criado_em || '').slice(0, 10);
    if (de && data < de) continue;
    if (ate && data > ate) continue;
    const pecas = Number(o.quantidade || 0);
    totalPecas += pecas;
    linhas.push({
      data,
      op: Number(o.id),
      produto: pNome.get(Number(o.produto_id)) || `#${o.produto_id}`,
      tipo: String(o.tipo || 'tamanho') === 'grade' ? 'Grade' : 'Tamanho',
      detalhe: String(o.tipo || 'tamanho') === 'grade' ? '' : String(o.tamanho_id__label || ''),
      pecas,
      faccao: String(o.faccao || ''),
    });
  }
  return responder(req, res, {
    nome: 'producao-periodo',
    titulo: 'Produção concluída por período',
    colunas: [
      { key: 'data', label: 'Concluída em', tipo: 'date' },
      { key: 'op', label: 'OP #', tipo: 'number' },
      { key: 'produto', label: 'Produto' },
      { key: 'tipo', label: 'Tipo' },
      { key: 'detalhe', label: 'Tamanho' },
      { key: 'pecas', label: 'Peças', tipo: 'number' },
      { key: 'faccao', label: 'Facção' },
    ],
    linhas,
    resumo: { pecas: totalPecas, ordens: linhas.length },
  });
}

// ----------------------------------------------------------------------------
// 4) Vendas por cliente / representante / coleção / categoria
// ----------------------------------------------------------------------------
async function relVendas(req: Request, res: Response) {
  const s = storeDoAtor(currentUser(req));
  const { de, ate } = periodo(req);
  const por = String(req.query.por || 'cliente');
  const [vendas, itensVenda, clientes, representantes, produtos, categorias, colecoes] = await Promise.all([
    s.list(RESOURCES.vendas, { page: 1, pageSize: 5000 }),
    s.list(RESOURCES.itens_venda, { page: 1, pageSize: 10000 }),
    s.list(RESOURCES.clientes, { page: 1, pageSize: 2000 }),
    s.list(RESOURCES.representantes, { page: 1, pageSize: 500 }),
    s.list(RESOURCES.produtos, { page: 1, pageSize: 2000 }),
    s.list(RESOURCES.categorias, { page: 1, pageSize: 500 }),
    s.list(RESOURCES.colecoes, { page: 1, pageSize: 500 }),
  ]);
  const clienteNome = new Map(clientes.rows.map((c) => [Number(c.id), labelOf(RESOURCES.clientes, c)]));
  const repNome = new Map(representantes.rows.map((r) => [Number(r.id), labelOf(RESOURCES.representantes, r)]));
  const catNome = new Map(categorias.rows.map((c) => [Number(c.id), labelOf(RESOURCES.categorias, c)]));
  const colNome = new Map(colecoes.rows.map((c) => [Number(c.id), labelOf(RESOURCES.colecoes, c)]));
  const produtoMap = new Map(produtos.rows.map((p) => [Number(p.id), p]));
  const itensPorVenda = new Map<number, Row[]>();
  for (const iv of itensVenda.rows) {
    const lista = itensPorVenda.get(Number(iv.venda_id)) || [];
    lista.push(iv);
    itensPorVenda.set(Number(iv.venda_id), lista);
  }
  const faturadas = vendas.rows.filter((v) => FATURADAS.includes(String(v.status)));
  const agrupado = new Map<string, { chave: string; pedidos: number; valor: number; comissao: number }>();
  const soma = (chave: string, valor: number, comissao: number) => {
    const a = agrupado.get(chave) || { chave, pedidos: 0, valor: 0, comissao: 0 };
    a.pedidos++;
    a.valor += valor;
    a.comissao += comissao;
    agrupado.set(chave, a);
  };
  for (const v of faturadas) {
    const data = String(v.faturada_em || v.data || '').slice(0, 10);
    if (de && data < de) continue;
    if (ate && data > ate) continue;
    const total = Number(v.total || 0);
    const comissao = Number(v.comissao_valor || 0);
    if (por === 'cliente') soma(clienteNome.get(Number(v.cliente_id)) || `#${v.cliente_id}`, total, comissao);
    else if (por === 'representante') soma(repNome.get(Number(v.representante_id)) || 'Sem representante', total, comissao);
    else {
      const itens = itensPorVenda.get(Number(v.id)) || [];
      const sub = new Map<string, number>();
      for (const iv of itens) {
        const p = produtoMap.get(Number(iv.produto_id));
        const chave = por === 'colecao' ? colNome.get(Number(p?.colecao_id)) || 'Sem coleção' : catNome.get(Number(p?.categoria_id)) || 'Sem categoria';
        sub.set(chave, (sub.get(chave) || 0) + Number(iv.subtotal || 0));
      }
      // distribui comissão proporcional ao subtotal
      const totalItens = [...sub.values()].reduce((a, b) => a + b, 0);
      for (const [chave, valor] of sub) {
        const a = agrupado.get(chave) || { chave, pedidos: 0, valor: 0, comissao: 0 };
        a.pedidos += 1;
        a.valor += valor;
        a.comissao += totalItens > 0 ? round2((valor / totalItens) * comissao) : 0;
        agrupado.set(chave, a);
      }
    }
  }
  const linhas = [...agrupado.values()].sort((a, b) => b.valor - a.valor);
  const legenda: Record<string, string> = { cliente: 'Cliente', representante: 'Representante', colecao: 'Coleção', categoria: 'Categoria' };
  return responder(req, res, {
    nome: 'vendas',
    titulo: `Vendas por ${legenda[por] || por}`,
    colunas: [
      { key: 'chave', label: legenda[por] || por },
      { key: 'pedidos', label: 'Pedidos', tipo: 'number' },
      { key: 'valor', label: 'Valor vendido', tipo: 'money' },
      { key: 'comissao', label: 'Comissão', tipo: 'money' },
    ],
    linhas,
    resumo: { valor: somaMoeda(linhas.map((l) => l.valor)), comissao: somaMoeda(linhas.map((l) => l.comissao)) },
  });
}

// ----------------------------------------------------------------------------
// 5) Curva ABC de produtos (80/15/5 por faturamento)
// ----------------------------------------------------------------------------
async function relABC(req: Request, res: Response) {
  const s = storeDoAtor(currentUser(req));
  const { de, ate } = periodo(req);
  const [produtos, vendas, itensVenda] = await Promise.all([
    s.list(RESOURCES.produtos, { page: 1, pageSize: 2000 }),
    s.list(RESOURCES.vendas, { page: 1, pageSize: 5000 }),
    s.list(RESOURCES.itens_venda, { page: 1, pageSize: 10000 }),
  ]);
  const faturadas = vendas.rows.filter((v) => FATURADAS.includes(String(v.status)));
  const porVenda = new Set<number>();
  const intervalo = (d: string) => {
    if (de && d < de) return false;
    if (ate && d > ate) return false;
    return true;
  };
  for (const v of faturadas) {
    const data = String(v.faturada_em || v.data || '').slice(0, 10);
    if (intervalo(data)) porVenda.add(Number(v.id));
  }
  const fatPorProduto = new Map<number, number>();
  for (const iv of itensVenda.rows) {
    if (!porVenda.has(Number(iv.venda_id))) continue;
    const pid = Number(iv.produto_id);
    fatPorProduto.set(pid, (fatPorProduto.get(pid) || 0) + Number(iv.subtotal || 0));
  }
  const totalGeral = [...fatPorProduto.values()].reduce((a, b) => a + b, 0) || 1;
  const lista = [...fatPorProduto.entries()]
    .map(([pid, fat]) => {
      const p = produtos.rows.find((x) => Number(x.id) === pid);
      return { produto: p ? labelOf(RESOURCES.produtos, p) : `#${pid}`, fat };
    })
    .sort((a, b) => b.fat - a.fat);
  let acumulado = 0;
  const linhas = lista.map((l) => {
    acumulado += l.fat;
    const pctAcum = (acumulado / totalGeral) * 100;
    const classe = pctAcum <= 80 ? 'A' : pctAcum <= 95 ? 'B' : 'C';
    return { produto: l.produto, faturamento: round2(l.fat), pct: round2((l.fat / totalGeral) * 100), pct_acumulado: round2(pctAcum), classe };
  });
  return responder(req, res, {
    nome: 'abc',
    titulo: 'Curva ABC de produtos',
    colunas: [
      { key: 'classe', label: 'Classe' },
      { key: 'produto', label: 'Produto' },
      { key: 'faturamento', label: 'Faturamento', tipo: 'money' },
      { key: 'pct', label: '% do total', tipo: 'number' },
      { key: 'pct_acumulado', label: '% acumulado', tipo: 'number' },
    ],
    linhas,
    resumo: { faturamento: round2(totalGeral) },
  });
}

// ----------------------------------------------------------------------------
// 6) Insumos abaixo do estoque mínimo
// ----------------------------------------------------------------------------
async function relInsumosMinimo(req: Request, res: Response) {
  const s = storeDoAtor(currentUser(req));
  const [insumos, estoques] = await Promise.all([
    s.list(RESOURCES.insumos, { page: 1, pageSize: 2000 }),
    s.list(RESOURCES.estoque_insumos, { page: 1, pageSize: 2000 }),
  ]);
  const linhas: Row[] = [];
  for (const e of estoques.rows) {
    if (Number(e.estoque_min || 0) <= 0 || Number(e.quantidade || 0) > Number(e.estoque_min)) continue;
    const ins = insumos.rows.find((x) => Number(x.id) === Number(e.insumo_id));
    linhas.push({
      insumo: ins ? labelOf(RESOURCES.insumos, ins) : `#${e.insumo_id}`,
      unidade: ins?.unidade || 'un',
      custo_medio: Number(ins?.custo_medio || 0),
      quantidade: Number(e.quantidade || 0),
      estoque_min: Number(e.estoque_min || 0),
      faltando: Math.max(0, Number(e.estoque_min || 0) - Number(e.quantidade || 0)),
    });
  }
  linhas.sort((a, b) => a.quantidade - a.estoque_min - (b.quantidade - b.estoque_min));
  return responder(req, res, {
    nome: 'insumos-minimo',
    titulo: 'Insumos abaixo do estoque mínimo',
    colunas: [
      { key: 'insumo', label: 'Insumo' },
      { key: 'quantidade', label: 'Saldo', tipo: 'number' },
      { key: 'estoque_min', label: 'Mínimo', tipo: 'number' },
      { key: 'faltando', label: 'Faltando', tipo: 'number' },
      { key: 'custo_medio', label: 'Custo médio', tipo: 'money' },
    ],
    linhas,
    resumo: { itens: linhas.length },
  });
}

// ------------------------------------------------------------------------------
// 7) Faturamento por período — mensal com comparação mensal e anual
// ------------------------------------------------------------------------------
async function relFaturamento(req: Request, res: Response) {
  const s = storeDoAtor(currentUser(req));
  const { de, ate } = periodo(req);
  const vendas = await s.list(RESOURCES.vendas, { page: 1, pageSize: 10000 });
  const faturadas = vendas.rows.filter((v) => FATURADAS.includes(String(v.status)));

  // Faturamento por mês (YYYY-MM) e por ano (YYYY)
  const porMes = new Map<string, { valor: number; pedidos: number }>();
  const porAno = new Map<string, number>();
  const noIntervalo = (d: string) => d && (!de || d >= de) && (!ate || d <= ate);
  for (const v of faturadas) {
    const dia = String(v.faturada_em || v.data || '').slice(0, 10);
    const mes = dia.slice(0, 7);
    if (!mes || !noIntervalo(dia)) continue;
    const total = Number(v.total || 0);
    const atual = porMes.get(mes) || { valor: 0, pedidos: 0 };
    atual.valor = round2(atual.valor + total);
    atual.pedidos += 1;
    porMes.set(mes, atual);
    const ano = mes.slice(0, 4);
    porAno.set(ano, round2((porAno.get(ano) || 0) + total));
  }

  // Janela padrão: últimos 24 meses (permite comparação com o ano anterior)
  const meses: string[] = [];
  const agora = new Date();
  const fim = ate ? ate.slice(0, 7) : `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}`;
  const inicio = de
    ? de.slice(0, 7)
    : (() => {
        const d = new Date(agora.getFullYear(), agora.getMonth() - 23, 1);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      })();
  let cursor = new Date(`${inicio}-01T12:00:00Z`);
  const fimDate = new Date(`${fim}-01T12:00:00Z`);
  let guard = 0;
  while (cursor <= fimDate && guard++ < 120) {
    meses.push(cursor.toISOString().slice(0, 7));
    cursor = new Date(cursor.setUTCMonth(cursor.getUTCMonth() + 1));
  }

  const linhas = meses.map((mes) => {
    const atual = porMes.get(mes) || { valor: 0, pedidos: 0 };
    const anoAnteriorMes = `${Number(mes.slice(0, 4)) - 1}${mes.slice(4)}`;
    const valorAnoAnterior = porMes.get(anoAnteriorMes)?.valor ?? 0;
    const variacao = valorAnoAnterior > 0 ? round2(((atual.valor - valorAnoAnterior) / valorAnoAnterior) * 100) : null;
    return { mes, pedidos: atual.pedidos, faturamento: atual.valor, ano_anterior: valorAnoAnterior, variacao_pct: variacao };
  });

  const anoAtual = String(agora.getFullYear());
  const anoAnterior = String(agora.getFullYear() - 1);
  const fatAnoAtual = porAno.get(anoAtual) || 0;
  const fatAnoAnterior = porAno.get(anoAnterior) || 0;
  const variacaoAno = fatAnoAnterior > 0 ? round2(((fatAnoAtual - fatAnoAnterior) / fatAnoAnterior) * 100) : null;

  const comDados = linhas.filter((l) => l.faturamento > 0 || l.ano_anterior > 0);
  return responder(req, res, {
    nome: 'faturamento',
    titulo: 'Faturamento por período (vendas faturadas)',
    colunas: [
      { key: 'mes', label: 'Mês' },
      { key: 'pedidos', label: 'Pedidos', tipo: 'number' },
      { key: 'faturamento', label: 'Faturamento', tipo: 'money' },
      { key: 'ano_anterior', label: 'Mesmo mês (ano anterior)', tipo: 'money' },
      { key: 'variacao_pct', label: 'Variação %', tipo: 'percent' },
    ],
    linhas: comDados.length ? comDados.slice().reverse() : linhas,
    resumo: {
      faturamento: somaMoeda(linhas.map((l) => l.faturamento)),
      faturamento_ano: round2(fatAnoAtual),
      faturamento_ano_anterior: round2(fatAnoAnterior),
      variacao_ano_pct: variacaoAno,
    },
    grafico: { rotulos: meses.map((m) => `${m.slice(5)}/${m.slice(2, 4)}`), valores: meses.map((m) => porMes.get(m)?.valor ?? 0), formato: 'money' },
  });
}

// ------------------------------------------------------------------------------
// 8) Comissões por representante + evolução mensal (gráfico)
// ------------------------------------------------------------------------------
async function relComissoes(req: Request, res: Response) {
  const s = storeDoAtor(currentUser(req));
  const { de, ate } = periodo(req);
  const representanteId = req.query.representante_id ? Number(req.query.representante_id) : undefined;
  const [vendas, representantes] = await Promise.all([
    s.list(RESOURCES.vendas, { page: 1, pageSize: 10000, filter: representanteId ? { representante_id: representanteId } : {} }),
    s.list(RESOURCES.representantes, { page: 1, pageSize: 500 }),
  ]);
  const repNome = new Map(representantes.rows.map((r) => [Number(r.id), labelOf(RESOURCES.representantes, r)]));

  const noIntervalo = (d: string) => d && (!de || d >= de) && (!ate || d <= ate);
  const porRep = new Map<number, { representante_id: number; representante: string; pedidos: number; valor_vendas: number; comissao: number }>();
  const porMes = new Map<string, { valor: number; comissao: number }>();
  for (const v of vendas.rows) {
    if (!FATURADAS.includes(String(v.status))) continue;
    if (!v.representante_id) continue;
    const dataFat = String(v.faturada_em || v.data || '').slice(0, 10);
    if (!noIntervalo(dataFat)) continue;
    const rid = Number(v.representante_id);
    const total = Number(v.total || 0);
    const comissao = Number(v.comissao_valor || 0);
    const atual = porRep.get(rid) || { representante_id: rid, representante: repNome.get(rid) || `#${rid}`, pedidos: 0, valor_vendas: 0, comissao: 0 };
    atual.pedidos += 1;
    atual.valor_vendas = round2(atual.valor_vendas + total);
    atual.comissao = round2(atual.comissao + comissao);
    porRep.set(rid, atual);

    const mes = dataFat.slice(0, 7);
    const m = porMes.get(mes) || { valor: 0, comissao: 0 };
    m.valor = round2(m.valor + total);
    m.comissao = round2(m.comissao + comissao);
    porMes.set(mes, m);
  }

  // Últimos 12 meses (completando os meses sem comissão)
  const meses: string[] = [];
  const agora = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(agora.getFullYear(), agora.getMonth() - i, 1);
    meses.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }

  const lista = [...porRep.values()].sort((a, b) => b.comissao - a.comissao);
  return responder(req, res, {
    nome: 'comissoes',
    titulo: 'Comissões por representante',
    colunas: [
      { key: 'representante', label: 'Representante' },
      { key: 'pedidos', label: 'Pedidos', tipo: 'number' },
      { key: 'valor_vendas', label: 'Vendas', tipo: 'money' },
      { key: 'comissao', label: 'Comissão', tipo: 'money' },
    ],
    linhas: lista,
    resumo: {
      comissao: somaMoeda(lista.map((l) => l.comissao)),
      valor: somaMoeda(lista.map((l) => l.valor_vendas)),
    },
    grafico: { rotulos: meses.map((m) => `${m.slice(5)}/${m.slice(2, 4)}`), valores: meses.map((m) => porMes.get(m)?.comissao ?? 0), formato: 'money' },
  });
}

// ------------------------------------------------------------------------------
// 9) Estoque mínimo por local (produtos acabados)
// ------------------------------------------------------------------------------
async function relEstoqueMinimo(req: Request, res: Response) {
  const s = storeDoAtor(currentUser(req));
  const local = typeof req.query.local === 'string' && req.query.local ? String(req.query.local) : null;
  const [produtos, tamanhos, estoques] = await Promise.all([
    s.list(RESOURCES.produtos, { page: 1, pageSize: 2000 }),
    s.list(RESOURCES.tamanhos, { page: 1, pageSize: 200 }),
    s.list(RESOURCES.estoques, { page: 1, pageSize: 5000, filter: local ? { local } : {} }),
  ]);
  const pNome = new Map(produtos.rows.map((p) => [Number(p.id), labelOf(RESOURCES.produtos, p)]));
  const tCod = new Map(tamanhos.rows.map((t) => [Number(t.id), String(t.codigo || '')]));
  const custo = new Map(produtos.rows.map((p) => [Number(p.id), Number(p.custo || 0)]));
  const linhas: Row[] = [];
  for (const e of estoques.rows) {
    if (Number(e.estoque_min || 0) <= 0) continue;
    if (Number(e.quantidade || 0) > Number(e.estoque_min || 0)) continue;
    const pid = Number(e.produto_id);
    const faltando = Math.max(0, Number(e.estoque_min) - Number(e.quantidade));
    linhas.push({
      produto: pNome.get(pid) || `#${pid}`,
      tamanho: tCod.get(Number(e.tamanho_id)) || '',
      local: String(e.local || 'loja'),
      saldo: Number(e.quantidade || 0),
      estoque_min: Number(e.estoque_min || 0),
      faltando,
      custo_repor: round2(faltando * (custo.get(pid) || 0)),
    });
  }
  linhas.sort((a, b) => b.faltando - a.faltando);
  return responder(req, res, {
    nome: 'estoque-minimo',
    titulo: 'Estoque abaixo do mínimo por local',
    colunas: [
      { key: 'produto', label: 'Produto' },
      { key: 'tamanho', label: 'Tam.' },
      { key: 'local', label: 'Local' },
      { key: 'saldo', label: 'Saldo', tipo: 'number' },
      { key: 'estoque_min', label: 'Mínimo', tipo: 'number' },
      { key: 'faltando', label: 'Faltando', tipo: 'number' },
      { key: 'custo_repor', label: 'Custo p/ repor', tipo: 'money' },
    ],
    linhas,
    resumo: {
      itens: linhas.length,
      faltando: linhas.reduce((a, l) => a + Number(l.faltando), 0),
      custo_repor: somaMoeda(linhas.map((l) => Number(l.custo_repor))),
    },
  });
}

// ------------------------------------------------------------------------------
// 10) Razão financeiro (livro-caixa com saldo acumulado) — gerente/admin
// ------------------------------------------------------------------------------
async function relRazao(req: Request, res: Response) {
  checkAccess(RESOURCES.lancamentos_financeiros, currentUser(req), 'read');
  const s = storeDoAtor(currentUser(req));
  const { de, ate } = periodo(req);
  const tipo = typeof req.query.tipo === 'string' && req.query.tipo ? String(req.query.tipo) : null;
  const [lancs, categorias, contas] = await Promise.all([
    s.list(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 10000, sort: 'data', dir: 'asc', filter: tipo ? { tipo } : {} }),
    s.list(RESOURCES.categorias_financeiras, { page: 1, pageSize: 1000 }),
    s.list(RESOURCES.contas_financeiras, { page: 1, pageSize: 1000 }),
  ]);
  const catNome = new Map(categorias.rows.map((c) => [Number(c.id), String(c.nome || '')]));
  const contaNome = new Map(contas.rows.map((c) => [Number(c.id), String(c.nome || '')]));

  let saldo = 0;
  let entradas = 0;
  let saidas = 0;
  const linhas: Row[] = [];
  for (const l of lancs.rows) {
    if (String(l.status) === 'cancelado') continue;
    const dia = String(l.data || '').slice(0, 10);
    if (de && dia < de) continue;
    if (ate && dia > ate) continue;
    const valor = Number(l.valor || 0);
    const entrada = l.tipo === 'receita' || l.tipo === 'investimento';
    saldo = round2(saldo + (entrada ? valor : -valor));
    if (entrada) entradas = round2(entradas + valor);
    else saidas = round2(saidas + valor);
    linhas.push({
      data: dia,
      descricao: String(l.descricao || ''),
      categoria: catNome.get(Number(l.categoria_id || 0)) || 'Sem categoria',
      conta: contaNome.get(Number(l.conta_id || 0)) || '—',
      tipo: String(l.tipo || ''),
      entrada: entrada ? valor : 0,
      saida: entrada ? 0 : valor,
      saldo,
    });
  }
  return responder(req, res, {
    nome: 'razao-financeiro',
    titulo: 'Razão financeiro (livro-caixa)',
    colunas: [
      { key: 'data', label: 'Data', tipo: 'date' },
      { key: 'descricao', label: 'Descrição' },
      { key: 'categoria', label: 'Categoria' },
      { key: 'conta', label: 'Conta' },
      { key: 'tipo', label: 'Tipo' },
      { key: 'entrada', label: 'Entrada', tipo: 'money' },
      { key: 'saida', label: 'Saída', tipo: 'money' },
      { key: 'saldo', label: 'Saldo acumulado', tipo: 'money' },
    ],
    linhas,
    resumo: { entradas, saidas, saldo: round2(saldo), registros: linhas.length },
  });
}

// ------------------------------------------------------------------------------
// 11) DRE por período (gerencial, por classificação de categoria) — gerente/admin
// ------------------------------------------------------------------------------
async function relDRE(req: Request, res: Response) {
  checkAccess(RESOURCES.lancamentos_financeiros, currentUser(req), 'read');
  const s = storeDoAtor(currentUser(req));
  const { de, ate } = periodo(req);
  const [lancs, categorias] = await Promise.all([
    s.list(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 10000, sort: 'data', dir: 'asc' }),
    s.list(RESOURCES.categorias_financeiras, { page: 1, pageSize: 1000 }),
  ]);
  const catPorId = new Map(categorias.rows.map((c) => [Number(c.id), c]));
  const catClasse = new Map<number, string>();
  for (const c of categorias.rows) catClasse.set(Number(c.id), String(c.classificacao_dre || ''));

  const CLASSE_LABEL: Record<string, string> = {
    receita: 'Receita',
    cmv: 'Custo de mercadoria / insumos',
    mao_obra: 'Mão de obra / produção',
    despesas_operacionais: 'Despesas operacionais',
    despesas_financeiras: 'Despesas financeiras / juros',
    impostos: 'Impostos e taxas',
    investimento: 'Investimento / aporte',
  };
  const classeDe = (l: Row): string => {
    const c = catClasse.get(Number(l.categoria_id || 0));
    if (c) return c;
    const t = String(l.tipo || '');
    return t === 'receita' ? 'receita' : t === 'investimento' ? 'investimento' : 'despesas_operacionais';
  };

  const porCategoria = new Map<string, { categoria: string; classe: string; valor: number }>();
  const totalClasse = new Map<string, number>();
  for (const l of lancs.rows) {
    if (String(l.status) !== 'confirmado') continue;
    const dia = String(l.data || '').slice(0, 10);
    if (de && dia < de) continue;
    if (ate && dia > ate) continue;
    const catId = Number(l.categoria_id || 0);
    const cat = catPorId.get(catId);
    const catNome = cat ? String(cat.nome || 'Sem categoria') : 'Sem categoria';
    const classe = classeDe(l);
    const valor = Number(l.valor || 0);
    const chave = `${classe}|${catNome}`;
    const atual = porCategoria.get(chave) || { categoria: catNome, classe, valor: 0 };
    atual.valor = round2(atual.valor + valor);
    porCategoria.set(chave, atual);
    totalClasse.set(classe, round2((totalClasse.get(classe) || 0) + valor));
  }
  const tot = (c: string) => totalClasse.get(c) || 0;
  const lucroBruto = round2(tot('receita') - tot('cmv'));
  const resultadoOperacional = round2(lucroBruto - tot('mao_obra') - tot('despesas_operacionais') - tot('impostos'));
  const resultadoFinanceiro = round2(resultadoOperacional - tot('despesas_financeiras'));
  const resultadoGeral = round2(resultadoFinanceiro + tot('investimento'));

  const ordem = ['receita', 'cmv', 'mao_obra', 'despesas_operacionais', 'impostos', 'despesas_financeiras', 'investimento'];
  const linhas: Row[] = [];
  for (const classe of ordem) {
    const doGrupo = [...porCategoria.values()].filter((x) => x.classe === classe).sort((a, b) => b.valor - a.valor);
    for (const item of doGrupo) linhas.push({ linha: `   ${item.categoria}`, grupo: CLASSE_LABEL[classe] || classe, valor: item.valor });
    linhas.push({ linha: `= ${CLASSE_LABEL[classe] || classe} (total)`, grupo: CLASSE_LABEL[classe] || classe, valor: tot(classe) });
  }
  linhas.push({ linha: '= Lucro bruto (receita − CMV)', grupo: 'Resumo', valor: lucroBruto });
  linhas.push({ linha: '= Resultado operacional', grupo: 'Resumo', valor: resultadoOperacional });
  linhas.push({ linha: '= Resultado financeiro', grupo: 'Resumo', valor: resultadoFinanceiro });
  linhas.push({ linha: '= Resultado geral (com aportes)', grupo: 'Resumo', valor: resultadoGeral });

  return responder(req, res, {
    nome: 'dre',
    titulo: `DRE gerencial${de || ate ? ` — ${de || 'início'} a ${ate || 'hoje'}` : ' (acumulado)'}`,
    colunas: [
      { key: 'linha', label: 'Linha' },
      { key: 'grupo', label: 'Grupo' },
      { key: 'valor', label: 'Valor', tipo: 'money' },
    ],
    linhas,
    resumo: { receita: tot('receita'), resultado: resultadoGeral },
  });
}

// ------------------------------------------------------------------------------
// Roteamento
// ------------------------------------------------------------------------------
export async function relatorio(req: Request, res: Response, nome: string) {
  // Acesso a relatórios exige leitura de vendas (todos os perfis autenticados).
  const actor = currentUser(req);
  checkAccess(RESOURCES.vendas, actor, 'read');
  switch (nome) {
    case 'estoque-posicao':
      return await relEstoquePosicao(req, res);
    case 'movimentacoes-periodo':
      return await relMovimentacoes(req, res);
    case 'producao-periodo':
      return await relProducao(req, res);
    case 'vendas':
      return await relVendas(req, res);
    case 'abc':
      return await relABC(req, res);
    case 'insumos-minimo':
      return await relInsumosMinimo(req, res);
    case 'faturamento':
      return await relFaturamento(req, res);
    case 'comissoes':
      return await relComissoes(req, res);
    case 'estoque-minimo':
      return await relEstoqueMinimo(req, res);
    case 'razao-financeiro':
      return await relRazao(req, res);
    case 'dre':
      return await relDRE(req, res);
    default:
      throw new HttpError(404, 'Relatório não encontrado.');
  }
}

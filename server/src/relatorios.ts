// ============================================================
// Fase 5 — Relatórios.
//
// Cada relatório é um endpoint GET /api/relatorios/<nome> que devolve
// { nome, resumo, colunas, linhas }. Com ?format=csv|xlsx o mesmo endpoint
// baixa o arquivo exportado (mesma estrutura do export de listas).
// ============================================================
import type { Request, Response } from 'express';
import { RESOURCES } from './resources';
import { checkAccess, getStore } from './services';
import { currentUser } from './auth';
import { enviarArquivo, type ColunaExport } from './export';
import type { Row } from './store';
import { labelOf } from './store';
import { HttpError } from './errors';

const FATURADAS = ['faturada', 'entregue'];
const round2 = (n: number) => Math.round(n * 100) / 100;

function periodo(req: Request): { de: string | null; ate: string | null } {
  const de = typeof req.query.de === 'string' && req.query.de ? String(req.query.de).slice(0, 10) : null;
  const ate = typeof req.query.ate === 'string' && req.query.ate ? String(req.query.ate).slice(0, 10) : null;
  return { de, ate };
}

async function responder(req: Request, res: Response, relatorio: { nome: string; titulo: string; colunas: ColunaExport[]; linhas: Row[]; resumo?: Row }) {
  const formato = typeof req.query.format === 'string' ? req.query.format : '';
  if (formato === 'csv' || formato === 'xlsx') {
    await enviarArquivo(res, relatorio.nome, formato, relatorio.colunas, relatorio.linhas, relatorio.titulo);
    return;
  }
  res.json({ nome: relatorio.nome, titulo: relatorio.titulo, colunas: relatorio.colunas, linhas: relatorio.linhas, resumo: relatorio.resumo ?? null });
}

// ----------------------------------------------------------------------------
// 1) Posição de estoque valorizada (por produto/categoria/coleção/local)
// ----------------------------------------------------------------------------
async function relEstoquePosicao(req: Request, res: Response) {
  const s = getStore();
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
      const l = String(e.local || 'almoxarifado');
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
      resumo: { pecas: linhas.reduce((a, l) => a + l.pecas, 0), valor: round2(linhas.reduce((a, l) => a + l.valor, 0)) },
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
      resumo: { pecas: linhas.reduce((a, l) => a + l.pecas, 0), valor: round2(linhas.reduce((a, l) => a + l.valor, 0)) },
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
    resumo: { pecas: linhas.reduce((a, l) => a + l.pecas, 0), valor: round2(linhas.reduce((a, l) => a + l.valor, 0)) },
  });
}

// ----------------------------------------------------------------------------
// 2) Movimentações por período
// ----------------------------------------------------------------------------
async function relMovimentacoes(req: Request, res: Response) {
  const s = getStore();
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
  const s = getStore();
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
  const s = getStore();
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
    resumo: { valor: round2(linhas.reduce((a, l) => a + l.valor, 0)), comissao: round2(linhas.reduce((a, l) => a + l.comissao, 0)) },
  });
}

// ----------------------------------------------------------------------------
// 5) Curva ABC de produtos (80/15/5 por faturamento)
// ----------------------------------------------------------------------------
async function relABC(req: Request, res: Response) {
  const s = getStore();
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
  const s = getStore();
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

// ----------------------------------------------------------------------------
// Roteamento
// ----------------------------------------------------------------------------
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
    default:
      throw new HttpError(404, 'Relatório não encontrado.');
  }
}

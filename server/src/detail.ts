// Página de detalhe do produto: consolida fotos, grade de estoque
// (tamanhos × locais), últimas movimentações, OPs abertas e ficha técnica.
// Usa apenas o contrato genérico do Store, então funciona no Postgres e no
// modo demonstração.
import type { Request, Response } from 'express';
import { currentUser } from './auth';
import { RESOURCES } from './resources';
import { checkAccess, getRecord, getStore } from './services';
import { parseId } from './validate';

export async function productDetail(req: Request, res: Response) {
  const r = RESOURCES.produtos;
  checkAccess(r, currentUser(req), 'read');
  const id = parseId(req.params.id);
  const s = getStore();

  const produto = await getRecord(r, id);

  const [tamanhos, estoques, movimentacoes, ordens, fichas] = await Promise.all([
    s.list(RESOURCES.tamanhos, { page: 1, pageSize: 200 }),
    s.list(RESOURCES.estoques, { page: 1, pageSize: 1000, filter: { produto_id: id } }),
    s.list(RESOURCES.movimentacoes, { page: 1, pageSize: 15, filter: { produto_id: id }, sort: 'data', dir: 'desc' }),
    s.list(RESOURCES.ordens, { page: 1, pageSize: 50, filter: { produto_id: id }, sort: 'id', dir: 'desc' }),
    s.list(RESOURCES.fichas, { page: 1, pageSize: 1, filter: { produto_id: id } }),
  ]);

  // Grade: locais × tamanhos
  const locais = Array.from(new Set(estoques.rows.map((e) => String(e.local || 'loja')))).sort();
  const sizesUsed = new Set(estoques.rows.map((e) => Number(e.tamanho_id)));
  const colunas = tamanhos.rows
    .filter((t) => sizesUsed.has(Number(t.id)) || estoques.rows.length === 0)
    .map((t) => ({ id: Number(t.id), codigo: String(t.codigo) }));
  const grade = locais.map((local) => {
    const celulas = colunas.map((c) => {
      const e = estoques.rows.find((x) => String(x.local || 'loja') === local && Number(x.tamanho_id) === c.id);
      return { tamanho_id: c.id, quantidade: e ? Number(e.quantidade) : 0, estoque_min: e ? Number(e.estoque_min || 0) : 0, estoque_id: e ? Number(e.id) : null };
    });
    return { local, celulas, total: celulas.reduce((a, c) => a + c.quantidade, 0) };
  });
  const totalPecas = estoques.rows.reduce((a, e) => a + Number(e.quantidade || 0), 0);
  const abaixoMinimo = estoques.rows.filter((e) => Number(e.estoque_min) > 0 && Number(e.quantidade) <= Number(e.estoque_min)).length;

  const ficha = fichas.rows[0] || null;
  const custoBase = Number(produto.custo || 0);
  const custoFicha = ficha ? Number(ficha.mao_obra || 0) + Number(ficha.custos_indiretos || 0) : 0;
  const margem = ficha ? Number(ficha.margem_pct || 0) : 0;
  const custoTotal = custoBase + custoFicha;
  const precoSugerido = custoTotal > 0 ? Math.round(custoTotal * (1 + margem / 100) * 100) / 100 : null;
  const precoVenda = Number(produto.preco_venda || 0);
  const margemReal = precoVenda > 0 && custoTotal > 0 ? Math.round(((precoVenda - custoTotal) / precoVenda) * 10000) / 100 : null;

  res.json({
    produto,
    estoque: { totalPecas, abaixoMinimo, valor: totalPecas * custoBase, colunas, grade },
    movimentacoes: movimentacoes.rows,
    ordens: { abertas: ordens.rows.filter((o) => ['planejada', 'em_producao'].includes(String(o.status))), recentes: ordens.rows.slice(0, 8) },
    custo: { ficha, custoBase, custoFicha, custoTotal, margem, precoSugerido, precoVenda, margemReal },
  });
}

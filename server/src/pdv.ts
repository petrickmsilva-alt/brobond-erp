// ============================================================================
// PDV — PONTO DE VENDA (P1)
//
// Regra que governa o módulo inteiro:
//
//   **O frontend NÃO calcula o total. O servidor recalcula tudo.**
//
// O operador lê um código de barras (ou digita um SKU) e manda para o servidor
// uma linha com produto e quantidade. Aqui é resolvido:
//
//   • qual produto é aquele código (código de barras → SKU → id);
//   • qual preço vale (lista de preço vigente, senão a ficha);
//   • o desconto por item e o desconto do cupom;
//   • subtotal, frete, total;
//   • quanto falta pagar e quanto é troco.
//
// Um `total`, `subtotal` ou `preco_unitario` vindo no corpo da requisição é
// IGNORADO. Se o cliente mandar, a resposta devolve o valor do servidor ao lado
// do que foi enviado, para a divergência aparecer na tela — não para ser usada.
//
// O caixa tem abertura e fechamento. O fechamento compara o valor contado com o
// que o sistema esperava e grava a diferença: sem isso não existe conferência.
//
// A venda do PDV é a MESMA entidade `vendas` (canal_venda = 'pdv'): o ERP não
// ganhou um segundo motor de venda. Faturamento, baixa de estoque, comissão e
// contas a receber continuam vindo de `aplicarRegrasPedido` +
// `syncLancamentoVenda`, exatamente como no pedido de balcão.
//
// A emissão da NFC-e é um ato SEPARADO (`POST /api/vendas/:id/fiscal/emitir`),
// de propósito: o provedor fiscal tem a própria máquina de estados e pode
// demorar. Engolir a emissão dentro da transação da venda faria um timeout do
// provedor desfazer uma venda que já aconteceu no balcão.
// ============================================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, checkFluxo, getDefaultLocal, getStore, toHttpError } from './services';
import { currentUser, type AuthUser } from './auth';
import { assertRegistroDaEmpresa, escopoDoAtor, type EscopoEmpresa } from './empresa';
import { parseId } from './validate';
import { round2 } from './utils';
import { aplicarRegrasPedido } from './itens';
import { syncLancamentoVenda } from './financeiro';
import { precoDe } from './listasPreco';
import type { Row, Tx } from './store';

export const R_CAIXA = () => getResource('pdv_caixas')!;
export const R_CAIXA_MOV = () => getResource('pdv_caixa_movimentos')!;
export const R_PAGAMENTO = () => getResource('pdv_pagamentos')!;

const FORMAS = ['dinheiro', 'pix', 'cartao_credito', 'cartao_debito', 'vale', 'boleto', 'transferencia', 'outros'];

function num(v: unknown, padrao = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : padrao;
}

// ----------------------------------------------------------------------------
// CAIXA — abertura, movimentos e fechamento
// ----------------------------------------------------------------------------

/** POST /api/pdv/caixas — abre o caixa. Um aberto por terminal. */
export async function abrirCaixa(req: Request, res: Response) {
  const actor = currentUser(req);
  checkFluxo(R_CAIXA(), actor);
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const body = (req.body || {}) as Record<string, unknown>;
  const numero = String(body.numero || body.terminal || 'CAIXA-1').trim().slice(0, 40);
  const valorAbertura = round2(Math.max(0, num(body.valor_abertura)));
  const s = getStore();
  try {
    const caixa = await s.transaction(async (tx) => {
      const aberto = await s.findOneWhere(R_CAIXA(), { empresa_id: escopo.empresaId, numero, status: 'aberto' }, tx);
      if (aberto) {
        throw new HttpError(409, `O caixa "${numero}" já está aberto (desde ${String(aberto.abertura_em).slice(0, 16)}). Feche-o antes de abrir outro.`);
      }
      const local = body.local ? String(body.local).slice(0, 60) : await getDefaultLocal(tx);
      const criado = await s.insert(
        R_CAIXA(),
        {
          empresa_id: escopo.empresaId,
          numero,
          usuario_id: actor.id || null,
          local,
          abertura_em: new Date().toISOString(),
          valor_abertura: valorAbertura,
          status: 'aberto',
          observacoes: body.observacoes ? String(body.observacoes).slice(0, 500) : null,
        },
        tx
      );
      await s.audit(
        { usuario_id: actor.id || null, usuario: actor.name, acao: 'criar', recurso: 'pdv_caixas', registro_id: Number(criado.id), descricao: `Caixa "${numero}" aberto com ${valorAbertura.toFixed(2)} de troco inicial`, dados: { numero, valor_abertura: valorAbertura, local } },
        tx
      );
      return criado;
    }, { isolation: 'serializable' });
    res.status(201).json(caixa);
  } catch (e) {
    throw toHttpError(e, R_CAIXA());
  }
}

/** GET /api/pdv/caixas/aberto?numero= — o caixa aberto do terminal. */
export async function caixaAberto(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_CAIXA(), actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const numero = req.query.numero ? String(req.query.numero).slice(0, 40) : undefined;
  const s = getStore();
  const filtro: Record<string, unknown> = { empresa_id: escopo.empresaId, status: 'aberto' };
  if (numero) filtro.numero = numero;
  const caixa = await s.findOneWhere(R_CAIXA(), filtro);
  if (!caixa) return res.json({ caixa: null });
  res.json({ caixa, resumo: await resumoCaixa(Number(caixa.id), escopo) });
}

/**
 * Posição do caixa: o que o sistema espera encontrar na gaveta.
 * `esperado = abertura + vendas(dinheiro) + suprimentos − sangrias`.
 */
async function resumoCaixa(caixaId: number, escopo: EscopoEmpresa, tx?: Tx): Promise<Record<string, unknown>> {
  const s = getStore();
  const caixa = await s.get(R_CAIXA(), caixaId, tx);
  if (!caixa) throw new HttpError(404, 'Caixa não encontrado.');
  const vendas = await s.list(
    getResource('vendas')!,
    { page: 1, pageSize: 5000, filter: { empresa_id: escopo.empresaId, pdv_caixa_id: caixaId }, sort: 'id', dir: 'asc' },
    tx
  );
  const pagamentos = await s.list(R_PAGAMENTO(), { page: 1, pageSize: 10000, filter: { caixa_id: caixaId } }, tx);
  const movimentos = await s.list(R_CAIXA_MOV(), { page: 1, pageSize: 5000, filter: { caixa_id: caixaId } }, tx);

  const porForma: Record<string, number> = {};
  let totalVendido = 0;
  const vendasVivas = vendas.rows.filter((v) => String(v.status) !== 'cancelada');
  const idsVivas = new Set(vendasVivas.map((v) => Number(v.id)));
  for (const p of pagamentos.rows) {
    if (!idsVivas.has(Number(p.venda_id))) continue;
    porForma[String(p.forma)] = round2(num(porForma[String(p.forma)]) + num(p.valor));
    totalVendido = round2(totalVendido + num(p.valor));
  }
  let suprimentos = 0;
  let sangrias = 0;
  for (const m of movimentos.rows) {
    if (String(m.tipo) === 'suprimento') suprimentos = round2(suprimentos + num(m.valor));
    else sangrias = round2(sangrias + num(m.valor));
  }
  const emDinheiro = num(porForma.dinheiro);
  return {
    caixa_id: caixaId,
    status: String(caixa.status),
    quantidade_vendas: vendasVivas.length,
    quantidade_canceladas: vendas.rows.length - vendasVivas.length,
    total_vendido: round2(vendasVivas.reduce((acc, v) => acc + num(v.total), 0)),
    por_forma: porForma,
    suprimentos,
    sangrias,
    valor_abertura: num(caixa.valor_abertura),
    // O que deveria estar na gaveta se nada saiu de forma não registrada.
    esperado_em_dinheiro: round2(num(caixa.valor_abertura) + emDinheiro + suprimentos - sangrias),
  };
}

/** GET /api/pdv/caixas/:id/resumo */
export async function resumoCaixaHandler(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_CAIXA(), actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const id = parseId(req.params.id);
  assertRegistroDaEmpresa(R_CAIXA(), await getStore().get(R_CAIXA(), id), escopo);
  res.json(await resumoCaixa(id, escopo));
}

/** POST /api/pdv/caixas/:id/movimentos — suprimento (troco) ou sangria. */
export async function movimentoCaixa(req: Request, res: Response) {
  const actor = currentUser(req);
  checkFluxo(R_CAIXA(), actor);
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const id = parseId(req.params.id);
  const body = (req.body || {}) as Record<string, unknown>;
  const tipo = String(body.tipo || '').toLowerCase();
  if (tipo !== 'suprimento' && tipo !== 'sangria') {
    throw new HttpError(400, 'tipo deve ser "suprimento" ou "sangria".', { tipo: 'Inválido' });
  }
  const valor = round2(num(body.valor));
  if (!(valor > 0)) throw new HttpError(400, 'O valor deve ser maior que zero.', { valor: 'Deve ser > 0' });
  const s = getStore();
  const mov = await s.transaction(async (tx) => {
    const caixa = assertRegistroDaEmpresa(R_CAIXA(), await s.get(R_CAIXA(), id, tx), escopo);
    if (String(caixa.status) !== 'aberto') throw new HttpError(409, 'Este caixa já foi fechado.');
    const criado = await s.insert(
      R_CAIXA_MOV(),
      { empresa_id: escopo.empresaId, caixa_id: id, tipo, valor, motivo: body.motivo ? String(body.motivo).slice(0, 200) : null, usuario_id: actor.id || null },
      tx
    );
    await s.audit(
      { usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'pdv_caixas', registro_id: id, descricao: `${tipo === 'suprimento' ? 'Suprimento' : 'Sangria'} de ${valor.toFixed(2)} no caixa #${id}`, dados: { tipo, valor } },
      tx
    );
    return criado;
  });
  res.status(201).json(mov);
}

/**
 * POST /api/pdv/caixas/:id/fechar — fecha o caixa.
 *
 * `valor_fechamento` é o que foi CONTADO. O servidor calcula o esperado e grava
 * a diferença — positiva ou negativa. Um caixa com diferença é fechado do mesmo
 * jeito (o dinheiro já está na gaveta), mas a divergência fica registrada e
 * auditada: fechar não apaga o fato.
 */
export async function fecharCaixa(req: Request, res: Response) {
  const actor = currentUser(req);
  checkFluxo(R_CAIXA(), actor);
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const id = parseId(req.params.id);
  const body = (req.body || {}) as Record<string, unknown>;
  if (body.valor_fechamento === undefined || body.valor_fechamento === null || body.valor_fechamento === '') {
    throw new HttpError(400, 'Informe o valor contado na gaveta (valor_fechamento).', { valor_fechamento: 'Obrigatório' });
  }
  const contado = round2(num(body.valor_fechamento));
  if (contado < 0) throw new HttpError(400, 'O valor contado não pode ser negativo.', { valor_fechamento: 'Deve ser ≥ 0' });
  const s = getStore();
  try {
    const fechamento = await s.transaction(async (tx) => {
      const caixa = assertRegistroDaEmpresa(R_CAIXA(), await s.get(R_CAIXA(), id, tx), escopo);
      if (String(caixa.status) !== 'aberto') throw new HttpError(409, 'Este caixa já está fechado.');
      const resumo = await resumoCaixa(id, escopo, tx);
      const esperado = num(resumo.esperado_em_dinheiro);
      const diferenca = round2(contado - esperado);
      const fechado = await s.tryUpdateIf(
        R_CAIXA(),
        id,
        { status: 'aberto' },
        {
          status: 'fechado',
          fechamento_em: new Date().toISOString(),
          valor_fechamento: contado,
          valor_sistema: esperado,
          diferenca,
          fechado_por: actor.id || null,
          observacoes: body.observacoes ? String(body.observacoes).slice(0, 500) : caixa.observacoes ?? null,
        },
        tx
      );
      if (!fechado) throw new HttpError(409, 'O caixa foi fechado por outra operação.');
      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'editar',
          recurso: 'pdv_caixas',
          registro_id: id,
          descricao: `Caixa #${id} fechado: contado ${contado.toFixed(2)}, esperado ${esperado.toFixed(2)}, diferença ${diferenca.toFixed(2)}`,
          dados: { valor_fechamento: contado, valor_sistema: esperado, diferenca, vendas: resumo.quantidade_vendas },
        },
        tx
      );
      return { fechado, resumo, diferenca, esperado, contado };
    }, { isolation: 'serializable' });
    res.json({
      ok: true,
      caixa: fechamento.fechado,
      resumo: fechamento.resumo,
      diferenca: fechamento.diferenca,
      // Divergência não é erro do sistema: é um fato que a operação precisa ver.
      alerta: Math.abs(fechamento.diferenca) > 0.009 ? (fechamento.diferenca > 0 ? 'Sobra de caixa registrada.' : 'Falta de caixa registrada.') : null,
    });
  } catch (e) {
    throw toHttpError(e, R_CAIXA());
  }
}

// ----------------------------------------------------------------------------
// BUSCA POR CÓDIGO DE BARRAS / SKU
// ----------------------------------------------------------------------------

export type LinhaResolvida = {
  /** Produto que vai para `itens_venda.produto_id` (o PAI, se o código era de variação). */
  produto: Row;
  /** Tamanho resolvido. O estoque deste ERP é por produto+tamanho+local, então
   *  uma linha sem tamanho nunca conseguiria ser faturada. */
  tamanho_id: number | null;
  tamanho_codigo: string | null;
  /** SKU do que foi efetivamente lido (o da variação, quando é o caso). */
  sku: string;
  eh_variacao: boolean;
  preco: number;
  preco_tabela: number;
  lista_preco_id: number | null;
  lista_nome: string | null;
  codigo_lido: string | null;
  disponivel: number;
};

/** Tamanhos em que o produto tem linha de estoque nesta empresa. */
async function tamanhosComEstoque(produtoId: number, escopo: EscopoEmpresa, tx?: Tx): Promise<{ id: number; codigo: string; disponivel: number }[]> {
  const s = getStore();
  const saldos = await s.list(getResource('estoques')!, { page: 1, pageSize: 1000, filter: { empresa_id: escopo.empresaId, produto_id: produtoId } }, tx);
  const porTamanho = new Map<number, number>();
  for (const e of saldos.rows) {
    const t = e.tamanho_id === null || e.tamanho_id === undefined ? 0 : Number(e.tamanho_id);
    porTamanho.set(t, num(porTamanho.get(t)) + num(e.quantidade));
  }
  const out: { id: number; codigo: string; disponivel: number }[] = [];
  for (const [id, disponivel] of porTamanho) {
    const tam = id ? await s.findOneWhere(getResource('tamanhos')!, { id }, tx) : null;
    out.push({ id, codigo: tam ? String(tam.codigo ?? tam.nome ?? id) : 'sem tamanho', disponivel });
  }
  return out.sort((a, b) => a.id - b.id);
}

/**
 * Resolve uma referência de produto: código de barras, SKU ou id.
 *
 * Exportada porque a venda do PDV e a busca usam exatamente o mesmo caminho —
 * uma venda não pode aceitar um código que a busca não acharia.
 *
 * Além do produto, resolve o TAMANHO. Não é preciosismo: o saldo deste ERP é
 * (produto, tamanho, local) e `itens_venda.tamanho_id` é obrigatório — uma linha
 * sem tamanho entraria no pedido e travaria no faturamento, deixando o operador
 * com um cupom que não fecha. Quando o código lido é de uma variação, o tamanho
 * vem dela e o produto vira o pai; quando não é, o tamanho precisa ser
 * informado ou ser único entre os que têm estoque.
 */
export async function resolverProduto(
  codigo: string,
  escopo: EscopoEmpresa,
  tx?: Tx,
  tamanhoPedido?: number | null
): Promise<LinhaResolvida> {
  const s = getStore();
  const limpo = String(codigo ?? '').trim();
  if (!limpo) throw new HttpError(400, 'Informe o código de barras, o SKU ou o id do produto.');
  const escopoFiltro = { empresa_id: escopo.empresaId };
  let lido =
    (await s.findOneWhere(getResource('produtos')!, { ...escopoFiltro, codigo_barras: limpo }, tx)) ||
    (await s.findOneWhere(getResource('produtos')!, { ...escopoFiltro, sku: limpo }, tx));
  if (!lido && /^\d+$/.test(limpo)) {
    const porId = await s.get(getResource('produtos')!, Number(limpo), tx);
    if (porId && Number(porId.empresa_id ?? 1) === escopo.empresaId) lido = porId;
  }
  if (!lido) throw new HttpError(404, `Nenhum produto encontrado para "${limpo}" nesta empresa.`);
  if (lido.ativo === false) throw new HttpError(409, `O produto ${lido.sku} está inativo e não pode ser vendido.`);

  // O preço é SEMPRE o do que foi lido: a variação tem preço próprio e a lista
  // de preço pode cobri-lo.
  const resolvido = await precoDe(lido, escopo, tx);

  let produto = lido;
  let tamanhoId: number | null = lido.tamanho_id === null || lido.tamanho_id === undefined ? null : Number(lido.tamanho_id);
  const ehVariacao = Boolean(lido.produto_pai_id);
  if (ehVariacao) {
    const pai = await s.get(getResource('produtos')!, Number(lido.produto_pai_id), tx);
    // O pai pode ter sido excluído ou pertencer a outra empresa: aí a linha não
    // tem para onde ir e é melhor recusar do que gravar um órfão.
    if (!pai) throw new HttpError(409, `A variação ${lido.sku} aponta para o produto-pai #${lido.produto_pai_id}, que não existe mais.`);
    assertRegistroDaEmpresa(getResource('produtos')!, pai, escopo);
    produto = pai;
  } else if (tamanhoPedido) {
    const tam = await s.get(getResource('tamanhos')!, Number(tamanhoPedido), tx);
    if (!tam) throw new HttpError(404, `O tamanho #${tamanhoPedido} não existe.`);
    assertRegistroDaEmpresa(getResource('tamanhos')!, tam, escopo);
    tamanhoId = Number(tam.id);
  } else {
    const opcoes = await tamanhosComEstoque(Number(lido.id), escopo, tx);
    if (opcoes.length === 1 && opcoes[0].id > 0) tamanhoId = opcoes[0].id;
    else if (opcoes.length > 1) {
      throw new HttpError(
        400,
        `O produto ${lido.sku} tem mais de um tamanho com estoque (${opcoes.map((o) => o.codigo).join(', ')}). Informe o tamanho da linha.`,
        { tamanho_id: 'Ambíguo' }
      );
    }
    // Nenhum tamanho com estoque: deixa null e o faturamento responde com a
    // falta real ("precisa de N, há 0"), que é a mensagem que o operador entende.
  }

  const tam = tamanhoId ? await s.findOneWhere(getResource('tamanhos')!, { id: tamanhoId }, tx) : null;
  const disponivel = (await tamanhosComEstoque(Number(produto.id), escopo, tx)).filter((t) => t.id === (tamanhoId ?? 0)).reduce((acc, t) => acc + t.disponivel, 0);

  return {
    produto,
    tamanho_id: tamanhoId,
    tamanho_codigo: tam ? String(tam.codigo ?? tam.nome ?? tam.id) : null,
    sku: String(lido.sku ?? ''),
    eh_variacao: ehVariacao,
    preco: resolvido.preco,
    preco_tabela: resolvido.preco_tabela,
    lista_preco_id: resolvido.lista_id,
    lista_nome: resolvido.lista_nome,
    codigo_lido: limpo,
    disponivel,
  };
}

/** GET /api/pdv/buscar?codigo=789... — o que o leitor de código devolve à tela. */
export async function buscarProduto(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('produtos')!, actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const codigo = String(req.query.codigo ?? req.query.q ?? req.query.sku ?? '');
  const tamanhoPedido = req.query.tamanho_id ? Number(req.query.tamanho_id) : null;
  const linha = await resolverProduto(codigo, escopo, undefined, tamanhoPedido);
  const saldo = await getStore().list(getResource('estoques')!, {
    page: 1,
    pageSize: 100,
    filter: { produto_id: Number(linha.produto.id) },
  });
  res.json({
    produto_id: Number(linha.produto.id),
    sku: linha.sku,
    sku_produto: linha.produto.sku,
    nome: linha.produto.nome,
    unidade: linha.produto.unidade ?? null,
    codigo_barras: linha.produto.codigo_barras ?? null,
    // O tamanho resolvido é devolvido à tela: é ele que a linha da venda vai
    // usar, e o operador precisa ver o que o leitor escolheu.
    tamanho_id: linha.tamanho_id,
    tamanho: linha.tamanho_codigo,
    eh_variacao: linha.eh_variacao,
    preco: linha.preco,
    preco_tabela: linha.preco_tabela,
    origem_preco: linha.lista_nome ? `Lista: ${linha.lista_nome}` : 'Ficha do produto',
    lista_preco_id: linha.lista_preco_id,
    disponivel_no_tamanho: linha.disponivel,
    estoque_disponivel: saldo.rows.reduce((acc, e) => acc + num(e.quantidade), 0),
  });
}

// ----------------------------------------------------------------------------
// VENDA — o servidor recalcula tudo
// ----------------------------------------------------------------------------

type LinhaPdv = {
  codigo?: string;
  produto_id?: number;
  tamanho_id: number | null;
  quantidade: number;
  desconto_pct: number;
  /** Preço digitado pelo operador. É uma EXCEÇÃO e fica registrada. */
  preco_manual: number | null;
};

function normalizarLinhas(bruto: unknown): LinhaPdv[] {
  if (!Array.isArray(bruto) || !bruto.length) {
    throw new HttpError(400, 'Envie as linhas da venda em `itens`.');
  }
  return bruto.map((raw, index) => {
    const linha = (raw || {}) as Record<string, unknown>;
    const quantidade = Number(linha.quantidade ?? linha.qtd ?? 1);
    if (!Number.isFinite(quantidade) || quantidade <= 0) {
      throw new HttpError(400, `Linha ${index + 1}: a quantidade deve ser maior que zero.`, { [`itens[${index}].quantidade`]: 'Deve ser > 0' });
    }
    let desconto = Number(linha.desconto_pct ?? 0);
    if (!Number.isFinite(desconto)) desconto = 0;
    if (desconto < 0 || desconto > 100) {
      throw new HttpError(400, `Linha ${index + 1}: desconto_pct deve estar entre 0 e 100.`, { [`itens[${index}].desconto_pct`]: 'Entre 0 e 100' });
    }
    return {
      codigo: linha.codigo ?? linha.sku ?? linha.codigo_barras ? String(linha.codigo ?? linha.sku ?? linha.codigo_barras) : undefined,
      produto_id: linha.produto_id ? Number(linha.produto_id) : undefined,
      tamanho_id: linha.tamanho_id === undefined || linha.tamanho_id === null || linha.tamanho_id === '' ? null : Number(linha.tamanho_id),
      quantidade: round2(quantidade),
      desconto_pct: round2(desconto),
      preco_manual: linha.preco_manual === undefined || linha.preco_manual === null || linha.preco_manual === '' ? null : Number(linha.preco_manual),
    };
  });
}

type PagamentoEntrada = { forma: string; valor: number; parcelas: number; nsu?: string | null; bandeira?: string | null };

function normalizarPagamentos(bruto: unknown): PagamentoEntrada[] {
  if (!Array.isArray(bruto)) throw new HttpError(400, 'pagamentos deve ser uma lista.', { pagamentos: 'Lista obrigatória' });
  return bruto.map((raw, index) => {
    const p = (raw || {}) as Record<string, unknown>;
    const forma = String(p.forma || '').toLowerCase();
    if (!FORMAS.includes(forma)) {
      throw new HttpError(400, `Pagamento ${index + 1}: forma "${forma}" não é aceita. Use ${FORMAS.join(', ')}.`, { [`pagamentos[${index}].forma`]: 'Inválida' });
    }
    const valor = round2(num(p.valor));
    if (!(valor > 0)) throw new HttpError(400, `Pagamento ${index + 1}: o valor deve ser maior que zero.`, { [`pagamentos[${index}].valor`]: 'Deve ser > 0' });
    const parcelas = Math.max(1, Math.trunc(num(p.parcelas, 1)));
    if (forma !== 'cartao_credito' && parcelas > 1) {
      throw new HttpError(400, `Pagamento ${index + 1}: só cartão de crédito aceita parcelamento.`, { [`pagamentos[${index}].parcelas`]: 'Apenas crédito' });
    }
    return { forma, valor, parcelas, nsu: p.nsu ? String(p.nsu).slice(0, 60) : null, bandeira: p.bandeira ? String(p.bandeira).slice(0, 30) : null };
  });
}

/**
 * POST /api/pdv/vendas
 *
 * Cria, paga e fatura a venda de balcão em UMA transação: pedido → estoque →
 * financeiro. Se qualquer parte falhar, nada fica pela metade.
 */
export async function venderPdv(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'create');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const body = (req.body || {}) as Record<string, unknown>;
  const linhas = normalizarLinhas(body.itens ?? body.linhas);
  const pagamentos = normalizarPagamentos(body.pagamentos);
  const faturar = body.faturar !== false;
  const s = getStore();

  try {
    const resultado = await s.transaction(async (tx) => {
      // ---- caixa aberto é pré-condição: sem ele o fechamento não fecha ----
      let caixa: Row | null = null;
      if (body.caixa_id) {
        caixa = assertRegistroDaEmpresa(R_CAIXA(), await s.get(R_CAIXA(), Number(body.caixa_id), tx), escopo);
      } else {
        caixa = await s.findOneWhere(R_CAIXA(), { empresa_id: escopo.empresaId, status: 'aberto' }, tx);
      }
      if (!caixa) {
        throw new HttpError(409, 'Nenhum caixa aberto. Abra o caixa antes de vender no PDV.');
      }
      if (String(caixa.status) !== 'aberto') throw new HttpError(409, `O caixa "${caixa.numero}" está fechado.`);

      // ---- cliente (opcional no PDV — consumidor final é a regra) ----
      let clienteId: number | null = null;
      if (body.cliente_id !== undefined && body.cliente_id !== null && body.cliente_id !== '') {
        clienteId = Number(body.cliente_id);
        assertRegistroDaEmpresa(getResource('clientes')!, await s.get(getResource('clientes')!, clienteId, tx), escopo);
      }
      let representanteId: number | null = null;
      if (body.representante_id !== undefined && body.representante_id !== null && body.representante_id !== '') {
        representanteId = Number(body.representante_id);
        assertRegistroDaEmpresa(getResource('representantes')!, await s.get(getResource('representantes')!, representanteId, tx), escopo);
      }

      // ---- 1) resolve cada linha: produto, TAMANHO, preço de lista, subtotal ----
      const resolvidas: { linha: LinhaPdv; info: LinhaResolvida; preco: number; subtotal: number }[] = [];
      let subtotalItens = 0;
      const divergencias: { linha: number; enviado: number | null; servidor: number }[] = [];
      for (let i = 0; i < linhas.length; i++) {
        const linha = linhas[i];
        const info = linha.codigo
          ? await resolverProduto(linha.codigo, escopo, tx, linha.tamanho_id)
          : await resolverProduto(String(linha.produto_id), escopo, tx, linha.tamanho_id);
        // O código lido tem que apontar para o produto informado. Aceitamos o
        // pai OU a própria variação: as duas formas de referir a mesma peça.
        if (linha.produto_id && Number(info.produto.id) !== linha.produto_id && Number(info.produto.produto_pai_id ?? 0) !== linha.produto_id) {
          throw new HttpError(400, `Linha ${i + 1}: o código lido aponta para o produto ${info.produto.sku}, não para o #${linha.produto_id}.`);
        }
        const precoServidor = info.preco;
        const precoManual = linha.preco_manual;
        const preco = precoManual !== null && Number.isFinite(precoManual) && precoManual >= 0 ? round2(precoManual) : precoServidor;
        if (precoManual !== null && round2(precoManual) !== precoServidor) {
          divergencias.push({ linha: i + 1, enviado: round2(precoManual), servidor: precoServidor });
        }
        const subtotal = round2(linha.quantidade * preco * (1 - linha.desconto_pct / 100));
        subtotalItens = round2(subtotalItens + subtotal);
        resolvidas.push({ linha, info, preco, subtotal });
      }

      // ---- 2) desconto e frete do cupom: números do servidor ----
      let descontoCupom = round2(Math.max(0, num(body.desconto)));
      if (subtotalItens > 0 && descontoCupom > subtotalItens) {
        throw new HttpError(400, `O desconto (${descontoCupom.toFixed(2)}) não pode ser maior que o subtotal (${subtotalItens.toFixed(2)}).`, { desconto: 'Maior que o subtotal' });
      }
      const descontoPctCupom = num(body.desconto_pct);
      if (descontoPctCupom > 0) {
        if (descontoPctCupom > 100) throw new HttpError(400, 'desconto_pct deve estar entre 0 e 100.', { desconto_pct: 'Entre 0 e 100' });
        descontoCupom = round2(descontoCupom + (subtotalItens * descontoPctCupom) / 100);
        if (descontoCupom > subtotalItens) descontoCupom = subtotalItens;
      }
      const frete = round2(Math.max(0, num(body.frete)));
      const total = round2(Math.max(0, subtotalItens - descontoCupom + frete));

      // ---- 3) pagamentos: o servidor confere se cobre o total ----
      const totalPago = round2(pagamentos.reduce((acc, p) => acc + p.valor, 0));
      const emDinheiro = round2(pagamentos.filter((p) => p.forma === 'dinheiro').reduce((acc, p) => acc + p.valor, 0));
      const emOutros = round2(totalPago - emDinheiro);
      if (totalPago < total - 0.009) {
        throw new HttpError(400, `Pagamento insuficiente: total ${total.toFixed(2)}, recebido ${totalPago.toFixed(2)}. Faltam ${(total - totalPago).toFixed(2)}.`, { pagamentos: 'Insuficiente' });
      }
      // Troco só faz sentido em dinheiro; nas demais formas, valor = total.
      if (emOutros > total - emDinheiro + 0.009 && emDinheiro === 0) {
        throw new HttpError(400, `Pagamento excede o total (${totalPago.toFixed(2)} > ${total.toFixed(2)}). Só dinheiro gera troco.`, { pagamentos: 'Excede o total' });
      }
      const troco = round2(Math.max(0, totalPago - total));

      // ---- 4) grava o pedido ----
      const localSaida = body.local_saida ? String(body.local_saida).slice(0, 60) : String(caixa.local || (await getDefaultLocal(tx)));
      const venda = await s.insert(
        getResource('vendas')!,
        {
          empresa_id: escopo.empresaId,
          cliente_id: clienteId,
          representante_id: representanteId,
          data: new Date().toISOString().slice(0, 10),
          status: 'aberta',
          canal_venda: 'pdv',
          pdv_caixa_id: Number(caixa.id),
          local_saida: localSaida,
          desconto: descontoCupom,
          frete,
          total,
          fin_forma_pagamento: pagamentos.length === 1 ? pagamentos[0].forma : 'outros',
          fin_parcelas: pagamentos.length === 1 ? pagamentos[0].parcelas : 1,
          fin_status: faturar ? 'recebido' : 'a_receber',
          fin_recebido_em: faturar ? new Date().toISOString().slice(0, 10) : null,
          observacoes: body.observacoes ? String(body.observacoes).slice(0, 2000) : null,
        },
        tx
      );

      for (const r of resolvidas) {
        await s.insert(
          getResource('itens_venda')!,
          {
            empresa_id: escopo.empresaId,
            venda_id: Number(venda.id),
            produto_id: Number(r.info.produto.id),
            // O tamanho RESOLVIDO (variação, informado ou único com estoque) —
            // nunca o que a tela mandou: é ele que o faturamento usa para achar
            // o saldo, e `itens_venda.tamanho_id` é obrigatório neste ERP.
            tamanho_id: r.info.tamanho_id ?? null,
            quantidade: r.linha.quantidade,
            preco_unitario: r.preco,
            desconto_pct: r.linha.desconto_pct,
            subtotal: r.subtotal,
            lista_preco_id: r.info.lista_preco_id,
            preco_tabela: r.info.preco_tabela,
          },
          tx
        );
      }

      for (const p of pagamentos) {
        await s.insert(
          R_PAGAMENTO(),
          { empresa_id: escopo.empresaId, venda_id: Number(venda.id), caixa_id: Number(caixa.id), forma: p.forma, valor: p.valor, parcelas: p.parcelas, nsu: p.nsu ?? null, bandeira: p.bandeira ?? null },
          tx
        );
      }

      // ---- 5) faturamento: estoque + comissão + financeiro ----
      let faturada: Row = venda;
      if (faturar) {
        const patch = { status: 'faturada' };
        faturada = (await s.tryUpdateIf(getResource('vendas')!, Number(venda.id), { status: 'aberta' }, patch, tx)) || venda;
        await aplicarRegrasPedido('venda', venda, faturada, patch, { id: actor.id || null, name: actor.name }, tx);
        const depois = (await s.get(getResource('vendas')!, Number(venda.id), tx)) || faturada;
        await syncLancamentoVenda(venda, depois, patch, { id: actor.id || null, name: actor.name }, tx);
        faturada = depois;
      }

      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'criar',
          recurso: 'vendas',
          registro_id: Number(venda.id),
          descricao: `Venda PDV #${venda.id} — ${resolvidas.length} item(ns), total ${total.toFixed(2)}, pago ${totalPago.toFixed(2)}${troco ? `, troco ${troco.toFixed(2)}` : ''}`,
          dados: { caixa_id: caixa.id, subtotal_itens: subtotalItens, desconto: descontoCupom, frete, total, total_pago: totalPago, troco, divergencias, faturada: faturar },
        },
        tx
      );

      return { venda: faturada, subtotalItens, descontoCupom, frete, total, totalPago, troco, divergencias, caixa, resolvidas, faturar };
    }, { isolation: 'serializable' });

    res.status(201).json({
      ok: true,
      venda_id: Number(resultado.venda.id),
      venda: resultado.venda,
      caixa: { id: resultado.caixa.id, numero: resultado.caixa.numero },
      // O servidor manda de volta a conta que ELE fez — é esta que vale.
      calculo: {
        subtotal_itens: resultado.subtotalItens,
        desconto: resultado.descontoCupom,
        frete: resultado.frete,
        total: resultado.total,
        total_pago: resultado.totalPago,
        troco: resultado.troco,
      },
      itens: resultado.resolvidas.map((r, i) => ({
        linha: i + 1,
        produto_id: Number(r.info.produto.id),
        sku: r.info.sku,
        sku_produto: r.info.produto.sku,
        nome: r.info.produto.nome,
        tamanho_id: r.info.tamanho_id,
        tamanho: r.info.tamanho_codigo,
        eh_variacao: r.info.eh_variacao,
        quantidade: r.linha.quantidade,
        preco_unitario: r.preco,
        desconto_pct: r.linha.desconto_pct,
        subtotal: r.subtotal,
        preco_tabela: r.info.preco_tabela,
        disponivel_antes: r.info.disponivel,
        origem_preco: r.info.lista_nome ? `Lista: ${r.info.lista_nome}` : 'Ficha do produto',
      })),
      // Se o operador digitou um preço diferente, o servidor mostra a diferença
      // em vez de aceitá-la em silêncio.
      divergencias_de_preco: resultado.divergencias,
      // A NFC-e é um ato separado: tem a própria máquina de estados e não pode
      // ser engolida pela transação da venda.
      fiscal: {
        elegivel: resultado.faturar,
        modelo: '65',
        endpoint: `/api/vendas/${resultado.venda.id}/fiscal/emitir`,
        mensagem: 'Para emitir a NFC-e, chame o endpoint acima. A venda já está gravada e faturada independentemente da emissão.',
      },
    });
  } catch (e) {
    throw toHttpError(e, getResource('vendas')!);
  }
}

/**
 * POST /api/pdv/vendas/:id/cancelar — cancelamento controlado.
 *
 * Controlado significa: motivo obrigatório, auditoria, e recusa quando a venda
 * já tem documento fiscal autorizado (aí o caminho é o cancelamento da nota,
 * não o sumiço da venda).
 */
export async function cancelarVendaPdv(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'update');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const id = parseId(req.params.id);
  const motivo = String((req.body || {}).motivo || '').trim();
  if (motivo.length < 5) {
    throw new HttpError(400, 'Informe o motivo do cancelamento (mínimo 5 caracteres).', { motivo: 'Mínimo 5 caracteres' });
  }
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const venda = assertRegistroDaEmpresa(getResource('vendas')!, await s.get(getResource('vendas')!, id, tx), escopo);
      if (String(venda.status) === 'cancelada') throw new HttpError(409, 'Esta venda já está cancelada.');
      const docVivo = await s.list(
        getResource('documentos_fiscais')!,
        { page: 1, pageSize: 5, filter: { venda_id: id, status: 'autorizado' } },
        tx
      );
      if (docVivo.rows.length) {
        throw new HttpError(
          409,
          `Esta venda tem documento fiscal autorizado (nº ${docVivo.rows[0].numero}, chave ${docVivo.rows[0].chave_acesso}). Cancele a nota antes de cancelar a venda.`,
          { documento_fiscal_id: docVivo.rows[0].id }
        );
      }
      const antes = venda;
      const cancelada = await s.tryUpdateIf(getResource('vendas')!, id, { status: venda.status }, { status: 'cancelada' }, tx);
      if (!cancelada) throw new HttpError(409, 'A venda mudou durante o cancelamento. Recarregue e tente de novo.');
      // Estorno de estoque + financeiro pelo MESMO caminho do pedido de balcão.
      await aplicarRegrasPedido('venda', antes, cancelada, { status: 'cancelada' }, { id: actor.id || null, name: actor.name }, tx);
      const depois = (await s.get(getResource('vendas')!, id, tx)) || cancelada;
      await syncLancamentoVenda(antes, depois, { status: 'cancelada' }, { id: actor.id || null, name: actor.name }, tx);
      await s.audit(
        { usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'vendas', registro_id: id, descricao: `Venda PDV #${id} cancelada — motivo: ${motivo}`, dados: { motivo, caixa_id: antes.pdv_caixa_id ?? null } },
        tx
      );
      return depois;
    }, { isolation: 'serializable' });
    res.json({ ok: true, venda: out, mensagem: 'Venda cancelada, estoque estornado e financeiro revertido.' });
  } catch (e) {
    throw toHttpError(e, getResource('vendas')!);
  }
}

/** GET /api/pdv/vendas/:id/pagamentos */
export async function pagamentosVenda(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const id = parseId(req.params.id);
  const s = getStore();
  assertRegistroDaEmpresa(getResource('vendas')!, await s.get(getResource('vendas')!, id), escopo);
  const out = await s.list(R_PAGAMENTO(), { page: 1, pageSize: 100, filter: { venda_id: id }, sort: 'id', dir: 'asc' });
  res.json(out.rows);
}

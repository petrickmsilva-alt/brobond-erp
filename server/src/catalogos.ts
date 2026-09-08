// ============================================================
// Fase 7 — Catálogo público somente leitura.
//
//   GET /api/publico/catalogo/:token   (rate limit; fora do login)
//
// Devolve produtos com foto, nome, SKU, cor, tamanhos (saldo opcional) e
// preço (opcional), conforme a configuração do catálogo. As imagens já são
// públicas por token (/api/files/:id/:token), então funcionam no link.
// ============================================================
import type { Request, Response } from 'express';
import { createRequire } from 'node:module';
import { HttpError } from './errors';
import { getResource, RESOURCES } from './resources';
import { getStore, toHttpError } from './services';
import type { Row } from './store';
import { labelOf } from './store';
import { attachImages } from './uploads';
import { recalcularTotal } from './itens';

const require = createRequire(import.meta.url);

// Limpeza simples de rate limit por IP (catálogo público).
const LIMITE = Number(process.env.CATALOGO_LIMIT) || 240; // por janela
const JANELA_MS = 10 * 60 * 1000;
const ips = new Map<string, { count: number; desde: number }>();

export function rateLimitPublico(req: Request, res: Response, next: () => void) {
  const ip = String(req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.socket.remoteAddress || '?');
  const agora = Date.now();
  let b = ips.get(ip);
  if (!b || agora - b.desde > JANELA_MS) b = { count: 0, desde: agora };
  b.count++;
  if (b.count > LIMITE) {
    res.setHeader('Retry-After', String(Math.ceil((JANELA_MS - (agora - b.desde)) / 1000)));
    return res.status(429).json({ error: 'Muitas solicitações. Tente novamente em alguns minutos.' });
  }
  ips.set(ip, b);
  if (ips.size > 5000) for (const [k, v] of ips) if (agora - v.desde > JANELA_MS) ips.delete(k);
  next();
}

function ehMesmaSenha(senhaFornecida: string | undefined, hash: string | null | undefined): boolean {
  if (!hash) return true;
  if (!senhaFornecida) return false;
  const bcrypt = requireBcrypt();
  try {
    return bcrypt.compareSync(senhaFornecida, hash);
  } catch {
    return false;
  }
}

let _bcrypt: any = null;
function requireBcrypt(): any {
  if (!_bcrypt) {
    _bcrypt = require('bcryptjs');
  }
  return _bcrypt;
}

/** Coleção/categoria: colunas do cadastro, com fallback no JSONB `filtros` de versões antigas. */
export function filtrosDoCatalogo(catalogo: Row): { colecao_id?: number; categoria_id?: number } {
  const json =
    catalogo.filtros && typeof catalogo.filtros === 'object' && !Array.isArray(catalogo.filtros)
      ? (catalogo.filtros as Record<string, unknown>)
      : {};
  const pick = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  const colecao_id = pick(catalogo.colecao_id) ?? pick(json.colecao_id);
  const categoria_id = pick(catalogo.categoria_id) ?? pick(json.categoria_id);
  return {
    ...(colecao_id ? { colecao_id } : {}),
    ...(categoria_id ? { categoria_id } : {}),
  };
}

export async function catalogoPublico(req: Request, res: Response) {
  const token = String(req.params.token || '').trim();
  if (!token || !/^[a-f0-9]{12,}$/i.test(token)) throw new HttpError(404, 'Catálogo não encontrado.');
  const s = getStore();
  const catalogo = await s.findOneWhere(RESOURCES.catalogos, { token });
  if (!catalogo || catalogo.ativo === false) throw new HttpError(404, 'Catálogo não encontrado.');
  if (catalogo.expira_em && new Date(String(catalogo.expira_em)).getTime() < Date.now()) {
    throw new HttpError(404, 'Este catálogo expirou. Fale com quem o enviou.');
  }
  if (catalogo.senha_hash && !ehMesmaSenha(typeof req.query.senha === 'string' ? req.query.senha : undefined, catalogo.senha_hash)) {
    return res.status(401).json({ error: 'senha_necessaria', mensagem: 'Este catálogo é protegido por senha.' });
  }

  const filtros = filtrosDoCatalogo(catalogo);
  const filter: Record<string, unknown> = {};
  if (filtros.colecao_id) filter.colecao_id = filtros.colecao_id;
  if (filtros.categoria_id) filter.categoria_id = filtros.categoria_id;

  const [produtos, estoques, tamanhos] = await Promise.all([
    s.list(RESOURCES.produtos, { page: 1, pageSize: 2000, filter, sort: 'nome', dir: 'asc' }),
    s.list(RESOURCES.estoques, { page: 1, pageSize: 6000 }),
    s.list(RESOURCES.tamanhos, { page: 1, pageSize: 200, sort: 'ordem', dir: 'asc' }),
  ]);
  await attachImages(RESOURCES.produtos, produtos.rows);
  const tamCodigo = new Map(tamanhos.rows.map((t) => [Number(t.id), String(t.codigo || '')]));

  const mostrarPreco = catalogo.mostrar_preco !== false;
  const mostrarSaldo = catalogo.mostrar_saldo === true;
  const mostrarMedidas = catalogo.mostrar_medidas === true;

  // Tabela de medidas (bulk): resolve a grade de cada produto e monta a tabela.
  let medidasPorGrade: Map<number, { medidas: { id: number; nome: string; unidade: string }[]; linhas: { tamanho_id: number; codigo: string; valores: Record<string, number | null> }[] }> = new Map();
  let gradePorProduto: Map<number, number> = new Map();
  if (mostrarMedidas) {
    const [categorias, gradeTamanhos, medidas, valores] = await Promise.all([
      s.list(RESOURCES.categorias, { page: 1, pageSize: 2000 }),
      s.list(RESOURCES.grade_tamanhos, { page: 1, pageSize: 10000, sort: 'ordem', dir: 'asc' }),
      s.list(RESOURCES.medidas, { page: 1, pageSize: 5000, sort: 'ordem', dir: 'asc' }),
      s.list(RESOURCES.medida_valores, { page: 1, pageSize: 20000 }),
    ]);
    const gradePorCategoria = new Map(categorias.rows.map((c) => [Number(c.id), Number(c.grade_id) || 0]));
    const tamsPorGrade = new Map<number, number[]>();
    for (const it of gradeTamanhos.rows) {
      const g = Number(it.grade_id);
      if (!tamsPorGrade.has(g)) tamsPorGrade.set(g, []);
      tamsPorGrade.get(g)!.push(Number(it.tamanho_id));
    }
    const medidasPorGradeRaw = new Map<number, { id: number; nome: string; unidade: string }[]>();
    for (const m of medidas.rows) {
      const g = Number(m.grade_id);
      if (!medidasPorGradeRaw.has(g)) medidasPorGradeRaw.set(g, []);
      medidasPorGradeRaw.get(g)!.push({ id: Number(m.id), nome: String(m.nome), unidade: String(m.unidade || 'cm') });
    }
    const valorPor = new Map<string, number | null>();
    for (const v of valores.rows) {
      valorPor.set(`${v.medida_id}:${v.tamanho_id}`, v.valor === null || v.valor === undefined ? null : Number(v.valor));
    }
    for (const [g, meds] of medidasPorGradeRaw) {
      const linhas = (tamsPorGrade.get(g) ?? []).map((tid) => {
        const valoresLinha: Record<string, number | null> = {};
        for (const m of meds) valoresLinha[String(m.id)] = valorPor.get(`${m.id}:${tid}`) ?? null;
        return { tamanho_id: tid, codigo: tamCodigo.get(tid) ?? `#${tid}`, valores: valoresLinha };
      });
      medidasPorGrade.set(g, { medidas: meds, linhas });
    }
    for (const p of produtos.rows) {
      const g = Number(p.grade_id) || gradePorCategoria.get(Number(p.categoria_id)) || 0;
      if (g) gradePorProduto.set(Number(p.id), g);
    }
  }
  const canal = String(catalogo.canal || 'todos');
  const tabelaPreco = String(catalogo.tabela_preco || 'automatico');

  // Preço exibido no catálogo: varejo, atacado, ambos ou automático conforme canal.
  function precoDoProduto(p: Row): { preco: number | null; preco_tipo: 'varejo' | 'atacado' | null; preco_venda: number | null; preco_atacado: number | null } {
    const varejo = Number(p.preco_venda || 0);
    const atacado = Number(p.preco_atacado || p.preco_venda || 0);
    if (!mostrarPreco) return { preco: null, preco_tipo: null, preco_venda: null, preco_atacado: null };
    let tipo: 'varejo' | 'atacado';
    if (tabelaPreco === 'ambos') tipo = 'varejo';
    else if (tabelaPreco === 'varejo') tipo = 'varejo';
    else if (tabelaPreco === 'atacado') tipo = 'atacado';
    else tipo = canal === 'atacado' ? 'atacado' : 'varejo';
    const preco = tipo === 'atacado' ? atacado : varejo;
    return {
      preco,
      preco_tipo: tabelaPreco === 'ambos' ? null : tipo,
      preco_venda: tabelaPreco === 'ambos' || tabelaPreco === 'varejo' || tabelaPreco === 'automatico' ? varejo : null,
      preco_atacado: tabelaPreco === 'ambos' || tabelaPreco === 'atacado' || (tabelaPreco === 'automatico' && canal === 'atacado') ? atacado : null,
    };
  }

  const lista: Row[] = produtos.rows.map((p) => {
    const doProduto = estoques.rows.filter((e) => Number(e.produto_id) === Number(p.id));
    // Sempre devolve os tamanhos com saldo para o cliente selecionar. A
    // quantidade só aparece quando `mostrar_saldo` está habilitado.
    const tamanhosLinha = [...new Set(doProduto.map((e) => Number(e.tamanho_id)))]
      .map((tid) => ({
        tamanho_id: tid,
        codigo: tamCodigo.get(tid) || '',
        quantidade: doProduto.filter((e) => Number(e.tamanho_id) === tid).reduce((a, e) => a + Number(e.quantidade || 0), 0),
      }))
      .filter((t) => t.quantidade > 0)
      .sort((a, b) => (a.codigo < b.codigo ? -1 : 1));
    const precos = precoDoProduto(p);
    return {
      id: Number(p.id),
      sku: p.sku,
      nome: p.nome,
      cor: p.cor_id__label ?? p.cor ?? null,
      cor_hex: p.cor_id__color ?? null,
      composicao: p.composicao ?? null,
      descricao: p.descricao ?? null,
      preco: precos.preco,
      preco_tipo: precos.preco_tipo,
      preco_venda: precos.preco_venda,
      preco_atacado: precos.preco_atacado,
      disponivel_site: p.exibir_site !== false && p.ativo !== false,
      foto_url: p.foto_url ?? null,
      fotos: (p.fotos || []).map((f: any) => ({ url: f.url, thumb_url: f.thumb_url })),
      tamanhos: tamanhosLinha,
      medidas: mostrarMedidas ? medidasPorGrade.get(gradePorProduto.get(Number(p.id)) ?? 0) ?? null : null,
    };
  });

  res.json({
    nome: catalogo.nome,
    canal,
    tabela_preco: tabelaPreco,
    aceita_pedido_site: catalogo.aceita_pedido_site !== false,
    como_comprar: catalogo.como_comprar ?? null,
    mostrar_preco: mostrarPreco,
    mostrar_saldo: mostrarSaldo,
    mostrar_medidas: mostrarMedidas,
    total: lista.length,
    produtos: lista,
  });
}

// ----------------------------------------------------------------------------
// PEDIDO PELO CATÁLOGO — recebe um carrinho público e cria uma COTAÇÃO no ERP.
// Sem login: o catálogo é somente leitura, mas pode gerar um pedido de venda
// com status "cotacao" para o time aprovar e faturar (e linkar no financeiro).
// ----------------------------------------------------------------------------
export async function criarPedidoCatalogo(req: Request, res: Response) {
  const token = String(req.params.token || '').trim();
  if (!token || !/^[a-f0-9]{12,}$/i.test(token)) throw new HttpError(404, 'Catálogo não encontrado.');
  const s = getStore();
  const catalogo = await s.findOneWhere(RESOURCES.catalogos, { token });
  if (!catalogo || catalogo.ativo === false) throw new HttpError(404, 'Catálogo não encontrado.');
  if (catalogo.aceita_pedido_site === false) throw new HttpError(403, 'Este catálogo não aceita pedidos pelo site.');
  if (catalogo.expira_em && new Date(String(catalogo.expira_em)).getTime() < Date.now()) throw new HttpError(404, 'Este catálogo expirou.');

  const body = req.body || {};
  if (catalogo.senha_hash && !ehMesmaSenha(typeof body.senha === 'string' ? body.senha : undefined, catalogo.senha_hash)) {
    throw new HttpError(401, 'senha_necessaria');
  }
  const nome = String(body.nome || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const telefone = String(body.telefone || '').trim();
  const canal = ['atacado', 'varejo'].includes(String(body.canal || '')) ? String(body.canal) : 'varejo';
  const itens = Array.isArray(body.itens) ? body.itens : [];
  if (!nome) throw new HttpError(400, 'Informe o nome do cliente.', { nome: 'Campo obrigatório' });
  if (!itens.length) throw new HttpError(400, 'Adicione ao menos um item ao pedido.');

  const filtros = filtrosDoCatalogo(catalogo);
  const filter: Record<string, unknown> = {};
  if (filtros.colecao_id) filter.colecao_id = filtros.colecao_id;
  if (filtros.categoria_id) filter.categoria_id = filtros.categoria_id;
  const [produtosR, tamanhosR, estoquesR] = await Promise.all([
    s.list(RESOURCES.produtos, { page: 1, pageSize: 2000, filter }),
    s.list(RESOURCES.tamanhos, { page: 1, pageSize: 200 }),
    s.list(RESOURCES.estoques, { page: 1, pageSize: 10000 }),
  ]);
  const produtoPorId = new Map<number, Row>(produtosR.rows.map((p) => [Number(p.id), p]));
  const tamanhoPorId = new Map<number, Row>(tamanhosR.rows.map((t) => [Number(t.id), t]));

  try {
    const pedido = await s.transaction(async (tx) => {
      const clientesR = RESOURCES.clientes;
      let cliente = email ? await s.findOneWhere(clientesR, { email }, tx) : null;
      if (!cliente) {
        cliente = await s.findOneWhere(clientesR, { nome }, tx);
      }
      if (!cliente) {
        cliente = await s.insert(clientesR, {
          nome,
          email: email || null,
          cnpj_cpf: body.cnpj_cpf ?? null,
          telefone: telefone || null,
          tipo: canal === 'atacado' ? 'atacadista' : 'varejo',
          ativo: true,
        }, tx);
      } else if (!cliente.email && email) {
        await s.update(clientesR, Number(cliente.id), { email, telefone: telefone || cliente.telefone || null }, tx);
        cliente = await s.get(clientesR, Number(cliente.id), tx) ?? cliente;
      }

      const vendaR = RESOURCES.vendas;
      const venda = await s.insert(vendaR, {
        cliente_id: Number(cliente.id),
        data: new Date().toISOString().slice(0, 10),
        status: 'cotacao',
        canal_venda: canal === 'atacado' ? 'site_atacado' : 'site_varejo',
        condicao_pagamento: 'Pendente',
        fin_status: 'a_receber',
        observacoes: [
          body.observacoes ? String(body.observacoes).trim() : null,
          `Pedido gerado pelo catálogo público "${catalogo.nome}"`,
          telefone ? `Contato: ${telefone}` : null,
          email ? `E-mail: ${email}` : null,
        ].filter(Boolean).join('\n'),
      }, tx);

      const itensR = RESOURCES.itens_venda;
      let subtotal = 0;
      for (const raw of itens) {
        const produtoId = Number(raw.produto_id);
        let tamanhoId = Number(raw.tamanho_id);
        const quantidade = Number(raw.quantidade);
        const produto = produtoPorId.get(produtoId);
        if (!produto || !Number.isInteger(quantidade) || quantidade <= 0) {
          throw new HttpError(400, 'Há um item inválido no pedido. Atualize a página e tente novamente.');
        }
        // Se o cliente não selecionou tamanho, usa o primeiro com saldo (fallback).
        if (!Number.isInteger(tamanhoId) || tamanhoId <= 0) {
          const comSaldo = estoquesR.rows.find((e) => Number(e.produto_id) === produtoId && Number(e.quantidade) > 0);
          tamanhoId = comSaldo ? Number(comSaldo.tamanho_id) : Number(tamanhoPorId.keys().next().value);
        }
        const tamanho = tamanhoPorId.get(tamanhoId);
        if (!tamanho) {
          throw new HttpError(400, 'Selecione um tamanho válido para o pedido.');
        }
        if (produto.exibir_site === false || produto.ativo === false) {
          throw new HttpError(400, `O produto "${labelOf(RESOURCES.produtos, produto)}" não está disponível para pedido pelo site.`);
        }
        const preco = Number(canal === 'atacado' ? (produto.preco_atacado || produto.preco_venda || 0) : produto.preco_venda || 0);
        const sub = Math.round(quantidade * preco * 100) / 100;
        subtotal += sub;
        await s.insert(itensR, {
          venda_id: Number(venda.id),
          produto_id: produtoId,
          tamanho_id: tamanhoId,
          quantidade,
          preco_unitario: preco,
          desconto_pct: 0,
          subtotal: sub,
        }, tx);
      }
      const total = await recalcularTotal('venda', Number(venda.id), tx);
      await s.audit(
        {
          usuario_id: null,
          usuario: 'Catálogo público',
          acao: 'criar',
          recurso: 'vendas',
          registro_id: Number(venda.id),
          descricao: `Cotação recebida pelo catálogo "${catalogo.nome}" — ${itens.length} item(ns), ${nome}`,
          dados: { canal, total, subtotal },
        },
        tx
      );
      return { venda: await s.get(vendaR, Number(venda.id), tx) ?? venda, total };
    });
    res.status(201).json({ ok: true, mensagem: 'Pedido recebido! Nossa equipe vai confirmar disponibilidade e valores com você.', pedido_id: Number(pedido.venda.id), total: pedido.total });
  } catch (e) {
    throw toHttpError(e, RESOURCES.vendas);
  }
}

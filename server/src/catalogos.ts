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
import QRCode from 'qrcode';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from './errors';
import { getResource, RESOURCES } from './resources';
import { checkAccess, exigirComercial, getStore, toHttpError , storeDoAtor } from './services';
import { currentUser } from './auth';
import { parseId } from './validate';
import type { Row } from './store';
import { labelOf } from './store';
import { attachImages } from './uploads';
import { recalcularTotal } from './itens';
import { montarTabelaMedidas, tsIso } from './medidas';
import type { TabelaMedidas } from './medidas';
import { criarAcessoPortal } from './portal';
import { urlBasePublicaAsync } from './urlPublica';
import { urlLoja } from './loja';
import { precoComPolitica, resolverPoliticaComercial } from './politicasComerciais';

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


export function hashTokenPublico(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function resolverTokenCatalogo(token: string): Promise<{ catalogo: Row | null; compartilhamento: Row | null }> {
  // ACESSO PÚBLICO POR TOKEN: quem chama aqui não tem sessão (o cliente da
  // loja abre o link). O recorte é o próprio token secreto — não há empresa
  // ativa para filtrar, e é por isso que este caminho usa o store CRU.
  const s = getStore();
  const direto = await s.findOneWhere(RESOURCES.catalogos, { token });
  if (direto) return { catalogo: direto, compartilhamento: null };
  const compartilhamento = await s.findOneWhere(RESOURCES.catalogo_compartilhamentos, { token_hash: hashTokenPublico(token) });
  if (!compartilhamento || compartilhamento.revogado_em || (compartilhamento.expira_em && new Date(String(compartilhamento.expira_em)).getTime() < Date.now())) {
    return { catalogo: null, compartilhamento: null };
  }
  return { catalogo: await s.get(RESOURCES.catalogos, Number(compartilhamento.catalogo_id)), compartilhamento };
}

export async function catalogoPublico(req: Request, res: Response) {
  const token = String(req.params.token || '').trim();
  if (!token || !/^[a-f0-9]{12,}$/i.test(token)) throw new HttpError(404, 'Catálogo não encontrado.');
  const s = storeDoAtor(currentUser(req));
  const resolvido = await resolverTokenCatalogo(token);
  const catalogo = resolvido.catalogo;
  if (!catalogo || catalogo.ativo === false) throw new HttpError(404, 'Catálogo não encontrado.');
  if (catalogo.expira_em && new Date(String(catalogo.expira_em)).getTime() < Date.now()) {
    throw new HttpError(404, 'Este catálogo expirou. Fale com quem o enviou.');
  }
  if (catalogo.senha_hash && !ehMesmaSenha(typeof req.headers['x-catalogo-senha'] === 'string'
      ? req.headers['x-catalogo-senha']
      : typeof req.query.senha === 'string'
        ? req.query.senha
        : undefined, catalogo.senha_hash)) {
    return res.status(401).json({ error: 'senha_necessaria', mensagem: 'Este catálogo é protegido por senha.' });
  }

  if (resolvido.compartilhamento) {
    const c = resolvido.compartilhamento;
    const agora = new Date().toISOString();
    await s.update(RESOURCES.catalogo_compartilhamentos, Number(c.id), {
      primeiro_acesso_em: c.primeiro_acesso_em || agora,
      ultimo_acesso_em: agora,
      acessos: Number(c.acessos || 0) + 1,
    });
    await s.insert(RESOURCES.catalogo_eventos, {
      compartilhamento_id: Number(c.id), catalogo_id: Number(catalogo.id), tipo: 'abertura', dados: {},
    });
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

  // Tabela de medidas (bulk): resolve a grade de cada produto e monta a tabela
  // com o MESMO builder do módulo (medidas.ts), garantindo unidade, instruções
  // de medição e "atualizada em" idênticos em toda a exposição ao cliente.
  const medidasPorGrade: Map<number, TabelaMedidas> = new Map();
  const gradePorProduto: Map<number, number> = new Map();
  if (mostrarMedidas) {
    const [categorias, grades, gradeTamanhos, medidas, valores] = await Promise.all([
      s.list(RESOURCES.categorias, { page: 1, pageSize: 2000 }),
      s.list(RESOURCES.grades, { page: 1, pageSize: 2000 }),
      s.list(RESOURCES.grade_tamanhos, { page: 1, pageSize: 10000, sort: 'ordem', dir: 'asc' }),
      s.list(RESOURCES.medidas, { page: 1, pageSize: 5000, sort: 'ordem', dir: 'asc' }),
      s.list(RESOURCES.medida_valores, { page: 1, pageSize: 20000 }),
    ]);
    const gradePorCategoria = new Map(categorias.rows.map((c) => [Number(c.id), Number(c.grade_id) || 0]));
    const gradePorId = new Map(grades.rows.map((g) => [Number(g.id), g]));
    const tamsPorGrade = new Map<number, number[]>();
    for (const it of gradeTamanhos.rows) {
      const g = Number(it.grade_id);
      if (!tamsPorGrade.has(g)) tamsPorGrade.set(g, []);
      tamsPorGrade.get(g)!.push(Number(it.tamanho_id));
    }
    const medidasPorGradeRaw = new Map<number, { id: number; nome: string; unidade: string }[]>();
    const datasColunasPorGrade = new Map<number, string[]>();
    const gradeDaMedida = new Map<number, number>();
    for (const m of medidas.rows) {
      const g = Number(m.grade_id);
      if (!medidasPorGradeRaw.has(g)) medidasPorGradeRaw.set(g, []);
      medidasPorGradeRaw.get(g)!.push({ id: Number(m.id), nome: String(m.nome), unidade: String(m.unidade || 'cm') });
      const t = tsIso(m.atualizado_em);
      if (t) {
        if (!datasColunasPorGrade.has(g)) datasColunasPorGrade.set(g, []);
        datasColunasPorGrade.get(g)!.push(t);
      }
      gradeDaMedida.set(Number(m.id), g);
    }
    const valorPor = new Map<string, number | null>();
    const datasPorGrade = new Map<number, string[]>();
    for (const v of valores.rows) {
      if (v.valor === null || v.valor === undefined) continue;
      valorPor.set(`${v.medida_id}:${v.tamanho_id}`, Number(v.valor));
      const t = tsIso(v.atualizado_em);
      if (t) {
        const g = gradeDaMedida.get(Number(v.medida_id));
        if (g) {
          if (!datasPorGrade.has(g)) datasPorGrade.set(g, []);
          datasPorGrade.get(g)!.push(t);
        }
      }
    }
    for (const [g, meds] of medidasPorGradeRaw) {
      const gradeRow = gradePorId.get(g);
      const datas = [...(datasColunasPorGrade.get(g) ?? []), ...(datasPorGrade.get(g) ?? [])];
      const tamanhoObjs = (tamsPorGrade.get(g) ?? []).map((tid) => ({
        tamanho_id: tid,
        codigo: tamCodigo.get(tid) ?? `#${tid}`,
      }));
      const instrucoes = String(gradeRow?.instrucoes_medidas || '').trim() || null;
      medidasPorGrade.set(g, montarTabelaMedidas(meds, tamanhoObjs, valorPor, { instrucoes, datas }));
    }
    for (const p of produtos.rows) {
      const g = Number(p.grade_id) || gradePorCategoria.get(Number(p.categoria_id)) || 0;
      if (g) gradePorProduto.set(Number(p.id), g);
    }
  }
  const canal = String(catalogo.canal || 'todos');
  const tabelaPreco = String(catalogo.tabela_preco || 'automatico');
  const politica = await resolverPoliticaComercial({ catalogo, clienteId: Number(resolvido.compartilhamento?.cliente_id) || null, canal: canal === 'atacado' ? 'atacado' : 'varejo' });

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
    const preco = precoComPolitica(tipo === 'atacado' ? atacado : varejo, politica);
    return {
      preco,
      preco_tipo: tabelaPreco === 'ambos' ? null : tipo,
      preco_venda: tabelaPreco === 'ambos' || tabelaPreco === 'varejo' || tabelaPreco === 'automatico' ? precoComPolitica(varejo, politica) : null,
      preco_atacado: tabelaPreco === 'ambos' || tabelaPreco === 'atacado' || (tabelaPreco === 'automatico' && canal === 'atacado') ? precoComPolitica(atacado, politica) : null,
    };
  }

  const lista: Row[] = produtos.rows
    .filter((p) => p.exibir_site !== false && p.ativo !== false)
    .map((p) => {
    const doProduto = estoques.rows.filter((e) => Number(e.produto_id) === Number(p.id));
    // Sempre devolve os tamanhos com saldo para o cliente selecionar. A
    // quantidade só aparece quando `mostrar_saldo` está habilitado.
    const tamanhosLinha = [...new Set(doProduto.map((e) => Number(e.tamanho_id)))]
      .map((tid) => ({
        tamanho_id: tid,
        codigo: tamCodigo.get(tid) || '',
        quantidade_real: doProduto.filter((e) => Number(e.tamanho_id) === tid).reduce((a, e) => a + Number(e.quantidade || 0), 0),
      }))
      .filter((t) => t.quantidade_real > 0)
      .sort((a, b) => {
        const ai = tamanhos.rows.findIndex((x) => Number(x.id) === a.tamanho_id);
        const bi = tamanhos.rows.findIndex((x) => Number(x.id) === b.tamanho_id);
        return ai - bi;
      })
      .map((t) => ({ tamanho_id: t.tamanho_id, codigo: t.codigo, quantidade: mostrarSaldo ? t.quantidade_real : null }));
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
    compartilhamento: resolvido.compartilhamento ? { individual: true, cliente_id: resolvido.compartilhamento.cliente_id ?? null } : null,
    canal,
    tabela_preco: tabelaPreco,
    aceita_pedido_site: catalogo.aceita_pedido_site !== false,
    como_comprar: catalogo.como_comprar ?? null,
    mostrar_preco: mostrarPreco,
    mostrar_saldo: mostrarSaldo,
    mostrar_medidas: mostrarMedidas,
    politica_comercial: politica,
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
  const s = storeDoAtor(currentUser(req));
  const resolvido = await resolverTokenCatalogo(token);
  const catalogo = resolvido.catalogo;
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
  const canalCatalogo = String(catalogo.canal || 'todos');
  const canal = canalCatalogo === 'atacado' ? 'atacado' : canalCatalogo === 'varejo' ? 'varejo' : (body.canal === 'atacado' ? 'atacado' : 'varejo');
  const politica = await resolverPoliticaComercial({ catalogo, clienteId: Number(resolvido.compartilhamento?.cliente_id) || null, canal });
  const itens = Array.isArray(body.itens) ? body.itens : [];
  if (!nome) throw new HttpError(400, 'Informe o nome do cliente.', { nome: 'Campo obrigatório' });
  if (!itens.length) throw new HttpError(400, 'Adicione ao menos um item ao pedido.');
  if (itens.length > 100) throw new HttpError(400, 'O pedido excede o limite de 100 itens.');
  const chaves = new Set<string>();
  for (const item of itens) {
    const chave = `${Number(item?.produto_id)}:${Number(item?.tamanho_id)}`;
    if (chaves.has(chave)) throw new HttpError(400, 'Há itens duplicados no pedido. Atualize o catálogo e tente novamente.');
    chaves.add(chave);
  }

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
        if (!produto || !Number.isInteger(quantidade) || quantidade <= 0 || quantidade > 9999) {
          throw new HttpError(400, 'Há um item inválido no pedido. Atualize a página e tente novamente.');
        }
        if (politica?.produto_min_qtd && quantidade < politica.produto_min_qtd) throw new HttpError(400, `A política “${politica.nome}” exige ao menos ${politica.produto_min_qtd} peça(s) por item.`);
        if (politica && quantidade % politica.multiplo_qtd !== 0) throw new HttpError(400, `A política “${politica.nome}” exige quantidades múltiplas de ${politica.multiplo_qtd}.`);
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
        const precoBase = Number(canal === 'atacado' ? (produto.preco_atacado || produto.preco_venda || 0) : produto.preco_venda || 0);
        const preco = precoComPolitica(precoBase, politica);
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
      const totalPecas = itens.reduce((n: number, x: any) => n + Number(x.quantidade || 0), 0);
      if (politica?.pedido_min_pecas && totalPecas < politica.pedido_min_pecas) throw new HttpError(400, `A política “${politica.nome}” exige pedido mínimo de ${politica.pedido_min_pecas} peças.`);
      if (politica?.pedido_min_valor && subtotal < politica.pedido_min_valor) throw new HttpError(400, `A política “${politica.nome}” exige pedido mínimo de R$ ${politica.pedido_min_valor.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}.`);
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
    if (resolvido.compartilhamento) await s.insert(RESOURCES.catalogo_eventos, { compartilhamento_id: Number(resolvido.compartilhamento.id), catalogo_id: Number(catalogo.id), tipo: 'pedido_enviado', pedido_id: Number(pedido.venda.id), valor: Number(pedido.total), dados: {} });
    // Origem pública centralizada (APP_URL → cabeçalhos da requisição) — ver urlPublica.ts.
    const base = await urlBasePublicaAsync(req);
    const portal = await criarAcessoPortal(Number(pedido.venda.cliente_id), base, 90);
    res.status(201).json({ ok: true, mensagem: 'Pedido recebido! Nossa equipe vai confirmar disponibilidade e valores com você.', pedido_id: Number(pedido.venda.id), total: pedido.total, portal_url: portal.url, portal_expira_em: portal.expira_em });
  } catch (e) {
    throw toHttpError(e, RESOURCES.vendas);
  }
}


/** Central de compartilhamento: gera os ativos e registra a ação na auditoria. */
export async function compartilharCatalogo(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirComercial(actor, 'compartilhar');
  const id = parseId(req.params.id);
  const s = storeDoAtor(currentUser(req));
  const catalogo = await s.get(RESOURCES.catalogos, id);
  if (!catalogo) throw new HttpError(404, 'Catálogo não encontrado.');
  if (!catalogo.token) throw new HttpError(409, 'Este catálogo ainda não possui link público.');

  // Origem pública centralizada (APP_URL → cabeçalhos da requisição) — ver urlPublica.ts.
  const base = await urlBasePublicaAsync(req);
  const tokenIndividual = randomBytes(24).toString('hex');
  const dias = Math.min(365, Math.max(1, Number(req.body?.validade_dias) || 30));
  const expiraEm = new Date(Date.now() + dias * 86400000).toISOString();
  const canal = ['whatsapp', 'email', 'link', 'qrcode', 'visualizacao'].includes(String(req.body?.canal)) ? String(req.body.canal) : 'link';
  const clienteId = Number(req.body?.cliente_id) || null;
  const cliente = clienteId ? await s.get(RESOURCES.clientes, clienteId) : null;
  if (clienteId && !cliente) throw new HttpError(400, 'Cliente selecionado não foi encontrado.');
  const compartilhamento = await s.insert(RESOURCES.catalogo_compartilhamentos, {
    catalogo_id: id, cliente_id: clienteId, usuario_id: actor.id || null,
    token_hash: hashTokenPublico(tokenIndividual), canal, expira_em: expiraEm, acessos: 0,
  });
  const url = `${base}/catalogo/${tokenIndividual}`;
  const qr_data_url = await QRCode.toDataURL(url, {
    width: 420,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#1B2A4A', light: '#FFFFFF' },
  });
  await s.audit({
    usuario_id: actor.id || null,
    usuario: actor.name,
    acao: 'editar',
    recurso: 'catalogos',
    registro_id: id,
    descricao: `Catálogo "${catalogo.nome}" compartilhado por ${canal}${cliente ? ` com ${cliente.nome}` : ''}`,
    dados: { canal, cliente_id: clienteId, cliente: cliente?.nome ?? null, compartilhamento_id: Number(compartilhamento.id), expira_em: expiraEm },
  });
  res.json({ url, qr_data_url, compartilhamento_id: Number(compartilhamento.id), expira_em: expiraEm });
}


export async function eventoCatalogo(req: Request, res: Response) {
  const token = String(req.params.token || '').trim();
  const resolvido = await resolverTokenCatalogo(token);
  if (!resolvido.catalogo || !resolvido.compartilhamento) throw new HttpError(404, 'Compartilhamento não encontrado.');
  const tipo = String(req.body?.tipo || '');
  if (!['produto_visualizado', 'carrinho_iniciado'].includes(tipo)) throw new HttpError(400, 'Evento inválido.');
  const produtoId = Number(req.body?.produto_id) || null;
  await getStore().insert(RESOURCES.catalogo_eventos, {
    compartilhamento_id: Number(resolvido.compartilhamento.id), catalogo_id: Number(resolvido.catalogo.id),
    produto_id: produtoId, tipo, dados: {},
  });
  res.status(204).end();
}


/** Painel gerencial da Fase 2B: funil e compartilhamentos recentes. */
export async function inteligenciaCatalogos(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirComercial(actor, 'metricas');
  const s = storeDoAtor(currentUser(req));
  const dias = Math.min(365, Math.max(1, Number(req.query.dias) || 30));
  const desde = Date.now() - dias * 86400000;
  const [compR, eventosR, catalogosR, clientesR, usuariosR] = await Promise.all([
    s.list(RESOURCES.catalogo_compartilhamentos, { page: 1, pageSize: 10000, sort: 'criado_em', dir: 'desc' }),
    s.list(RESOURCES.catalogo_eventos, { page: 1, pageSize: 50000, sort: 'criado_em', dir: 'desc' }),
    s.list(RESOURCES.catalogos, { page: 1, pageSize: 2000 }),
    s.list(RESOURCES.clientes, { page: 1, pageSize: 5000 }),
    s.list(RESOURCES.usuarios, { page: 1, pageSize: 1000 }),
  ]);
  const comps = compR.rows.filter((x) => new Date(String(x.criado_em)).getTime() >= desde);
  const ids = new Set(comps.map((x) => Number(x.id)));
  const eventos = eventosR.rows.filter((x) => ids.has(Number(x.compartilhamento_id)));
  const porTipo = (tipo: string) => eventos.filter((e) => e.tipo === tipo);
  const abertos = new Set(porTipo('abertura').map((e) => Number(e.compartilhamento_id)));
  const pedidos = porTipo('pedido_enviado');
  const nomes = (rows: Row[]) => new Map(rows.map((x) => [Number(x.id), String(x.nome || x.email || `#${x.id}`)]));
  const cats = nomes(catalogosR.rows), clientes = nomes(clientesR.rows), usuarios = nomes(usuariosR.rows);
  const agora = Date.now();
  const recentes = comps.slice(0, 100).map((c) => ({
    id: Number(c.id), catalogo: cats.get(Number(c.catalogo_id)) || `#${c.catalogo_id}`,
    cliente: c.cliente_id ? clientes.get(Number(c.cliente_id)) || `#${c.cliente_id}` : 'Compartilhamento geral',
    vendedor: c.usuario_id ? usuarios.get(Number(c.usuario_id)) || `#${c.usuario_id}` : '—', canal: c.canal,
    criado_em: c.criado_em, expira_em: c.expira_em, primeiro_acesso_em: c.primeiro_acesso_em,
    ultimo_acesso_em: c.ultimo_acesso_em, acessos: Number(c.acessos || 0), revogado_em: c.revogado_em,
    status: c.revogado_em ? 'revogado' : c.expira_em && new Date(String(c.expira_em)).getTime() < agora ? 'expirado' : 'ativo',
  }));
  const enviados = comps.length, visualizados = abertos.size, convertidos = new Set(pedidos.map((e) => Number(e.compartilhamento_id))).size;
  res.json({ periodo_dias: dias, resumo: {
    enviados, visualizados, convertidos,
    taxa_abertura: enviados ? Math.round((visualizados / enviados) * 1000) / 10 : 0,
    taxa_conversao: enviados ? Math.round((convertidos / enviados) * 1000) / 10 : 0,
    produtos_visualizados: porTipo('produto_visualizado').length,
    carrinhos_iniciados: new Set(porTipo('carrinho_iniciado').map((e) => Number(e.compartilhamento_id))).size,
    valor_solicitado: pedidos.reduce((n, e) => n + Number(e.valor || 0), 0),
  }, recentes });
}

export async function revogarCompartilhamento(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirComercial(actor, 'compartilhar');
  const id = parseId(req.params.id);
  const s = storeDoAtor(currentUser(req));
  const atual = await s.get(RESOURCES.catalogo_compartilhamentos, id);
  if (!atual) throw new HttpError(404, 'Compartilhamento não encontrado.');
  if (!atual.revogado_em) await s.update(RESOURCES.catalogo_compartilhamentos, id, { revogado_em: new Date().toISOString() });
  await s.audit({ usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'catalogos', registro_id: Number(atual.catalogo_id), descricao: `Link individual #${id} revogado`, dados: { compartilhamento_id: id } });
  res.json({ ok: true });
}

// ----------------------------------------------------------------------------
// CATÁLOGO INCORPORÁVEL (iframe) — usado pelo site de varejo/atacado
//
// O ERP já expõe o catálogo por token (JSON). Este endpoint devolve a MESMA
// vitrine em HTML pronta para ser embutida em outra página:
//
//   <iframe src="https://<erp>/api/publico/catalogo/<token>/embed"
//           style="width:100%;height:900px;border:0"></iframe>
//
// Detalhes que importam:
//   • os cabeçalhos globais bloqueiam iframe (CSP frame-ancestors 'self' e
//     X-Frame-Options SAMEORIGIN). Aqui eles são substituídos por uma lista
//     explícita (CATALOGO_EMBED_ORIGENS, padrão: o endereço da loja), então só
//     os sites autorizados conseguem incorporar — nunca "qualquer um";
//   • a página é estática (sem script, sem fonte externa): obedece à CSP e
//     carrega até em conexão fraca;
//   • o botão "Comprar" leva para a busca do produto na loja pelo SKU — assim
//     a vitrine do ERP alimenta o carrinho do WooCommerce sem duplicar cadastro.
// ----------------------------------------------------------------------------
function escHtml(valor: unknown): string {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function brl(valor: number | null | undefined): string {
  if (valor === null || valor === undefined || !Number.isFinite(Number(valor))) return '';
  return Number(valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** Origens autorizadas a incorporar o catálogo (lista explícita, nunca "*"). */
export function origensEmbed(): string[] {
  const bruto = String(process.env.CATALOGO_EMBED_ORIGENS || process.env.WOOCOMMERCE_URL || '');
  return bruto
    .split(',')
    .map((o) => {
      try {
        return new URL(o.trim()).origin;
      } catch {
        return '';
      }
    })
    .filter(Boolean);
}

export async function catalogoEmbed(req: Request, res: Response) {
  const token = String(req.params.token || '').trim();
  if (!token || !/^[a-f0-9]{12,}$/i.test(token)) throw new HttpError(404, 'Catálogo não encontrado.');
  const s = storeDoAtor(currentUser(req));
  const resolvido = await resolverTokenCatalogo(token);
  const catalogo = resolvido.catalogo;
  if (!catalogo || catalogo.ativo === false) throw new HttpError(404, 'Catálogo não encontrado.');
  if (catalogo.expira_em && new Date(String(catalogo.expira_em)).getTime() < Date.now()) {
    throw new HttpError(404, 'Este catálogo expirou. Fale com quem o enviou.');
  }

  // Substitui os cabeçalhos globais: permite o iframe só nas origens da lista.
  const permitidas = origensEmbed();
  if (permitidas.length) {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "img-src 'self' data: https:",
        "style-src 'unsafe-inline'",
        "object-src 'none'",
        `frame-ancestors 'self' ${permitidas.join(' ')}`,
      ].join('; ')
    );
    res.removeHeader('X-Frame-Options'); // allowlist só existe no CSP; este cabeçalho é tudo-ou-nada
  }

  const senhaInformada = typeof req.query.senha === 'string' ? req.query.senha : undefined;
  const senhaOk = !catalogo.senha_hash || ehMesmaSenha(senhaInformada, catalogo.senha_hash);
  if (!senhaOk) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res
      .status(200)
      .send(
        `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(catalogo.nome)} — catálogo protegido</title>
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc;color:#0f172a">
<form method="get" style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(15,23,42,.08);width:min(360px,90vw)">
<h1 style="font-size:16px;margin:0 0 4px">${escHtml(catalogo.nome)}</h1>
<p style="margin:0 0 16px;font-size:13px;color:#64748b">Este catálogo é protegido por senha.</p>
<input type="password" name="senha" placeholder="Senha do catálogo" autofocus required style="width:100%;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;box-sizing:border-box">
<button type="submit" style="margin-top:12px;width:100%;padding:10px 12px;border:0;border-radius:8px;background:#0f2c52;color:#fff;font-weight:600;font-size:14px;cursor:pointer">Abrir catálogo</button>
</form></body></html>`
      );
    return;
  }

  // Mesmo critério do endpoint JSON: conta o acesso do compartilhamento.
  if (resolvido.compartilhamento) {
    const c = resolvido.compartilhamento;
    const agora = new Date().toISOString();
    await s.update(RESOURCES.catalogo_compartilhamentos, Number(c.id), {
      primeiro_acesso_em: c.primeiro_acesso_em || agora,
      ultimo_acesso_em: agora,
      acessos: Number(c.acessos || 0) + 1,
    });
    await s.insert(RESOURCES.catalogo_eventos, {
      compartilhamento_id: Number(c.id),
      catalogo_id: Number(catalogo.id),
      tipo: 'abertura',
      dados: { embed: true },
    });
  }

  const filtros = filtrosDoCatalogo(catalogo);
  const filter: Record<string, unknown> = {};
  if (filtros.colecao_id) filter.colecao_id = filtros.colecao_id;
  if (filtros.categoria_id) filter.categoria_id = filtros.categoria_id;
  const [produtos, estoques, tamanhos] = await Promise.all([
    s.list(RESOURCES.produtos, { page: 1, pageSize: 500, filter, sort: 'nome', dir: 'asc' }),
    s.list(RESOURCES.estoques, { page: 1, pageSize: 6000 }),
    s.list(RESOURCES.tamanhos, { page: 1, pageSize: 200, sort: 'ordem', dir: 'asc' }),
  ]);
  await attachImages(RESOURCES.produtos, produtos.rows);
  const tamCodigo = new Map(tamanhos.rows.map((t) => [Number(t.id), String(t.codigo || '')]));

  const canal = String(catalogo.canal || 'todos');
  const canalEfetivo: 'atacado' | 'varejo' = canal === 'atacado' ? 'atacado' : 'varejo';
  const politica = await resolverPoliticaComercial({ catalogo, clienteId: Number(resolvido.compartilhamento?.cliente_id) || null, canal: canalEfetivo });
  const mostrarPreco = catalogo.mostrar_preco !== false;
  const mostrarSaldo = catalogo.mostrar_saldo === true;

  const loja = urlLoja();
  const base = await urlBasePublicaAsync(req);
  const linkCatalogo = `${base}/catalogo/${encodeURIComponent(token)}`;

  const cards = produtos.rows
    .filter((p) => p.exibir_site !== false && p.ativo !== false)
    .map((p) => {
      const doProduto = estoques.rows.filter((e) => Number(e.produto_id) === Number(p.id));
      const tamanhosLinha = [...new Set(doProduto.map((e) => Number(e.tamanho_id)))]
        .map((tid) => ({
          codigo: tamCodigo.get(tid) || '',
          saldo: doProduto.filter((e) => Number(e.tamanho_id) === tid).reduce((a, e) => a + Number(e.quantidade || 0), 0),
        }))
        .filter((t) => t.saldo > 0);
      const varejo = Number(p.preco_venda || 0);
      const atacado = Number(p.preco_atacado || p.preco_venda || 0);
      const preco = precoComPolitica(canalEfetivo === 'atacado' ? atacado : varejo, politica);
      const sku = String(p.sku || '').trim();
      const foto = String(p.foto_url || (Array.isArray(p.fotos) ? p.fotos[0]?.url : '') || '');
      const urlCompra = loja
        ? `${loja}/?post_type=product&s=${encodeURIComponent(sku || String(p.nome || ''))}`
        : linkCatalogo;
      return `<article style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;display:flex;flex-direction:column">
  <div style="aspect-ratio:3/4;background:#f1f5f9;display:flex;align-items:center;justify-content:center;overflow:hidden">
    ${foto ? `<img src="${escHtml(foto)}" alt="${escHtml(p.nome)}" loading="lazy" style="width:100%;height:100%;object-fit:cover">` : '<span style="color:#94a3b8;font-size:12px">sem foto</span>'}
  </div>
  <div style="padding:12px;display:flex;flex-direction:column;gap:6px;flex:1">
    <strong style="font-size:14px;line-height:1.3">${escHtml(p.nome)}</strong>
    <span style="font-size:11px;color:#64748b;font-family:ui-monospace,Menlo,monospace">${escHtml(sku)}</span>
    ${mostrarPreco && preco ? `<span style="font-size:16px;font-weight:700;color:#0f2c52">${escHtml(brl(preco))}</span>` : ''}
    ${tamanhosLinha.length ? `<div style="display:flex;flex-wrap:wrap;gap:4px">${tamanhosLinha
      .map(
        (t) =>
          `<span style="font-size:11px;border:1px solid #cbd5e1;border-radius:6px;padding:2px 6px;color:#334155">${escHtml(t.codigo)}${mostrarSaldo ? ` · ${t.saldo}` : ''}</span>`
      )
      .join('')}</div>` : '<span style="font-size:11px;color:#94a3b8">sem saldo</span>'}
    <a href="${escHtml(urlCompra)}" target="_blank" rel="noopener" style="margin-top:auto;text-align:center;text-decoration:none;background:#0f2c52;color:#fff;border-radius:8px;padding:9px 12px;font-size:13px;font-weight:600">${loja ? 'Comprar' : 'Ver no catálogo'}</a>
  </div>
</article>`;
    })
    .join('');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(catalogo.nome)} — catálogo</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f8fafc;color:#0f172a}
  header{padding:16px 20px;border-bottom:1px solid #e2e8f0;background:#fff;display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;justify-content:space-between}
  header h1{font-size:17px;margin:0}
  header p{margin:0;font-size:12px;color:#64748b}
  main{padding:16px 20px;display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(180px,1fr))}
  footer{padding:12px 20px 24px;font-size:12px;color:#64748b;text-align:center}
  footer a{color:#0f2c52;font-weight:600}
</style>
</head>
<body>
<header>
  <h1>${escHtml(catalogo.nome)}</h1>
  <p>${canalEfetivo === 'atacado' ? 'Tabela de atacado' : 'Tabela de varejo'} · ${produtos.rows.length} produto(s)</p>
</header>
<main>${cards || '<p style="color:#64748b">Nenhum produto disponível neste catálogo.</p>'}</main>
<footer><a href="${escHtml(linkCatalogo)}" target="_blank" rel="noopener">Abrir o catálogo completo</a></footer>
</body>
</html>`);
}

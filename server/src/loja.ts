// ============================================================
// Integração com a loja virtual (WordPress + WooCommerce).
//
// Endpoints (todos exigem login; importar/empurrar estoque exigem permissão
// de criação/edição em Vendas):
//   GET  /api/marketplace/loja/status          — está configurada? a loja responde?
//   GET  /api/marketplace/loja/produtos        — diagnóstico: SKU do ERP x loja
//   POST /api/marketplace/loja/pedidos         — importa pedidos da loja → Vendas
//   POST /api/marketplace/loja/estoque         — empurra o saldo do ERP → loja
//
// Configuração (Render › Environment):
//   WOOCOMMERCE_URL  https://brobond.com.br      (sem /wp-json, sem barra final)
//   WOOCOMMERCE_CK   consumer key  (WooCommerce › Configurações › Avançado › API REST)
//   WOOCOMMERCE_CS   consumer secret
//   WOOCOMMERCE_STATUS   (opcional) status importado — padrão "processing"
//   WOOCOMMERCE_CANAL    (opcional) site_varejo | site_atacado — padrão site_varejo
//
// Regras de ouro desta integração:
//   • IDEMPOTENTE: o número do pedido da loja é gravado em
//     `vendas.pedido_cliente` como "WOO-<id>"; reimportar não duplica.
//   • NUNCA inventa cadastro: item sem SKU conhecido no ERP não entra no
//     pedido — volta em `pendentes` para o responsável decidir.
//   • Nenhuma falha da loja derruba o ERP: erros de rede/HTTP viram 502 com
//     mensagem em português dizendo o que conferir.
// ============================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { checkAccess, getStore } from './services';
import { RESOURCES } from './resources';
import { currentUser } from './auth';
import { recalcularTotal } from './itens';
import { normalizarOrigem } from './urlPublica';
import type { Row } from './store';

export type ConfigLoja = { url: string; ck: string; cs: string };

/** Lê a configuração da loja. `null` quando falta alguma variável. */
export function configLoja(): ConfigLoja | null {
  // normalizarOrigem aceita "brobond.com.br" e rejeita o que não for http(s).
  const url = normalizarOrigem(process.env.WOOCOMMERCE_URL);
  const ck = String(process.env.WOOCOMMERCE_CK || '').trim();
  const cs = String(process.env.WOOCOMMERCE_CS || '').trim();
  if (!url || !ck || !cs) return null;
  return { url, ck, cs };
}

export function lojaConfigurada(): boolean {
  return configLoja() !== null;
}

/** Status dos pedidos importados (WooCommerce: pending, processing, on-hold, completed…). */
function statusImportacao(): string {
  return String(process.env.WOOCOMMERCE_STATUS || 'processing').trim() || 'processing';
}

/** Canal lançado nas vendas importadas: varejo (padrão) ou atacado. */
function canalLoja(): 'site_varejo' | 'site_atacado' {
  return String(process.env.WOOCOMMERCE_CANAL || '').trim() === 'site_atacado' ? 'site_atacado' : 'site_varejo';
}

/** Endereço da loja para montar links (mesmo sem API configurada). */
export function urlLoja(): string {
  return normalizarOrigem(process.env.WOOCOMMERCE_URL);
}

const TIMEOUT_MS = Number(process.env.WOOCOMMERCE_TIMEOUT_MS) || 20_000;

/** Chamada autenticada à REST API do WooCommerce (v3, Basic Auth sobre HTTPS). */
async function wooFetch(cfg: ConfigLoja, caminho: string, init: Parameters<typeof fetch>[1] = {}): Promise<any> {
  const auth = Buffer.from(`${cfg.ck}:${cfg.cs}`).toString('base64');
  let resp: globalThis.Response;
  try {
    resp = await fetch(`${cfg.url}/wp-json/wc/v3${caminho}`, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...((init.headers as Record<string, string>) || {}),
      },
    });
  } catch (e: any) {
    throw new HttpError(
      502,
      `Não foi possível falar com a loja (${cfg.url}). Verifique se o site está no ar e se WOOCOMMERCE_URL está correta. Detalhe: ${e?.message || e}`
    );
  }
  const texto = await resp.text();
  if (!resp.ok) {
    const detalhe = String(texto).replace(/\s+/g, ' ').slice(0, 180);
    if (resp.status === 401 || resp.status === 403) {
      throw new HttpError(
        502,
        'A loja recusou as credenciais. Confira WOOCOMMERCE_CK/WOOCOMMERCE_CS em WooCommerce › Configurações › Avançado › API REST (a chave precisa ter permissão de leitura/escrita). ' +
          detalhe
      );
    }
    if (resp.status === 404) {
      throw new HttpError(502, `A REST API não foi encontrada em ${cfg.url}/wp-json/wc/v3 — o WooCommerce está ativo no site? ${detalhe}`);
    }
    throw new HttpError(502, `A loja respondeu ${resp.status}. ${detalhe}`);
  }
  try {
    return JSON.parse(texto);
  } catch {
    return null;
  }
}

function exigirPermissaoVenda(req: Request, op: 'create' | 'update'): { id: number; name: string } {
  const actor = currentUser(req);
  checkAccess(RESOURCES.vendas, actor, op);
  // Sincronizar a loja mexe no cadastro de terceiros (clientes) e no saldo
  // publicado no site: é ação de gestão, não de balcão.
  if (actor.perfil !== 'admin' && actor.perfil !== 'gerente') {
    throw new HttpError(403, 'Apenas gerentes e administradores sincronizam a loja.');
  }
  return actor as { id: number; name: string };
}

function exigirConfigurada(): ConfigLoja {
  const cfg = configLoja();
  if (!cfg) {
    throw new HttpError(
      409,
      'A loja não está configurada neste servidor. Defina WOOCOMMERCE_URL, WOOCOMMERCE_CK e WOOCOMMERCE_CS (Render › Environment) e reinicie.'
    );
  }
  return cfg;
}

// ----------------------------------------------------------------------------
// Status / diagnóstico
// ----------------------------------------------------------------------------

/** GET /api/marketplace/loja/status — configuração + teste de conexão (?testar=1). */
export async function statusLoja(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(RESOURCES.vendas, actor, 'read');
  const cfg = configLoja();
  if (!cfg) {
    res.json({ configurado: false, url: urlLoja() || null, status_pedidos: statusImportacao(), canal: canalLoja() });
    return;
  }
  const saida: Record<string, unknown> = {
    configurado: true,
    url: cfg.url,
    status_pedidos: statusImportacao(),
    canal: canalLoja(),
  };
  if (req.query.testar === '1') {
    try {
      const pedidos = await wooFetch(cfg, '/orders?per_page=1');
      saida.conexao = { ok: true, respondeu: Array.isArray(pedidos) };
    } catch (e: any) {
      saida.conexao = { ok: false, erro: e?.message || String(e) };
    }
  }
  res.json(saida);
}

/**
 * GET /api/marketplace/loja/produtos — casamento SKU do ERP x loja.
 * É o relatório que responde "por que o pedido não entrou?": mostra o saldo do
 * ERP, se o SKU existe na loja e quantas variações a loja tem para ele.
 */
export async function produtosLoja(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(RESOURCES.produtos, actor, 'read');
  const s = getStore();
  const [produtosR, estoquesR, tamanhosR] = await Promise.all([
    s.list(RESOURCES.produtos, { page: 1, pageSize: 2000, sort: 'sku', dir: 'asc' }),
    s.list(RESOURCES.estoques, { page: 1, pageSize: 20000 }),
    s.list(RESOURCES.tamanhos, { page: 1, pageSize: 500, sort: 'ordem', dir: 'asc' }),
  ]);
  const tamanhoPorId = new Map<number, string>(tamanhosR.rows.map((t) => [Number(t.id), String(t.codigo || '').toUpperCase()]));
  const saldoPorProduto = new Map<number, number>();
  for (const e of estoquesR.rows) {
    const id = Number(e.produto_id);
    saldoPorProduto.set(id, (saldoPorProduto.get(id) || 0) + Number(e.quantidade || 0));
  }

  const cfg = configLoja();
  const naLoja = new Map<string, { id: number; tipo: string; permalink?: string }>();
  if (cfg) {
    try {
      for (let pagina = 1; pagina <= 10; pagina++) {
        const produtos = await wooFetch(cfg, `/products?per_page=100&page=${pagina}&status=publish`);
        if (!Array.isArray(produtos) || !produtos.length) break;
        for (const p of produtos) {
          const sku = String(p.sku || '')
            .trim()
            .toUpperCase();
          if (sku)
            naLoja.set(sku, {
              id: Number(p.id),
              tipo: String(p.type || 'simple'),
              permalink: p.permalink ? String(p.permalink) : undefined,
            });
        }
        if (produtos.length < 100) break;
      }
    } catch {
      /* diagnóstico segue sem a loja */
    }
  }

  const itens = produtosR.rows
    .filter((p) => p.ativo !== false)
    .map((p) => {
      const sku = String(p.sku || '')
        .trim()
        .toUpperCase();
      const encontrado = sku ? naLoja.get(sku) : undefined;
      return {
        sku,
        nome: String(p.nome || ''),
        exibir_site: p.exibir_site !== false,
        saldo: saldoPorProduto.get(Number(p.id)) || 0,
        preco_venda: Number(p.preco_venda || 0),
        preco_atacado: Number(p.preco_atacado || 0),
        na_loja: encontrado ? { id: encontrado.id, tipo: encontrado.tipo, url: encontrado.permalink || null } : null,
        tamanhos: [
          ...new Set(
            estoquesR.rows
              .filter((e) => Number(e.produto_id) === Number(p.id))
              .map((e) => tamanhoPorId.get(Number(e.tamanho_id)))
              .filter(Boolean)
          ),
        ],
      };
    });

  res.json({
    loja_configurada: Boolean(cfg),
    url: cfg?.url || null,
    total_erp: itens.length,
    sem_sku_na_loja: itens.filter((i) => i.exibir_site && !i.na_loja).length,
    produtos: itens,
  });
}

// ----------------------------------------------------------------------------
// Importação de pedidos
// ----------------------------------------------------------------------------

type LinhaWoo = {
  sku?: string;
  name?: string;
  quantity?: number;
  price?: number;
  total?: string;
  meta_data?: { key?: string; value?: unknown }[];
};
type PedidoWoo = {
  id?: number;
  number?: string;
  status?: string;
  date_created?: string;
  total?: string;
  shipping_total?: string;
  discount_total?: string;
  payment_method_title?: string;
  customer_note?: string;
  billing?: { first_name?: string; last_name?: string; email?: string; phone?: string; cpf?: string; cnpj?: string };
  line_items?: LinhaWoo[];
};

/** Tamanho vindo da variação (meta_data do item: pa_tamanho, Tamanho, tamanho…). */
function extrairTamanho(linha: LinhaWoo): string {
  for (const m of linha.meta_data || []) {
    const chave = String(m?.key || '').toLowerCase();
    if (!chave) continue;
    if (chave === 'tamanho' || chave === 'pa_tamanho' || chave.endsWith('_tamanho') || chave.endsWith('-tamanho')) {
      return String(m?.value ?? '')
        .trim()
        .toUpperCase();
    }
  }
  return '';
}

/** Texto do item em `pendentes`: identifica o produto mesmo sem SKU. */
function rotuloLinha(linha: LinhaWoo): string {
  return String(linha?.name || linha?.sku || 'item sem nome').trim();
}

/**
 * POST /api/marketplace/loja/pedidos — importa pedidos da loja como Vendas.
 * Body opcional: { dias?: number, status?: string, limite?: number }
 */
export async function importarPedidosLoja(req: Request, res: Response) {
  const actor = exigirPermissaoVenda(req, 'create');
  const cfg = exigirConfigurada();
  const s = getStore();

  const dias = Math.min(90, Math.max(1, Number(req.body?.dias) || 7));
  const status = String(req.body?.status || statusImportacao()).trim() || 'processing';
  const limite = Math.min(200, Math.max(1, Number(req.body?.limite) || 50));
  const depois = new Date(Date.now() - dias * 86400_000).toISOString();

  const pedidos: PedidoWoo[] =
    (await wooFetch(
      cfg,
      `/orders?status=${encodeURIComponent(status)}&after=${encodeURIComponent(depois)}&per_page=${limite}&orderby=date&order=desc`
    )) || [];

  const [produtosR, tamanhosR, estoquesR] = await Promise.all([
    s.list(RESOURCES.produtos, { page: 1, pageSize: 5000 }),
    s.list(RESOURCES.tamanhos, { page: 1, pageSize: 500, sort: 'ordem', dir: 'asc' }),
    s.list(RESOURCES.estoques, { page: 1, pageSize: 20000 }),
  ]);
  const produtoPorSku = new Map<string, Row>();
  for (const p of produtosR.rows) {
    const sku = String(p.sku || '')
      .trim()
      .toUpperCase();
    if (sku && !produtoPorSku.has(sku)) produtoPorSku.set(sku, p);
  }
  const tamanhos = tamanhosR.rows;
  const tamanhoPorCodigo = new Map<string, Row>();
  for (const t of tamanhos)
    tamanhoPorCodigo.set(
      String(t.codigo || '')
        .trim()
        .toUpperCase(),
      t
    );
  const primeiroTamanhoComSaldo = (produtoId: number): number | null => {
    const comSaldo = estoquesR.rows.find((e) => Number(e.produto_id) === produtoId && Number(e.quantidade || 0) > 0);
    return comSaldo ? Number(comSaldo.tamanho_id) : null;
  };

  const canal = canalLoja();
  const importados: { pedido: string; venda_id: number; total: number }[] = [];
  const ignorados: string[] = [];
  const pendentes: { pedido: string; motivo: string; itens: string[] }[] = [];

  for (const pedido of pedidos) {
    const numero = String(pedido.number ?? pedido.id ?? '').trim();
    const referencia = `WOO-${pedido.id ?? numero}`;
    const jaExiste = await s.findOneWhere(RESOURCES.vendas, { pedido_cliente: referencia });
    if (jaExiste) {
      ignorados.push(numero || referencia); // idempotência: nunca duplica
      continue;
    }

    const itensResolvidos: { produto: Row; tamanhoId: number; quantidade: number; preco: number }[] = [];
    const itensPendentes: string[] = [];
    for (const linha of pedido.line_items || []) {
      const sku = String(linha.sku || '')
        .trim()
        .toUpperCase();
      const produto = sku ? produtoPorSku.get(sku) : undefined;
      if (!produto) {
        itensPendentes.push(`${rotuloLinha(linha)}${sku ? ` (SKU ${sku})` : ' (sem SKU)'}`);
        continue;
      }
      const pedidoTamanho = extrairTamanho(linha);
      const tamanho = pedidoTamanho ? tamanhoPorCodigo.get(pedidoTamanho) : undefined;
      const tamanhoId = tamanho ? Number(tamanho.id) : (primeiroTamanhoComSaldo(Number(produto.id)) ?? Number(tamanhos[0]?.id ?? 0));
      if (!tamanhoId) {
        itensPendentes.push(`${rotuloLinha(linha)} (sem tamanho no ERP)`);
        continue;
      }
      const quantidade = Math.max(1, Math.trunc(Number(linha.quantity) || 1));
      const precoInformado = Number(linha.price);
      const totalLinha = Number(String(linha.total ?? '').replace(',', '.'));
      const preco =
        Number.isFinite(precoInformado) && precoInformado > 0
          ? precoInformado
          : Number.isFinite(totalLinha) && totalLinha > 0
            ? Math.round((totalLinha / quantidade) * 100) / 100
            : Number(canal === 'site_atacado' ? produto.preco_atacado || produto.preco_venda || 0 : produto.preco_venda || 0);
      itensResolvidos.push({ produto, tamanhoId, quantidade, preco });
    }

    if (!itensResolvidos.length) {
      pendentes.push({ pedido: numero || referencia, motivo: 'nenhum item com SKU cadastrado no ERP', itens: itensPendentes });
      continue;
    }

    try {
      const criado = await s.transaction(async (tx) => {
        const billing = pedido.billing || {};
        const email = String(billing.email || '')
          .trim()
          .toLowerCase();
        const nome =
          [billing.first_name, billing.last_name].filter(Boolean).join(' ').trim() || email || `Cliente loja ${numero || referencia}`;
        let cliente = email ? await s.findOneWhere(RESOURCES.clientes, { email }, tx) : null;
        if (!cliente) cliente = await s.findOneWhere(RESOURCES.clientes, { nome }, tx);
        if (!cliente) {
          cliente = await s.insert(
            RESOURCES.clientes,
            {
              nome,
              email: email || null,
              telefone: billing.phone ? String(billing.phone) : null,
              tipo: canal === 'site_atacado' ? 'atacadista' : 'varejo',
              ativo: true,
            },
            tx
          );
        }
        const venda = await s.insert(
          RESOURCES.vendas,
          {
            cliente_id: Number(cliente.id),
            data: String(pedido.date_created || new Date().toISOString()).slice(0, 10),
            // "Cotação / Pedido do site": entra para conferência, não baixa estoque.
            status: 'cotacao',
            canal_venda: canal,
            pedido_cliente: referencia,
            frete: Math.max(0, Number(pedido.shipping_total || 0)),
            desconto: Math.max(0, Number(pedido.discount_total || 0)),
            condicao_pagamento: pedido.payment_method_title ? String(pedido.payment_method_title) : null,
            fin_status: 'a_receber',
            observacoes: [
              `Pedido importado da loja (${cfg.url}) — nº ${numero || referencia}`,
              pedido.customer_note ? `Observação do cliente: ${String(pedido.customer_note).trim()}` : null,
              itensPendentes.length ? `Itens NÃO importados (conferir cadastro de SKU): ${itensPendentes.join('; ')}` : null,
            ]
              .filter(Boolean)
              .join('\n'),
          },
          tx
        );
        for (const item of itensResolvidos) {
          await s.insert(
            RESOURCES.itens_venda,
            {
              venda_id: Number(venda.id),
              produto_id: Number(item.produto.id),
              tamanho_id: item.tamanhoId,
              quantidade: item.quantidade,
              preco_unitario: item.preco,
              desconto_pct: 0,
              subtotal: Math.round(item.quantidade * item.preco * 100) / 100,
            },
            tx
          );
        }
        const total = await recalcularTotal('venda', Number(venda.id), tx);
        return { vendaId: Number(venda.id), total };
      });
      importados.push({ pedido: numero || referencia, venda_id: criado.vendaId, total: criado.total });
      if (itensPendentes.length) {
        pendentes.push({ pedido: numero || referencia, motivo: 'itens sem SKU no ERP ficaram de fora', itens: itensPendentes });
      }
    } catch (e: any) {
      pendentes.push({ pedido: numero || referencia, motivo: e?.message || 'falha ao gravar o pedido', itens: itensPendentes });
    }
  }

  await s
    .audit({
      usuario_id: actor.id,
      usuario: actor.name,
      acao: 'importar',
      recurso: 'marketplace',
      registro_id: null,
      descricao: `Importação da loja (${cfg.url}, status ${status}, ${dias} dias): ${importados.length} pedido(s) novo(s), ${ignorados.length} já importado(s), ${pendentes.length} pendente(s)`,
      dados: { origem: 'woocommerce', status, dias, importados, ignorados, pendentes },
    })
    .catch(() => undefined);

  res.json({
    ok: true,
    loja: cfg.url,
    status,
    dias,
    importados,
    ignorados,
    pendentes,
    total_encontrados: pedidos.length,
  });
}

// ----------------------------------------------------------------------------
// Estoque: ERP → loja
// ----------------------------------------------------------------------------

/** Chaves de SKU aceitas para casar um item da loja com o ERP. */
function chavesSku(skuProduto: string, codigoTamanho: string): string[] {
  const base = String(skuProduto || '')
    .trim()
    .toUpperCase();
  const tam = String(codigoTamanho || '')
    .trim()
    .toUpperCase();
  if (!base) return [];
  return [base, tam ? `${base}-${tam}` : '', tam ? `${base} ${tam}` : '', tam ? `${base}/${tam}` : ''].filter(Boolean);
}

/**
 * POST /api/marketplace/loja/estoque — empurra o saldo do ERP para a loja.
 *
 * Só envia produtos com `exibir_site` (e ativos). Variações são casadas por SKU
 * exato e, na falta dele, por "<SKU>-<TAMANHO>" (convenção da loja). O que não
 * for encontrado volta em `nao_encontrados` — nunca inventamos produto na loja.
 */
export async function sincronizarEstoqueLoja(req: Request, res: Response) {
  const actor = exigirPermissaoVenda(req, 'update');
  const cfg = exigirConfigurada();
  const s = getStore();

  const [produtosR, tamanhosR, estoquesR] = await Promise.all([
    s.list(RESOURCES.produtos, { page: 1, pageSize: 5000 }),
    s.list(RESOURCES.tamanhos, { page: 1, pageSize: 500, sort: 'ordem', dir: 'asc' }),
    s.list(RESOURCES.estoques, { page: 1, pageSize: 20000 }),
  ]);
  const tamanhoPorId = new Map<number, string>(
    tamanhosR.rows.map((t) => [
      Number(t.id),
      String(t.codigo || '')
        .trim()
        .toUpperCase(),
    ])
  );

  // saldo por produto e por produto+tamanho
  const saldoProduto = new Map<number, number>();
  const saldoProdutoTamanho = new Map<number, Map<string, number>>();
  for (const e of estoquesR.rows) {
    const pid = Number(e.produto_id);
    const qtd = Number(e.quantidade || 0);
    saldoProduto.set(pid, (saldoProduto.get(pid) || 0) + qtd);
    const codigo = tamanhoPorId.get(Number(e.tamanho_id));
    if (!codigo) continue;
    const porTam = saldoProdutoTamanho.get(pid) || new Map<string, number>();
    porTam.set(codigo, (porTam.get(codigo) || 0) + qtd);
    saldoProdutoTamanho.set(pid, porTam);
  }

  // Índice do ERP: SKU (e SKU-TAMANHO) → saldo
  const indice = new Map<string, number>();
  for (const p of produtosR.rows) {
    if (p.ativo === false || p.exibir_site === false) continue;
    const pid = Number(p.id);
    const porTam = saldoProdutoTamanho.get(pid);
    if (porTam?.size) {
      for (const [codigo, qtd] of porTam) for (const chave of chavesSku(String(p.sku || ''), codigo)) indice.set(chave, qtd);
    }
    for (const chave of chavesSku(String(p.sku || ''), '')) if (!indice.has(chave)) indice.set(chave, saldoProduto.get(pid) || 0);
  }

  const atualizados: { sku: string; saldo: number; onde: string }[] = [];
  const naoEncontrados: string[] = [...indice.keys()].filter((sku) => !sku.includes('-'));
  const atualizacoesSimples: { id: number; stock_quantity: number; manage_stock: boolean }[] = [];

  for (let pagina = 1; pagina <= 10; pagina++) {
    const produtos = await wooFetch(cfg, `/products?per_page=100&page=${pagina}&status=publish`);
    if (!Array.isArray(produtos) || !produtos.length) break;

    for (const p of produtos) {
      const sku = String(p.sku || '')
        .trim()
        .toUpperCase();
      if (p.type === 'variable') {
        const variacoes = await wooFetch(cfg, `/products/${Number(p.id)}/variations?per_page=100`);
        if (!Array.isArray(variacoes) || !variacoes.length) continue;
        const update: { id: number; stock_quantity: number; manage_stock: boolean }[] = [];
        for (const v of variacoes) {
          const vsku = String(v.sku || '')
            .trim()
            .toUpperCase();
          const chaves = [vsku, sku && vsku ? `${sku}-${vsku}` : ''].filter(Boolean);
          const saldo = chaves.map((c) => indice.get(c)).find((q) => typeof q === 'number');
          if (typeof saldo === 'number') {
            update.push({ id: Number(v.id), stock_quantity: Math.max(0, Math.trunc(saldo)), manage_stock: true });
            atualizados.push({ sku: vsku || sku, saldo, onde: `variação ${v.id} do produto ${p.id}` });
            naoEncontrados.splice(naoEncontrados.indexOf(sku), 1);
          }
        }
        if (update.length) {
          await wooFetch(cfg, `/products/${Number(p.id)}/variations/batch`, {
            method: 'POST',
            body: JSON.stringify({ update }),
          });
        }
      } else if (sku && indice.has(sku)) {
        atualizacoesSimples.push({ id: Number(p.id), stock_quantity: Math.max(0, Math.trunc(indice.get(sku)!)), manage_stock: true });
        atualizados.push({ sku, saldo: indice.get(sku)!, onde: `produto ${p.id}` });
        naoEncontrados.splice(naoEncontrados.indexOf(sku), 1);
      }
    }
    if (produtos.length < 100) break;
  }

  // Produtos simples em lote (até 100 por chamada)
  for (let i = 0; i < atualizacoesSimples.length; i += 100) {
    await wooFetch(cfg, '/products/batch', {
      method: 'POST',
      body: JSON.stringify({ update: atualizacoesSimples.slice(i, i + 100) }),
    });
  }

  await s
    .audit({
      usuario_id: actor.id,
      usuario: actor.name,
      acao: 'importar',
      recurso: 'marketplace',
      registro_id: null,
      descricao: `Estoque enviado para a loja (${cfg.url}): ${atualizados.length} SKU(s) atualizado(s), ${naoEncontrados.length} sem correspondência`,
      dados: { origem: 'woocommerce', atualizados: atualizados.length, nao_encontrados: naoEncontrados },
    })
    .catch(() => undefined);

  res.json({
    ok: true,
    loja: cfg.url,
    atualizados,
    total_atualizados: atualizados.length,
    nao_encontrados: naoEncontrados,
  });
}

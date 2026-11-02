// ============================================================================
// STOREFRONT — SEO e status HTTP reais (/loja e /loja/produto/:slug).
//
// O front é uma SPA: sem esta camada, qualquer URL (inclusive produto
// inexistente) devolveria 200 + o mesmo <title>. Aqui o servidor:
//   • resolve o produto pela MESMA regra da vitrine (ativo + projetado +
//     publicação PUBLISHED no canal BROBOND + tenant da loja);
//   • produto inexistente / não publicado / de outro tenant → HTTP 404 REAL,
//     com `noindex` e sem revelar nada do produto;
//   • produto publicado → 200 com <title>, description, canonical, Open Graph
//     e JSON-LD (Product + disponibilidade) — tudo ESCAPADO (anti-XSS);
//   • não decide preço/estoque no browser: lê do servidor.
// Se a loja não está configurada, cai no SPA normal (a própria tela explica).
// ============================================================================
import type { NextFunction, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from '../errors';
import { escopoDeSistema } from '../empresa';
import { getResource } from '../resources';
import { attachImages } from '../uploads';
import { urlBasePublicaAsync } from '../urlPublica';
import { disponibilidadesPorTamanho } from './catalogo';
import { configDaLoja, empresaDaVitrine } from './loja-base';
import { carregarVitrine, precoPublico } from './vitrine';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEMPLATE_MINIMO =
  '<!doctype html><html lang="pt-BR"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>BROBOND</title></head><body><div id="root"></div></body></html>';

export function escaparHtml(valor: unknown): string {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** JSON seguro para <script type="application/ld+json">: nunca fecha a tag nem injeta HTML. */
export function jsonLdSeguro(obj: unknown): string {
  return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export type MetaPagina = {
  titulo: string;
  descricao: string;
  canonical: string;
  indexavel: boolean;
  og?: { tipo: 'website' | 'product'; imagem?: string | null };
  jsonLd?: unknown;
};

/** Injeta as metas no <head> do index.html (substitui title/description e acrescenta o restante). */
export function aplicarMetas(template: string, meta: MetaPagina): string {
  let html = template.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escaparHtml(meta.titulo)}</title>`);
  html = html.replace(/<meta\s+name="description"[^>]*>\s*/i, '');
  const tags = [
    `<meta name="description" content="${escaparHtml(meta.descricao)}" />`,
    `<link rel="canonical" href="${escaparHtml(meta.canonical)}" />`,
    `<meta name="robots" content="${meta.indexavel ? 'index,follow' : 'noindex,nofollow'}" />`,
    `<meta property="og:title" content="${escaparHtml(meta.titulo)}" />`,
    `<meta property="og:description" content="${escaparHtml(meta.descricao)}" />`,
    `<meta property="og:type" content="${meta.og?.tipo ?? 'website'}" />`,
    `<meta property="og:url" content="${escaparHtml(meta.canonical)}" />`,
    ...(meta.og?.imagem ? [`<meta property="og:image" content="${escaparHtml(meta.og.imagem)}" />`] : []),
    ...(meta.jsonLd ? [`<script type="application/ld+json">${jsonLdSeguro(meta.jsonLd)}</script>`] : []),
  ].join('\n    ');
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `    ${tags}\n  </head>`) : `${tags}${html}`;
}

function carregarTemplate(): string {
  const candidatos = [process.env.CLIENT_DIST_DIR, path.resolve(__dirname, '../../../client/dist')].filter(Boolean) as string[];
  for (const dir of candidatos) {
    const arquivo = path.join(dir, 'index.html');
    if (fs.existsSync(arquivo)) return fs.readFileSync(arquivo, 'utf8');
  }
  return TEMPLATE_MINIMO;
}

function origemAbsoluta(imagem: string | null | undefined, base: string): string | null {
  if (!imagem) return null;
  if (/^https?:\/\//i.test(imagem)) return imagem;
  return imagem.startsWith('/') ? `${base}${imagem}` : null;
}

function resumir(texto: string, max = 160): string {
  const limpo = texto.replace(/\s+/g, ' ').trim();
  return limpo.length <= max ? limpo : `${limpo.slice(0, max - 1).trimEnd()}…`;
}

async function metasDoProduto(empresaId: number, slug: string, base: string): Promise<MetaPagina | null> {
  const { visiveis, projecoes, precos } = await carregarVitrine(empresaId);
  let produto: Record<string, unknown> | null = null;
  let proj: Record<string, unknown> | null = null;
  for (const [pid, p] of visiveis.entries()) {
    const pj = projecoes.get(pid);
    if (pj && String(pj.slug).toLowerCase() === slug) {
      produto = p as Record<string, unknown>;
      proj = pj as Record<string, unknown>;
      break;
    }
  }
  if (!produto || !proj) return null;
  await attachImages(getResource('produtos')!, [produto as never]);
  const preco = precoPublico(produto as never, precos);
  const grade = await disponibilidadesPorTamanho(escopoDeSistema(empresaId), Number(produto.id));
  const emEstoque = grade.some((g) => g.disponivel > 0);
  const nome = String(produto.nome || '');
  const config = await configDaLoja(empresaId);
  const loja = config?.loja_nome ? String(config.loja_nome) : 'BROBOND';
  const descricao = resumir(String(proj.resumo || produto.descricao_curta || produto.descricao || `${nome} — compre na loja ${loja}.`));
  const canonical = `${base}/loja/produto/${encodeURIComponent(String(proj.slug))}`;
  const imagem = origemAbsoluta((produto as { foto_url?: string | null }).foto_url, base);
  return {
    titulo: `${nome} — ${loja}`,
    descricao,
    canonical,
    indexavel: true,
    og: { tipo: 'product', imagem },
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: nome,
      sku: String(produto.sku || ''),
      description: descricao,
      ...(imagem ? { image: [imagem] } : {}),
      offers: {
        '@type': 'Offer',
        url: canonical,
        priceCurrency: 'BRL',
        price: preco.preco.toFixed(2),
        availability: emEstoque ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      },
    },
  };
}

/**
 * Middleware para GET /loja e /loja/produto/:slug (registrar ANTES do fallback
 * do SPA). Nunca lança: em falha inesperada devolve o SPA sem metas.
 */
export async function storefrontSeo(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (req.method !== 'GET') return next();
    const empresaId = await empresaDaVitrine();
    if (!empresaId || !(await configDaLoja(empresaId))) return next();
    const base = await urlBasePublicaAsync(req);
    const template = carregarTemplate();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    const caminho = req.path.replace(/\/+$/, '') || '/';
    if (caminho === '/loja') {
      const config = await configDaLoja(empresaId);
      const loja = config?.loja_nome ? String(config.loja_nome) : 'BROBOND';
      const descricao = config?.loja_descricao ? resumir(String(config.loja_descricao)) : `Loja oficial ${loja}: veja os produtos e compre com pagamento seguro.`;
      res.status(200).send(aplicarMetas(template, { titulo: loja, descricao, canonical: `${base}/loja`, indexavel: true, og: { tipo: 'website' } }));
      return;
    }
    const m = /^\/loja\/produto\/([^/]+)$/.exec(caminho);
    if (!m) return next();
    let slug = '';
    try {
      slug = decodeURIComponent(m[1]).trim().toLowerCase();
    } catch {
      slug = '';
    }
    const meta = slug ? await metasDoProduto(empresaId, slug, base) : null;
    if (!meta) {
      // 404 REAL: produto inexistente, não publicado ou de outro tenant (mesma resposta).
      res.status(404).send(
        aplicarMetas(template, {
          titulo: 'Produto não encontrado',
          descricao: 'Este produto não está disponível na loja.',
          canonical: `${base}/loja`,
          indexavel: false,
        })
      );
      return;
    }
    res.status(200).send(aplicarMetas(template, meta));
  } catch (e) {
    if (e instanceof HttpError) return next();
    console.error('[loja] SEO do storefront falhou; servindo SPA sem metas:', e instanceof Error ? e.message : String(e));
    next();
  }
}

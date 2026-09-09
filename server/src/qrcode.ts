// ============================================================
// QR Code para produtos — gera QR codes que linkam para o catálogo
// público ou para a página de detalhe do produto.
//
// GET /api/produtos/:id/qrcode  → imagem PNG do QR code
// GET /api/produtos/:id/qrcode/svg → SVG do QR code
//
// O QR code contém uma URL que abre:
//   • Catálogo público (se houver catálogo ativo com o produto)
//   • Ou dados estruturados do produto (JSON)
// ============================================================
import type { Request, Response } from 'express';
import QRCode from 'qrcode';
import { filtrosDoCatalogo } from './catalogos';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, getStore } from './services';
import { currentUser } from './auth';
import { parseId } from './validate';
import { attachImages } from './uploads';
import { linkPublico } from './urlPublica';

/**
 * Gera o conteúdo do QR code para um produto: URL pública (se houver catálogo
 * ativo com o produto), SKU, nome e preço.
 *
 * `req` entra só para a URL do QR sair absoluta — uma etiqueta impressa com
 * "/catalogo/abc" não abre no celular de quem escaneia (mesma regra dos links
 * de e-mail: ver server/src/urlPublica.ts).
 */
async function gerarConteudoQR(produtoId: number, req?: Request): Promise<{ url: string; dados: Record<string, unknown> }> {
  const s = getStore();
  const produto = await s.get(getResource('produtos')!, produtoId);
  if (!produto) throw new HttpError(404, 'Produto não encontrado.');

  await attachImages(getResource('produtos')!, [produto]);

  // Tenta encontrar um catálogo público que inclua este produto
  const catalogos = await s.list(getResource('catalogos')!, { page: 1, pageSize: 100, filter: { ativo: true } });
  let urlPublica = '';
  for (const cat of catalogos.rows) {
    const filtros = filtrosDoCatalogo(cat);
    const matchColecao = !filtros.colecao_id || Number(filtros.colecao_id) === Number(produto.colecao_id);
    const matchCategoria = !filtros.categoria_id || Number(filtros.categoria_id) === Number(produto.categoria_id);
    if (matchColecao && matchCategoria) {
      // URL do catálogo público (relative; o front monta a página)
      urlPublica = `/catalogo/${cat.token}`;
      break;
    }
  }

  // Dados estruturados para o QR code
  const dados = {
    sku: produto.sku,
    nome: produto.nome,
    cor: produto.cor_id__label || produto.cor || null,
    categoria: produto.categoria_id__label || null,
    preco: Number(produto.preco_venda || 0),
    foto: produto.foto_url || null,
    ...(urlPublica ? { catalogo: urlPublica } : {}),
  };

  // URL que o QR code aponta: dados JSON codificados em base64 na URL
  // (ou a URL do catálogo se disponível)
  const url = linkPublico(urlPublica || `api/produtos/${produtoId}/qrcode/dados`, req);

  return { url, dados };
}

/** GET /api/produtos/:id/qrcode — QR code em PNG. */
export async function produtoQRCode(req: Request, res: Response) {
  const actor = currentUser(req);
  const r = getResource('produtos')!;
  checkAccess(r, actor, 'read');
  const id = parseId(req.params.id);

  const { url, dados } = await gerarConteudoQR(id, req);
  const size = Math.min(800, Math.max(128, Number(req.query.size) || 300));

  // Se ?format=json, retorna os dados + URL em vez da imagem
  if (req.query.format === 'json') {
    return res.json({ url, dados, size });
  }

  const margin = Number(req.query.margin) || 2;
  const png = await QRCode.toBuffer(url || JSON.stringify(dados), {
    type: 'png',
    width: size,
    margin,
    color: { dark: '#1B2A4A', light: '#FFFFFF' },
    errorCorrectionLevel: 'M',
  });

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Content-Disposition', `inline; filename="qrcode-produto-${id}.png"`);
  res.end(png);
}

/** GET /api/produtos/:id/qrcode/svg — QR code em SVG. */
export async function produtoQRCodeSVG(req: Request, res: Response) {
  const actor = currentUser(req);
  const r = getResource('produtos')!;
  checkAccess(r, actor, 'read');
  const id = parseId(req.params.id);

  const { url, dados } = await gerarConteudoQR(id, req);
  const size = Number(req.query.size) || 300;

  const svg = await QRCode.toString(url || JSON.stringify(dados), {
    type: 'svg',
    width: size,
    margin: 2,
    color: { dark: '#1B2A4A', light: '#FFFFFF' },
    errorCorrectionLevel: 'M',
  });

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.end(svg);
}

/** GET /api/produtos/:id/qrcode/dados — dados JSON do produto (para QR code). */
export async function produtoQRDados(req: Request, res: Response) {
  // Endpoint público (acessível pelo QR code)
  const id = parseId(req.params.id);
  const { dados } = await gerarConteudoQR(id, req);
  res.json(dados);
}

/** GET /api/produtos/:id/qrcode/etiqueta — etiqueta completa com QR + dados (PNG). */
export async function produtoEtiquetaQR(req: Request, res: Response) {
  const actor = currentUser(req);
  const r = getResource('produtos')!;
  checkAccess(r, actor, 'read');
  const id = parseId(req.params.id);

  const s = getStore();
  const produto = await s.get(r, id);
  if (!produto) throw new HttpError(404, 'Produto não encontrado.');

  const { url, dados } = await gerarConteudoQR(id, req);
  const qrPng = await QRCode.toBuffer(url || JSON.stringify(dados), {
    type: 'png',
    width: 180,
    margin: 1,
    color: { dark: '#1B2A4A', light: '#FFFFFF' },
  });

  // Monta etiqueta com canvas (usando svg como proxy)
  const sku = String(produto.sku || '');
  const nome = String(produto.nome || '').slice(0, 40);
  const preco = `R$ ${Number(produto.preco_venda || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
  const cor = String(produto.cor_id__label || produto.cor || '');

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">
  <rect width="400" height="200" fill="white" stroke="#ccc" stroke-width="1" rx="8"/>
  <text x="20" y="30" font-family="Arial" font-size="14" font-weight="bold" fill="#1B2A4A">${sku}</text>
  <text x="20" y="55" font-family="Arial" font-size="12" fill="#333">${nome}</text>
  ${cor ? `<text x="20" y="75" font-family="Arial" font-size="11" fill="#666">Cor: ${cor}</text>` : ''}
  <text x="20" y="${cor ? '95' : '75'}" font-family="Arial" font-size="16" font-weight="bold" fill="#059669">${preco}</text>
  <image href="data:image/png;base64,${qrPng.toString('base64')}" x="260" y="20" width="120" height="120"/>
  <text x="200" y="180" font-family="Arial" font-size="9" fill="#999" text-anchor="middle">Escaneie para mais informações</text>
</svg>`;

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.end(svg);
}

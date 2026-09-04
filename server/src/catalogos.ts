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
import { RESOURCES } from './resources';
import { getStore } from './services';
import type { Row } from './store';
import { attachImages } from './uploads';

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

  const lista: Row[] = produtos.rows.map((p) => {
    const doProduto = estoques.rows.filter((e) => Number(e.produto_id) === Number(p.id));
    const tamanhosLinha = mostrarSaldo
      ? [...new Set(doProduto.map((e) => Number(e.tamanho_id)))]
          .map((tid) => ({
            codigo: tamCodigo.get(tid) || '',
            quantidade: doProduto.filter((e) => Number(e.tamanho_id) === tid).reduce((a, e) => a + Number(e.quantidade || 0), 0),
          }))
          .filter((t) => t.quantidade > 0)
          .sort((a, b) => (a.codigo < b.codigo ? -1 : 1))
      : [];
    return {
      id: Number(p.id),
      sku: p.sku,
      nome: p.nome,
      cor: p.cor_id__label ?? p.cor ?? null,
      cor_hex: p.cor_id__color ?? null,
      composicao: p.composicao ?? null,
      descricao: p.descricao ?? null,
      preco: mostrarPreco ? Number(p.preco_venda || 0) : null,
      foto_url: p.foto_url ?? null,
      fotos: (p.fotos || []).map((f: any) => ({ url: f.url, thumb_url: f.thumb_url })),
      tamanhos: tamanhosLinha,
    };
  });

  res.json({
    nome: catalogo.nome,
    mostrar_preco: mostrarPreco,
    mostrar_saldo: mostrarSaldo,
    total: lista.length,
    produtos: lista,
  });
}

// ============================================================
// Anexos (fotos) de registros — tabela `arquivos`.
//
// O navegador redimensiona a imagem antes de enviar (máx. 1600 px) e manda
// também uma miniatura (240 px), ambas em JPEG/WebP, como base64 em JSON.
// Aqui validamos tipo/tamanho e gravamos em um destes provedores:
//
//   • UPLOAD_PROVIDER=db          (padrão) bytes no Postgres / memória.
//                                 Zero configuração; ideal até alguns
//                                 milhares de fotos (~150 KB cada).
//   • UPLOAD_PROVIDER=cloudinary  envia para o Cloudinary (plano gratuito
//                                 25 GB, CDN, transformações). Requer
//                                 CLOUDINARY_URL=cloudinary://key:secret@cloud
//
// Rotas:
//   GET    /api/files/:id/:token            imagem (pública — a URL contém um token aleatório)
//   GET    /api/:recurso/:id/arquivos       lista de fotos do registro
//   POST   /api/:recurso/:id/arquivos       { nome, mime, dados, thumb }  (base64)
//   PUT    /api/:recurso/:id/arquivos/:fid  { principal?: true, ordem?: n }
//   DELETE /api/:recurso/:id/arquivos/:fid
// ============================================================
import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getPublicResource, getResource, type Resource } from './resources';
import { getStore, checkAccess, toHttpError } from './services';
import { currentUser } from './auth';
import type { FileMeta, Row, Tx } from './store';
import { parseId } from './validate';

const MAX_IMAGE_BYTES = 1_800_000; // 1,8 MB (imagem já reduzida pelo navegador)
const MAX_THUMB_BYTES = 150_000;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);

export type PublicFile = {
  id: number;
  nome: string | null;
  mime: string | null;
  tamanho_bytes: number | null;
  url: string;
  thumb_url: string;
  principal: boolean;
  ordem: number;
  criado_em: string;
};

// ----------------------------------------------------------------------------
// Provedor
// ----------------------------------------------------------------------------
type Cloudinary = { cloud: string; key: string; secret: string };

function cloudinaryConfig(): Cloudinary | null {
  if ((process.env.UPLOAD_PROVIDER || 'db').toLowerCase() !== 'cloudinary') return null;
  const url = process.env.CLOUDINARY_URL || '';
  const m = /^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/.exec(url.trim());
  if (!m) {
    console.warn('⚠️  UPLOAD_PROVIDER=cloudinary mas CLOUDINARY_URL inválida — usando armazenamento no banco.');
    return null;
  }
  return { key: m[1], secret: m[2], cloud: m[3] };
}

export function uploadProvider(): 'db' | 'cloudinary' {
  return cloudinaryConfig() ? 'cloudinary' : 'db';
}

function sign(params: Record<string, string>, secret: string): string {
  const base = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return createHash('sha1').update(base + secret).digest('hex');
}

async function cloudinaryUpload(cfg: Cloudinary, dataUri: string, publicId: string): Promise<{ url: string; thumb: string }> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const folder = process.env.CLOUDINARY_FOLDER || 'brobond';
  const params = { folder, public_id: publicId, timestamp };
  const form = new FormData();
  form.set('file', dataUri);
  form.set('api_key', cfg.key);
  form.set('timestamp', timestamp);
  form.set('folder', folder);
  form.set('public_id', publicId);
  form.set('signature', sign(params, cfg.secret));
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cfg.cloud}/image/upload`, { method: 'POST', body: form });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.secure_url) {
    throw new HttpError(502, `Falha ao enviar a imagem para o Cloudinary: ${json?.error?.message || res.statusText}`);
  }
  const full = `${folder}/${publicId}`;
  const base = `https://res.cloudinary.com/${cfg.cloud}/image/upload`;
  return {
    url: `${base}/q_auto,f_auto/${full}`,
    thumb: `${base}/c_fill,w_240,h_240,q_auto,f_auto/${full}`,
  };
}

async function cloudinaryDestroy(cfg: Cloudinary, publicIdWithFolder: string): Promise<void> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const params = { public_id: publicIdWithFolder, timestamp };
  const form = new FormData();
  form.set('public_id', publicIdWithFolder);
  form.set('api_key', cfg.key);
  form.set('timestamp', timestamp);
  form.set('signature', sign(params, cfg.secret));
  await fetch(`https://api.cloudinary.com/v1_1/${cfg.cloud}/image/destroy`, { method: 'POST', body: form }).catch(() => undefined);
}

// ----------------------------------------------------------------------------
// Utilitários
// ----------------------------------------------------------------------------
function sniffMime(buf: Buffer): string | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function decodeBase64(v: unknown, field: string, max: number): Buffer {
  if (typeof v !== 'string' || !v) throw new HttpError(400, `Campo "${field}" ausente.`);
  const b64 = v.includes(',') ? v.slice(v.indexOf(',') + 1) : v;
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new HttpError(400, `Imagem inválida (${field}).`);
  if (buf.length > max) throw new HttpError(413, `Imagem muito grande (${Math.round(buf.length / 1024)} KB). Máximo: ${Math.round(max / 1024)} KB.`);
  return buf;
}

function ext(mime: string | null): string {
  return mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
}

/** Converte a linha do banco em objeto público com URLs prontas para <img>. */
export function toPublicFile(f: FileMeta | Row): PublicFile {
  const e = ext(f.mime);
  const local = `/api/files/${f.id}/${f.token}.${e}`;
  return {
    id: Number(f.id),
    nome: f.nome ?? null,
    mime: f.mime ?? null,
    tamanho_bytes: f.tamanho_bytes ?? null,
    url: f.url || local,
    thumb_url: f.thumb_url || `${local}?thumb=1`,
    principal: !!f.principal,
    ordem: Number(f.ordem || 0),
    criado_em: f.criado_em,
  };
}

/** Anexa `fotos` (lista) e `foto_url` (miniatura principal) às linhas de um recurso com imagens. */
export async function attachImages(r: Resource, rows: Row[], tx?: Tx): Promise<Row[]> {
  if (!r.images || !rows.length) return rows;
  const files = await getStore().filesFor(r.key, rows.map((x) => Number(x.id)), tx);
  const byId = new Map<number, PublicFile[]>();
  for (const f of files) {
    const list = byId.get(Number(f.registro_id)) || [];
    list.push(toPublicFile(f));
    byId.set(Number(f.registro_id), list);
  }
  for (const row of rows) {
    const list = byId.get(Number(row.id)) || [];
    row.fotos = list;
    row.foto_url = list[0]?.thumb_url ?? null;
  }
  return rows;
}

/** Remove todos os arquivos de um registro (chamado ao excluir o registro). */
export async function removeAllFiles(r: Resource, registroId: number, tx?: Tx): Promise<number> {
  if (!r.images) return 0;
  const s = getStore();
  const arquivos = getResource('arquivos')!;
  const files = await s.filesFor(r.key, [registroId], tx);
  const cfg = cloudinaryConfig();
  for (const f of files) {
    await s.remove(arquivos, Number(f.id), tx);
    if (cfg && f.externo_id) await cloudinaryDestroy(cfg, f.externo_id);
  }
  return files.length;
}

function resourceWithImages(req: Request): Resource {
  const r = getPublicResource(req.params.resource);
  if (!r) throw new HttpError(404, 'Recurso não encontrado');
  if (!r.images) throw new HttpError(405, `${r.label} não aceita fotos.`);
  return r;
}

async function ensureRecord(r: Resource, id: number, tx?: Tx): Promise<Row> {
  const row = await getStore().findOneWhere(r, { id }, tx);
  if (!row) throw new HttpError(404, `${r.singular} não encontrado(a).`);
  return row;
}

async function ownedFile(r: Resource, registroId: number, fileId: number, tx?: Tx): Promise<Row> {
  const f = await getStore().findOneWhere(getResource('arquivos')!, { id: fileId }, tx);
  if (!f || f.recurso !== r.key || Number(f.registro_id) !== registroId) throw new HttpError(404, 'Foto não encontrada.');
  return f;
}

// ----------------------------------------------------------------------------
// Handlers
// ----------------------------------------------------------------------------
export async function listFiles(req: Request, res: Response) {
  const r = resourceWithImages(req);
  checkAccess(r, currentUser(req), 'read');
  const id = parseId(req.params.id);
  await ensureRecord(r, id);
  const files = await getStore().filesFor(r.key, [id]);
  res.json(files.map(toPublicFile));
}

export async function uploadFile(req: Request, res: Response) {
  const r = resourceWithImages(req);
  const actor = currentUser(req);
  checkAccess(r, actor, 'update');
  const id = parseId(req.params.id);
  const body = (req.body || {}) as Record<string, unknown>;

  const dados = decodeBase64(body.dados, 'dados', MAX_IMAGE_BYTES);
  const thumb = decodeBase64(body.thumb ?? body.dados, 'thumb', MAX_THUMB_BYTES);
  const mime = sniffMime(dados);
  if (!mime || !ALLOWED.has(mime) || !sniffMime(thumb)) throw new HttpError(400, 'Envie uma imagem JPEG, PNG ou WebP.');
  const nome = String(body.nome || `foto.${ext(mime)}`).slice(0, 160);

  const s = getStore();
  const arquivos = getResource('arquivos')!;
  try {
    const created = await s.transaction(async (tx) => {
      const rec = await ensureRecord(r, id, tx);
      const existing = await s.filesFor(r.key, [id], tx);
      if (existing.length >= r.images!.max) throw new HttpError(409, `Limite de ${r.images!.max} fotos por ${r.singular.toLowerCase()} atingido. Remova uma antes.`);

      const token = randomBytes(12).toString('hex');
      const cfg = cloudinaryConfig();
      let payload: Record<string, unknown> = {
        recurso: r.key,
        registro_id: id,
        nome,
        mime,
        tamanho_bytes: dados.length,
        token,
        principal: existing.length === 0,
        ordem: existing.length,
        criado_por: actor.id || null,
      };
      if (cfg) {
        const publicId = `${r.key}-${id}-${token}`;
        const up = await cloudinaryUpload(cfg, `data:${mime};base64,${dados.toString('base64')}`, publicId);
        payload = { ...payload, url: up.url, thumb_url: up.thumb, externo_id: `${process.env.CLOUDINARY_FOLDER || 'brobond'}/${publicId}` };
      } else {
        payload = { ...payload, dados, thumb };
      }
      const row = await s.insert(arquivos, payload, tx);
      await s.audit(
        { usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: r.key, registro_id: id, descricao: `Foto "${nome}" incluída em ${r.singular} ${labelFor(r, rec)}`, dados: { foto: nome, bytes: dados.length } },
        tx
      );
      return row;
    });
    res.status(201).json(toPublicFile(created));
  } catch (e) {
    throw toHttpError(e, r);
  }
}

export async function updateFile(req: Request, res: Response) {
  const r = resourceWithImages(req);
  const actor = currentUser(req);
  checkAccess(r, actor, 'update');
  const id = parseId(req.params.id);
  const fid = parseId(req.params.fid);
  const body = (req.body || {}) as Record<string, unknown>;
  const s = getStore();
  const arquivos = getResource('arquivos')!;
  try {
    const out = await s.transaction(async (tx) => {
      await ensureRecord(r, id, tx);
      await ownedFile(r, id, fid, tx);
      if (body.principal === true) {
        const all = await s.filesFor(r.key, [id], tx);
        for (const f of all) if (f.principal && Number(f.id) !== fid) await s.update(arquivos, Number(f.id), { principal: false }, tx);
        await s.update(arquivos, fid, { principal: true, ordem: -1 }, tx);
      }
      if (Array.isArray(body.ordem)) {
        // nova ordem completa: [id1, id2, ...]
        const ids = body.ordem.map(Number).filter((n) => Number.isInteger(n) && n > 0);
        for (let i = 0; i < ids.length; i++) {
          const f = await ownedFile(r, id, ids[i], tx);
          await s.update(arquivos, Number(f.id), { ordem: i }, tx);
        }
      }
      return (await s.filesFor(r.key, [id], tx)).map(toPublicFile);
    });
    res.json(out);
  } catch (e) {
    throw toHttpError(e, r);
  }
}

export async function deleteFile(req: Request, res: Response) {
  const r = resourceWithImages(req);
  const actor = currentUser(req);
  checkAccess(r, actor, 'update');
  const id = parseId(req.params.id);
  const fid = parseId(req.params.fid);
  const s = getStore();
  const arquivos = getResource('arquivos')!;
  try {
    await s.transaction(async (tx) => {
      const rec = await ensureRecord(r, id, tx);
      const f = await ownedFile(r, id, fid, tx);
      await s.remove(arquivos, fid, tx);
      // Se era a principal, promove a próxima
      if (f.principal) {
        const rest = await s.filesFor(r.key, [id], tx);
        if (rest[0]) await s.update(arquivos, Number(rest[0].id), { principal: true }, tx);
      }
      const cfg = cloudinaryConfig();
      if (cfg && f.externo_id) await cloudinaryDestroy(cfg, f.externo_id);
      await s.audit(
        { usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: r.key, registro_id: id, descricao: `Foto "${f.nome}" removida de ${r.singular} ${labelFor(r, rec)}` },
        tx
      );
    });
    res.json({ ok: true });
  } catch (e) {
    throw toHttpError(e, r);
  }
}

/** Serve a imagem armazenada no banco. Rota pública protegida pelo token da URL. */
export async function serveFile(req: Request, res: Response) {
  const id = Number(req.params.id);
  const token = String(req.params.token || '').replace(/\.[a-z0-9]+$/i, '');
  if (!Number.isInteger(id) || id <= 0 || !/^[a-f0-9]{16,}$/i.test(token)) return res.status(404).end();
  const f = await getStore().fileById(id);
  if (!f || f.token !== token) return res.status(404).end();
  if (f.url && !f.dados) return res.redirect(302, req.query.thumb ? f.thumb_url || f.url : f.url);
  const buf: Buffer | null = req.query.thumb && f.thumb ? f.thumb : f.dados;
  if (!buf) return res.status(404).end();
  res.setHeader('Content-Type', f.mime || 'image/jpeg');
  res.setHeader('Content-Length', String(buf.length));
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.end(buf);
}

function labelFor(r: Resource, row: Row): string {
  const parts = r.labelFields.map((k) => row[k]).filter((v) => v !== null && v !== undefined && String(v) !== '');
  return parts.length ? parts.join(' — ') : `#${row.id}`;
}

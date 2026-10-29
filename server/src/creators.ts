// Creators: cadastro próprio, campanhas e parcerias manuais. Sem scraping,
// recomendação algorítmica, envio de mensagens, comissões ou ROI fabricados.
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { currentUser } from './auth';
import { escopoDoAtor } from './empresa';
import { HttpError } from './errors';
import { getResource, type Resource } from './resources';
import { checkAccess, getStore } from './services';
import type { Row, Tx } from './store';
import { diaCivil } from './fuso';
import { domainLock } from './domainLock';
import { R_CREATORS, R_CREATOR_CAMPAIGNS, R_CREATOR_PARTNERSHIPS, R_CREATOR_ATTRIBUTIONS, R_CREATOR_COMMANDS } from './creatorsResources';

type Entity = 'profile' | 'campaign' | 'partnership';
const resources: Record<Entity, Resource> = { profile: R_CREATORS, campaign: R_CREATOR_CAMPAIGNS, partnership: R_CREATOR_PARTNERSHIPS };
function actorOf(req: Request, manage = false) {
  const actor = currentUser(req);
  if (!actor) throw new HttpError(401, 'Autenticação necessária.');
  if (!Number.isSafeInteger(actor.id) || actor.id <= 0 || !['operador', 'gerente', 'admin'].includes(actor.perfil))
    throw new HttpError(403, 'Você não tem permissão para esta ação.');
  if (manage && !['gerente', 'admin'].includes(actor.perfil)) throw new HttpError(403, 'Apenas gerentes e administradores gerenciam parcerias.');
  return { actor, empresaId: escopoDoAtor(actor).empresaId };
}
export function capacidadesCreators(req: Request, res: Response) {
  const { actor, empresaId } = actorOf(req); const manage = ['admin', 'gerente'].includes(actor.perfil);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ empresa_id: empresaId, modulos: {
    creators: { estado: 'ATIVO', fonte: 'creator_profiles', consulta: true, criacao: manage },
    'creator-matches': { estado: 'ATIVO_MANUAL', fonte: 'creator_partnerships', consulta: true, criacao: manage, recomendacao: false },
    'outreach-ai': { estado: 'PENDENTE_DE_CONFIGURACAO', motivo: 'PERSISTENCIA_NAO_INSTALADA', fonte: null, consulta: false, geracao: false, envio: false },
    campanhas: { estado: 'ATIVO', fonte: 'creator_campaigns', consulta: true, criacao: manage },
  } });
}
function id(value: unknown) { const n = Number(value); if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(400, 'Identificador inválido.'); return n; }
function page(value: unknown, fallback: number, max: number) { if (value === undefined) return fallback; const n = Number(value); if (!Number.isInteger(n) || n < 1 || n > max) throw new HttpError(400, 'Paginação inválida.'); return n; }
function text(value: unknown, label: string, min: number, max: number) {
  if (typeof value !== 'string') throw new HttpError(400, `${label} inválido.`);
  const v = value.trim();
  if (v.length < min || v.length > max || Array.from(v).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new HttpError(400, `${label} inválido.`);
  return v;
}
function date(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new HttpError(400, 'Data inválida.');
  return value;
}
function version(value: unknown) { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new HttpError(400, 'Versão esperada inválida.'); return Number(value); }
function key(req: Request) { const k = req.get('Idempotency-Key') || ''; if (!/^[A-Za-z0-9._:-]{8,160}$/.test(k)) throw new HttpError(400, 'Informe Idempotency-Key com 8 a 160 caracteres seguros.'); return k; }
function noCache(res: Response) { res.setHeader('Cache-Control', 'private, no-store'); }
async function find(empresaId: number, entity: Entity, entityId: number, tx?: Tx) {
  const row = await getStore().findOneWhere(resources[entity], { empresa_id: empresaId, id: entityId }, tx);
  if (!row) throw new HttpError(404, 'Registro não encontrado.');
  return row;
}
function bodyFor(entity: Entity, b: Record<string, unknown>, creating: boolean) {
  if (entity === 'profile') {
    const name = text(b.name, 'Nome', 2, 120); const platform = text(b.platform, 'Plataforma', 3, 20);
    if (!['INSTAGRAM', 'TIKTOK', 'YOUTUBE', 'OTHER'].includes(platform)) throw new HttpError(400, 'Plataforma inválida.');
    const handle = text(b.handle, 'Perfil', 1, 100).replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9._-]{1,100}$/.test(handle)) throw new HttpError(400, 'Perfil deve conter letras, números, ponto, hífen ou sublinhado.');
    const niche = b.niche == null || b.niche === '' ? null : text(b.niche, 'Nicho', 1, 100);
    const status = creating ? 'ACTIVE' : text(b.status, 'Situação', 3, 20);
    if (!['ACTIVE', 'INACTIVE'].includes(status)) throw new HttpError(400, 'Situação inválida.');
    return { name, platform, handle, niche, status };
  }
  if (entity === 'campaign') {
    const name = text(b.name, 'Nome', 2, 120); const objective = text(b.objective, 'Objetivo', 8, 500);
    const starts_on = date(b.starts_on); const ends_on = date(b.ends_on);
    if (ends_on < starts_on) throw new HttpError(400, 'Término anterior ao início.');
    const status = creating ? 'DRAFT' : text(b.status, 'Situação', 3, 20);
    if (!['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED'].includes(status)) throw new HttpError(400, 'Situação inválida.');
    return { name, objective, starts_on, ends_on, status };
  }
  if (creating) return { creator_id: id(b.creator_id), campaign_id: id(b.campaign_id), coupon_id: b.coupon_id == null || b.coupon_id === '' ? null : id(b.coupon_id), status: 'PLANNED' };
  const status = text(b.status, 'Situação', 3, 20);
  if (!['PLANNED', 'ACTIVE', 'PAUSED', 'ENDED'].includes(status)) throw new HttpError(400, 'Situação inválida.');
  return { status };
}
const transitions: Record<string, string[]> = {
  DRAFT: ['DRAFT', 'ACTIVE'], ACTIVE: ['ACTIVE', 'PAUSED', 'COMPLETED', 'ENDED'], PAUSED: ['PAUSED', 'ACTIVE', 'COMPLETED', 'ENDED'],
  COMPLETED: ['COMPLETED'], PLANNED: ['PLANNED', 'ACTIVE', 'ENDED'], ENDED: ['ENDED'],
};
async function command(req: Request, entity: Entity, payload: object, execute: (empresaId: number, actorId: number, tx: Tx) => Promise<Row>) {
  const { actor, empresaId } = actorOf(req, true); const s = getStore(); const operationKey = key(req);
  const requestHash = createHash('sha256').update(JSON.stringify({ entity, payload })).digest('hex');
  try {
    return await domainLock(empresaId, 'creators', async (tx) => {
      const previous = await s.findOneWhere(R_CREATOR_COMMANDS, { empresa_id: empresaId, idempotency_key: operationKey }, tx);
      if (previous) {
        if (previous.request_hash !== requestHash || previous.entity !== entity) throw new HttpError(409, 'Chave de idempotência usada com outros dados.');
        return { row: await find(empresaId, entity, Number(previous.entity_id), tx), idempotente: true };
      }
      const row = await execute(empresaId, actor.id, tx);
      await s.insert(R_CREATOR_COMMANDS, { empresa_id: empresaId, idempotency_key: operationKey, request_hash: requestHash,
        entity, entity_id: row.id, created_by: actor.id, created_at: new Date().toISOString() }, tx);
      await s.audit({ empresa_id: empresaId, usuario_id: actor.id, usuario: actor.name, acao: 'ajuste', recurso: resources[entity].key,
        registro_id: Number(row.id), descricao: 'Registro de Creators alterado', dados: { status: row.status, version: row.version } }, tx);
      return { row, idempotente: false };
    });
  } catch (error) {
    if ((error as { code?: string })?.code === '23505') throw new HttpError(409, 'Perfil, parceria ou chave já cadastrados nesta empresa.');
    throw error;
  }
}
export function listCreatorsEntity(entity: Entity) { return async (req: Request, res: Response) => {
  const { empresaId } = actorOf(req); const filter: Record<string, unknown> = { empresa_id: empresaId };
  if (req.query.status) filter.status = text(req.query.status, 'Situação', 1, 20);
  const q = req.query.q == null ? '' : text(req.query.q, 'Busca', 0, 100);
  const out = await getStore().list(resources[entity], { page: page(req.query.page, 1, 100000), pageSize: page(req.query.pageSize, 25, 100), filter, q, sort: 'id', dir: 'desc' });
  noCache(res); res.json(out);
}; }
export function detailCreatorsEntity(entity: Entity) { return async (req: Request, res: Response) => {
  const { empresaId } = actorOf(req); const row = await find(empresaId, entity, id(req.params.id)); noCache(res); res.json(row);
}; }
export function createCreatorsEntity(entity: Entity) { return async (req: Request, res: Response) => {
  const data = bodyFor(entity, req.body || {}, true); const s = getStore();
  const result = await command(req, entity, { operation: 'create', data }, async (empresaId, actorId, tx) => {
    if (entity === 'profile') {
      const profile = data as { platform: string; handle: string };
      const existing = await s.findOneWhere(R_CREATORS, { empresa_id: empresaId, platform: profile.platform, handle: profile.handle }, tx);
      if (existing) throw new HttpError(409, 'Perfil já cadastrado nesta empresa.');
    }
    if (entity === 'partnership') {
      const p = data as { creator_id: number; campaign_id: number; coupon_id: number | null; status: string };
      const creator = await find(empresaId, 'profile', p.creator_id, tx); const campaign = await find(empresaId, 'campaign', p.campaign_id, tx);
      if (creator.status !== 'ACTIVE' || campaign.status === 'COMPLETED') throw new HttpError(409, 'Creator inativo ou campanha concluída.');
      if (await s.findOneWhere(R_CREATOR_PARTNERSHIPS, { empresa_id: empresaId, creator_id: p.creator_id, campaign_id: p.campaign_id }, tx)) throw new HttpError(409, 'Parceria já cadastrada.');
      if (p.coupon_id) {
        const coupon = await s.findOneWhere(getResource('commerce_cupons')!, { empresa_id: empresaId, id: p.coupon_id }, tx);
        if (!coupon) throw new HttpError(404, 'Cupom não encontrado nesta empresa.');
        if (await s.findOneWhere(R_CREATOR_PARTNERSHIPS, { empresa_id: empresaId, coupon_id: p.coupon_id }, tx)) throw new HttpError(409, 'Cupom já pertence a outra parceria.');
      }
    }
    const now = new Date().toISOString();
    return s.insert(resources[entity], { empresa_id: empresaId, ...data, version: 0, created_by: actorId, updated_by: actorId, created_at: now, updated_at: now }, tx);
  });
  noCache(res); res.status(result.idempotente ? 200 : 201).json(result);
}; }
export function updateCreatorsEntity(entity: Entity) { return async (req: Request, res: Response) => {
  const entityId = id(req.params.id); const v = version(req.body?.expected_version); const data = bodyFor(entity, req.body || {}, false); const s = getStore();
  const result = await command(req, entity, { operation: 'update', entityId, expected_version: v, data }, async (empresaId, actorId, tx) => {
    const old = await find(empresaId, entity, entityId, tx);
    if (Number(old.version || 0) !== v) throw new HttpError(409, 'Registro mudou; atualize antes de salvar.');
    if (entity !== 'profile' && !transitions[String(old.status)]?.includes(String(data.status))) throw new HttpError(409, 'Transição de situação não permitida.');
    if (entity === 'campaign' && old.status === 'COMPLETED' && (data.name !== old.name || data.objective !== old.objective || data.starts_on !== old.starts_on || data.ends_on !== old.ends_on))
      throw new HttpError(409, 'Campanha concluída não pode ser reescrita.');
    if (entity === 'profile') {
      const profile = data as { platform: string; handle: string };
      const duplicate = await s.findOneWhere(R_CREATORS, { empresa_id: empresaId, platform: profile.platform, handle: profile.handle }, tx);
      if (duplicate && Number(duplicate.id) !== entityId) throw new HttpError(409, 'Perfil já cadastrado nesta empresa.');
    }
    if (entity === 'partnership' && data.status === 'ACTIVE') {
      const creator = await find(empresaId, 'profile', Number(old.creator_id), tx); const campaign = await find(empresaId, 'campaign', Number(old.campaign_id), tx);
      if (creator.status !== 'ACTIVE' || campaign.status !== 'ACTIVE') throw new HttpError(409, 'Ative o creator e a campanha antes da parceria.');
    }
    const row = await s.tryUpdateIf(resources[entity], entityId, { empresa_id: empresaId, version: old.version ?? null },
      { ...data, version: v + 1, updated_by: actorId, updated_at: new Date().toISOString() }, tx);
    if (!row) throw new HttpError(409, 'Registro mudou; atualize antes de salvar.');
    return row;
  });
  noCache(res); res.json(result);
}; }

/** Atribuição é apenas um vínculo à ordem REAL, sem comissão ou pagamento. */
export async function atribuirCheckoutCreator(empresaId: number, couponId: number, orderId: number, tx: Tx, now = new Date()) {
  const s = getStore();
  const partner = await s.findOneWhere(R_CREATOR_PARTNERSHIPS, { empresa_id: empresaId, coupon_id: couponId, status: 'ACTIVE' }, tx);
  if (!partner) return null;
  const creator = await s.findOneWhere(R_CREATORS, { empresa_id: empresaId, id: partner.creator_id }, tx);
  const campaign = await s.findOneWhere(R_CREATOR_CAMPAIGNS, { empresa_id: empresaId, id: partner.campaign_id }, tx);
  const day = diaCivil(now);
  if (!creator || creator.status !== 'ACTIVE' || !campaign || campaign.status !== 'ACTIVE' || String(campaign.starts_on) > day || String(campaign.ends_on) < day) return null;
  const coupon = await s.findOneWhere(getResource('commerce_cupons')!, { empresa_id: empresaId, id: couponId }, tx);
  const order = await s.findOneWhere(getResource('commerce_pedidos')!, { empresa_id: empresaId, id: orderId }, tx);
  if (!coupon || !order || order.cupom_codigo !== coupon.codigo) throw new HttpError(409, 'Cupom não corresponde ao checkout da empresa.');
  const previous = await s.findOneWhere(R_CREATOR_ATTRIBUTIONS, { empresa_id: empresaId, order_id: orderId }, tx);
  if (previous) {
    if (Number(previous.partnership_id) !== Number(partner.id)) throw new HttpError(409, 'Pedido já atribuído a outra parceria.');
    return previous;
  }
  return s.insert(R_CREATOR_ATTRIBUTIONS, { empresa_id: empresaId, partnership_id: partner.id, order_id: orderId, created_at: now.toISOString() }, tx);
}
export async function listCreatorAttributions(req: Request, res: Response) {
  const { empresaId, actor } = actorOf(req, true); checkAccess(getResource('commerce_pedidos')!, actor, 'read');
  const partnershipId = id(req.params.id); await find(empresaId, 'partnership', partnershipId);
  const s = getStore(); const out = await s.list(R_CREATOR_ATTRIBUTIONS, { page: page(req.query.page, 1, 100000), pageSize: page(req.query.pageSize, 25, 100),
    filter: { empresa_id: empresaId, partnership_id: partnershipId }, sort: 'id', dir: 'desc' });
  const rows = await Promise.all(out.rows.map(async (attribution) => {
    const order = await s.findOneWhere(getResource('commerce_pedidos')!, { empresa_id: empresaId, id: attribution.order_id });
    if (!order) throw new HttpError(409, 'Atribuição sem pedido; revise a integridade dos dados.');
    return { id: attribution.id, order_id: order.id, estado: order.estado, pagamento_estado: order.pagamento_estado,
      total: order.total, criado_em: order.criado_em, atribuido_em: attribution.created_at };
  }));
  noCache(res); res.json({ ...out, rows, criterio: 'Cupom aplicado em checkout após ativação da parceria; não representa comissão ou receita líquida.' });
}

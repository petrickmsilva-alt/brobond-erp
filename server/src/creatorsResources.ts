import type { Field, Resource } from './resources';
const resource = (table: string, fields: [string, string][]): Resource => ({
  key: table, table, label: table, singular: table, labelFields: ['id'], internal: true, empresa: true,
  ops: { create: false, update: false, delete: false }, orderBy: { field: 'id', dir: 'desc' },
  fields: [{ name: 'empresa_id', label: 'Empresa', type: 'integer' },
    ...fields.map(([name, type]) => ({ name, label: name, type, search: type === 'text' && ['name', 'handle', 'niche'].includes(name) }) as Field)],
});
const timestamps: [string, string][] = [['version', 'integer'], ['created_by', 'integer'], ['updated_by', 'integer'], ['created_at', 'datetime'], ['updated_at', 'datetime']];
export const R_CREATORS = resource('creator_profiles', [['name', 'text'], ['platform', 'text'], ['handle', 'text'], ['niche', 'text'], ['status', 'text'], ...timestamps]);
export const R_CREATOR_CAMPAIGNS = resource('creator_campaigns', [['name', 'text'], ['objective', 'text'], ['starts_on', 'date'], ['ends_on', 'date'], ['status', 'text'], ...timestamps]);
export const R_CREATOR_PARTNERSHIPS = resource('creator_partnerships', [['creator_id', 'integer'], ['campaign_id', 'integer'], ['coupon_id', 'integer'], ['status', 'text'], ...timestamps]);
export const R_CREATOR_ATTRIBUTIONS = resource('creator_attributions', [['partnership_id', 'integer'], ['order_id', 'integer'], ['created_at', 'datetime']]);
export const R_CREATOR_COMMANDS = resource('creator_commands', [['idempotency_key', 'text'], ['request_hash', 'text'], ['entity', 'text'], ['entity_id', 'integer'], ['created_by', 'integer'], ['created_at', 'datetime']]);

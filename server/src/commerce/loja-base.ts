// ============================================================================
// BASE DA VITRINE PRÓPRIA (/loja + /api/loja/*) — tenant, config e dono.
//
// O checkout público NÃO tem sessão: a empresa da loja precisa ser resolvida
// de forma DETERMINÍSTICA e fail-closed (nunca adivinhar entre tenants):
//   1. `COMMERCE_LOJA_EMPRESA_ID` (env) — instalações multiempresa;
//   2. exatamente UMA empresa com `commerce_configuracoes` — single-tenant;
//   3. zero ou várias → null (a rota responde 404/409 com instrução clara).
// ============================================================================
import { HttpError } from '../errors';
import { getStore } from '../services';
import { getResource } from '../resources';
import type { Row, Tx } from '../store';
import type { ConfigFrete } from './frete';

const R_CONFIG = () => getResource('commerce_configuracoes')!;
const R_USUARIOS = () => getResource('usuarios')!;
const R_USUARIO_EMPRESAS = () => getResource('usuario_empresas')!;

/**
 * Empresa dona da vitrine pública. Nunca filtra por dado vindo do cliente —
 * só env ou unicidade da configuração.
 */
export async function empresaDaVitrine(): Promise<number | null> {
  const valor = String(process.env.COMMERCE_LOJA_EMPRESA_ID || '').trim();
  const env = Number(valor);
  if (valor) return Number.isSafeInteger(env) && env > 0 ? env : null;
  const s = getStore();
  const configs = await s.list(R_CONFIG(), { page: 1, pageSize: 5, filter: {} });
  if (configs.total === 1) return Number(configs.rows[0].empresa_id);
  if (configs.rows.length === 1 && configs.total === configs.rows.length) return Number(configs.rows[0].empresa_id);
  return null;
}

/** Configuração da loja da empresa (linha única) ou null. */
export async function configDaLoja(empresaId: number, tx?: Tx): Promise<Row | null> {
  const s = getStore();
  return s.findOneWhere(R_CONFIG(), { empresa_id: empresaId }, tx);
}

/**
 * Resolve a empresa da vitrine + configuração, com mensagens honestas:
 * sem configuração → 409 instruindo o go-live; multiempresa sem env → 409.
 */
export async function exigirVitrine(): Promise<{ empresaId: number; config: Row | null }> {
  const empresaId = await empresaDaVitrine();
  if (empresaId) {
    const config = await configDaLoja(empresaId);
    if (config) return { empresaId, config };
    throw new HttpError(409, 'Loja não configurada: cadastre a configuração da loja (Commerce → Loja Própria) para operar a vitrine.');
  }
  const total = (await getStore().list(R_CONFIG(), { page: 1, pageSize: 2 })).total;
  if (total === 0) {
    throw new HttpError(409, 'Loja não configurada: nenhuma empresa tem configuração da vitrine (Commerce → Loja Própria).');
  }
  throw new HttpError(
    409,
    'Vitrine multiempresa sem dono definido: configure COMMERCE_LOJA_EMPRESA_ID apontando para a empresa desta loja.'
  );
}

/**
 * Usuário dono das linhas `sales` do checkout (`sales.usuario_id NOT NULL`):
 *   1. `checkout_usuario_id` explícito da configuração (ativo);
 *   2. admin ativo cujo `usuarios.empresa_id` é a própria empresa;
 *   3. admin ativo com concessão em `usuario_empresas`;
 *   4. falha fechada com instrução — nunca escolhe usuário de outro tenant.
 */
export async function responsavelCheckout(empresaId: number, config: Row | null): Promise<number> {
  const s = getStore();
  if (config?.checkout_usuario_id) {
    const dono = await s.get(R_USUARIOS(), Number(config.checkout_usuario_id));
    const concessao = dono && await s.findOneWhere(R_USUARIO_EMPRESAS(), { usuario_id: Number(dono.id), empresa_id: empresaId });
    if (dono && dono.ativo !== false && (Number(dono.empresa_id) === empresaId || concessao)) return Number(dono.id);
    throw new HttpError(
      409,
      'O responsável pelo checkout configurado está inativo ou não tem acesso à empresa. Ajuste em Commerce → Loja Própria antes de vender.'
    );
  }
  const admins = await s.list(R_USUARIOS(), { page: 1, pageSize: 500, sort: 'id', dir: 'asc', filter: { perfil: 'admin', ativo: true } });
  const daEmpresa = admins.rows.find((u) => Number(u.empresa_id ?? 0) === empresaId);
  if (daEmpresa) return Number(daEmpresa.id);
  const concessoes = await s.list(R_USUARIO_EMPRESAS(), { page: 1, pageSize: 500, sort: 'id', dir: 'asc', filter: { empresa_id: empresaId } });
  const concedidos = new Set(concessoes.rows.map((c) => Number(c.usuario_id)));
  const adminConcedido = admins.rows.find((u) => concedidos.has(Number(u.id)));
  if (adminConcedido) return Number(adminConcedido.id);
  throw new HttpError(
    409,
    'A loja não tem um usuário responsável pelo checkout. Cadastre um administrador para a empresa ou defina o responsável em Commerce → Loja Própria.'
  );
}

/** Configuração de frete tipada para o FreightProvider. */
export function freteDaConfig(config: Row | null): ConfigFrete {
  return {
    frete_provedor: String(config?.frete_provedor || 'nenhum'),
    frete_valor: config?.frete_valor ?? 0,
    frete_gratis_acima: config?.frete_gratis_acima ?? null,
    frete_prazo_dias: config?.frete_prazo_dias ?? null,
  };
}

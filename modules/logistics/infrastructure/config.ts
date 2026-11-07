// ============================================================================
// MOTOR DE FRETE › INFRA › CONFIGURAÇÃO DE TRANSPORTADORAS
//
// CREDENCIAL NUNCA NO CÓDIGO. Toda credencial de transportadora é gravada na
// tabela `configuracoes` (a mesma que o módulo de logística legado já usa),
// CIFRADA com AES-256-GCM (`segredos.ts`). A API devolve apenas a máscara.
//
// Duas fontes, uma verdade:
//   • `logistica_config:<empresa>` — a configuração LEGADA (Melhor Envio /
//     Correios) já usada pela tela de logística. É LIDA aqui para que o motor
//     novo e a tela antiga vejam a MESMA credencial (sem divergência).
//   • `logistics_carrier_config:<empresa>` — o mapa genérico do motor novo,
//     slug → { habilitado, ambiente, credenciais: {…cifradas} }. É o que
//     permite adicionar transportadoras SEM tocar na estrutura legada.
// ============================================================================
import { cifrarSegredo, decifrarSegredo, pareceCifrado } from '../../../server/src/segredos';
import { lerConfig, gravarConfig } from '../../../server/src/configuracoes';
import { obterConfigLogistica } from '../../../server/src/logistica';

export type Ambiente = 'homologacao' | 'producao';

export type ConfigCarrier = {
  slug: string;
  habilitado: boolean;
  ambiente: Ambiente;
  /** credenciais em claro (NUNCA serializadas assim — cifradas ao gravar) */
  credenciais: Record<string, string | null>;
};

type ConfigCarrierArmazenada = {
  slug: string;
  habilitado: boolean;
  ambiente: Ambiente;
  credenciais: Record<string, string | null>;
};

function chaveCarrierConfig(empresaId: number): string {
  const tenant = Number(empresaId);
  if (!Number.isSafeInteger(tenant) || tenant <= 0) {
    throw new Error('A configuração de transportadora exige um empresaId explícito e válido.');
  }
  return `logistics_carrier_config:${tenant}`;
}

/** Slugs cuja credencial vive na configuração legada (evita duplicidade). */
const LEGADO: Record<string, { campos: string[] }> = {
  melhor_envio: { campos: ['me_token'] },
  correios: { campos: ['correios_usuario', 'correios_codigo_administrativo', 'correios_senha'] },
};

type MapaArmazenado = Record<string, ConfigCarrierArmazenada>;

async function lerMapa(empresaId: number): Promise<MapaArmazenado> {
  const bruto = await lerConfig(chaveCarrierConfig(empresaId));
  if (!bruto) return {};
  try {
    const parsed = JSON.parse(bruto) as MapaArmazenado;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Config legada (Melhor Envio / Correios), em claro, para o slug pedido. */
async function configLegada(empresaId: number, slug: string): Promise<ConfigCarrier | null> {
  const spec = LEGADO[slug];
  if (!spec) return null;
  const cfg = await obterConfigLogistica(empresaId);
  const credenciais: Record<string, string | null> = {};
  for (const campo of spec.campos) credenciais[campo] = (cfg as unknown as Record<string, string | null>)[campo] ?? null;
  const temCredencial = spec.campos.some((c) => credenciais[c]);
  return {
    slug,
    habilitado: temCredencial,
    ambiente: cfg.ambiente ?? 'homologacao',
    credenciais,
  };
}

/** Config do slug: mapa novo primeiro; legado como fallback. */
export async function obterConfigCarrier(empresaId: number, slug: string): Promise<ConfigCarrier> {
  const mapa = await lerMapa(empresaId);
  const salvo = mapa[slug];
  if (salvo) {
    const credenciais: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(salvo.credenciais ?? {})) credenciais[k] = decifrarSegredo(v);
    return { slug, habilitado: !!salvo.habilitado, ambiente: salvo.ambiente ?? 'homologacao', credenciais };
  }
  const legado = await configLegada(empresaId, slug);
  if (legado) return legado;
  return { slug, habilitado: false, ambiente: 'homologacao', credenciais: {} };
}

/** Grava (cifrando) as credenciais informadas. Campo ausente preserva o atual. */
export async function salvarConfigCarrier(
  empresaId: number,
  slug: string,
  patch: { habilitado?: boolean; ambiente?: Ambiente; credenciais?: Record<string, string | null> },
  por: string
): Promise<ConfigCarrier> {
  const mapa = await lerMapa(empresaId);
  const atual = await obterConfigCarrier(empresaId, slug);
  const credenciaisClaras: Record<string, string | null> = { ...atual.credenciais };
  for (const [k, v] of Object.entries(patch.credenciais ?? {})) {
    credenciaisClaras[k] = v === null || v === '' ? null : String(v);
  }
  const cifradas: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(credenciaisClaras)) {
    cifradas[k] = v ? (pareceCifrado(v) ? v : cifrarSegredo(v)) : null;
  }
  mapa[slug] = {
    slug,
    habilitado: patch.habilitado ?? atual.habilitado,
    ambiente: patch.ambiente ?? atual.ambiente,
    credenciais: cifradas,
  };
  await gravarConfig(chaveCarrierConfig(empresaId), JSON.stringify(mapa), por);
  return obterConfigCarrier(empresaId, slug);
}

/** Versão para a API: nenhuma credencial volta em claro. */
export function mascararConfigCarrier(cfg: ConfigCarrier): Record<string, unknown> {
  const credenciais: Record<string, string | null> = {};
  const configurado: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(cfg.credenciais)) {
    credenciais[k] = v ? '••••••••' : null;
    configurado[k] = !!v;
  }
  return { slug: cfg.slug, habilitado: cfg.habilitado, ambiente: cfg.ambiente, credenciais, configurado };
}

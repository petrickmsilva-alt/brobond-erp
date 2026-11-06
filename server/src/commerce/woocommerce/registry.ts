// ============================================================================
// COMMERCE OS — WOOCOMMERCE MULTI-STORE › REGISTRY DE LOJAS.
//
// UMA empresa, UM catálogo, DUAS lojas independentes:
//
//   RETAIL     https://brobond.com.br          preço = produtos.preco_venda
//   WHOLESALE  https://atacado.brobond.com.br  preço = produtos.preco_atacado
//
// Os identificadores `RETAIL` e `WHOLESALE` são IMUTÁVEIS: entram no banco
// (woocommerce_product_links.store_key), na chave de idempotência do outbox e
// na referência do pedido importado (WOO-RETAIL-123 / WOO-WHOLESALE-123). Nunca
// são derivados da URL nem do nome da loja — trocar o domínio não reclassifica
// vínculos históricos.
//
// CONFIGURAÇÃO (Render › Environment). Nenhuma credencial é versionada:
//   WOOCOMMERCE_MULTI_STORE_ENABLED  liga o modo multi-loja (default false)
//   WOOCOMMERCE_RETAIL_ENABLED       habilita a loja RETAIL
//   WOOCOMMERCE_RETAIL_URL / _CK / _CS
//   WOOCOMMERCE_WHOLESALE_ENABLED    habilita a loja WHOLESALE
//   WOOCOMMERCE_WHOLESALE_URL / _CK / _CS
//   WOOCOMMERCE_SYNC_DRY_RUN         true = nada é escrito nas lojas
//
// Compatibilidade: com o modo multi-loja DESLIGADO o comportamento é o de
// sempre — `WOOCOMMERCE_URL/CK/CS` (loja única, canal definido por
// WOOCOMMERCE_CANAL). O módulo `loja.ts` continua sendo a implementação desse
// caminho; aqui nada é reimplementado.
// ============================================================================
import { HttpError } from '../../errors';
import { normalizarOrigem, hostInterno } from '../../urlPublica';

/** Identificadores imutáveis das lojas. Ordem estável para relatórios. */
export const STORE_KEYS = ['RETAIL', 'WHOLESALE'] as const;
export type StoreKey = (typeof STORE_KEYS)[number];

export function ehStoreKey(valor: unknown): valor is StoreKey {
  return typeof valor === 'string' && (STORE_KEYS as readonly string[]).includes(valor);
}

/** Rótulo humano (nunca usado como identidade). */
export const STORE_LABEL: Record<StoreKey, string> = {
  RETAIL: 'Varejo (brobond.com.br)',
  WHOLESALE: 'Atacado (atacado.brobond.com.br)',
};

/** Preço de catálogo por loja — a regra comercial da empresa. */
export type FontePreco = 'preco_venda' | 'preco_atacado';
export const FONTE_PRECO: Record<StoreKey, FontePreco> = {
  RETAIL: 'preco_venda',
  WHOLESALE: 'preco_atacado',
};

/** Canal de venda lançado no pedido importado (enum `canal_venda`). */
export type CanalLoja = 'site_varejo' | 'site_atacado';
export const CANAL_PEDIDO: Record<StoreKey, CanalLoja> = {
  RETAIL: 'site_varejo',
  WHOLESALE: 'site_atacado',
};

export type ConfigStore = {
  store_key: StoreKey;
  url: string;
  ck: string;
  cs: string;
  /** Empresa dona da integração. Uma loja nunca serve duas empresas. */
  empresaId: number;
  /** Preço de catálogo desta loja. */
  fontePreco: FontePreco;
  /** Canal lançado no pedido importado desta loja. */
  canal: CanalLoja;
};

export type StatusStore = {
  store_key: StoreKey;
  habilitada: boolean;
  configurada: boolean;
  url: string | null;
  motivo: string | null;
};

function boolEnv(nome: string, padrao = false): boolean {
  const bruto = String(process.env[nome] ?? '').trim().toLowerCase();
  if (!bruto) return padrao;
  return ['1', 'true', 'sim', 'yes', 'on'].includes(bruto);
}

/** Liga o modo multi-loja (RETAIL + WHOLESALE independentes). */
export function multiStoreHabilitado(): boolean {
  return boolEnv('WOOCOMMERCE_MULTI_STORE_ENABLED', false);
}

/** Modo seguro de homologação: nada é escrito nas lojas externas. */
export function dryRun(): boolean {
  return boolEnv('WOOCOMMERCE_SYNC_DRY_RUN', false);
}

function prefixoDe(store: StoreKey): string {
  return `WOOCOMMERCE_${store}`;
}

/**
 * Empresa dona da loja. Explícita por loja; sem ela, cai em
 * WOOCOMMERCE_EMPRESA_ID (integração legada) e, por fim, na empresa padrão
 * (1). A loja NUNCA é compartilhada entre empresas: o valor é resolvido no
 * boot e usado como recorte de leitura e escrita.
 */
export function empresaDaStore(store: StoreKey): number {
  const porLoja = Number(String(process.env[`${prefixoDe(store)}_EMPRESA_ID`] ?? '').trim());
  if (Number.isInteger(porLoja) && porLoja > 0) return porLoja;
  const global = Number(String(process.env.WOOCOMMERCE_EMPRESA_ID ?? '').trim());
  if (Number.isInteger(global) && global > 0) return global;
  return 1;
}

/**
 * Valida a URL da loja contra SSRF. A loja precisa ser um endereço http(s)
 * absoluto e público: apontar a integração para localhost/rede privada
 * permitiria ao ERP buscar recursos internos. `https` é exigido em produção
 * (a autenticação é Basic Auth — credencial em texto sobre http vaza na rede).
 */
export function validarUrlLoja(bruto: unknown, store: StoreKey): string {
  const origem = normalizarOrigem(bruto as string);
  if (!origem) throw new HttpError(409, `A loja ${store} tem URL ausente ou inválida (${prefixoDe(store)}_URL).`);
  let host = '';
  try {
    host = new URL(origem).hostname;
  } catch {
    throw new HttpError(409, `A loja ${store} tem URL inválida (${prefixoDe(store)}_URL).`);
  }
  if (hostInterno(host)) {
    throw new HttpError(
      409,
      `A URL da loja ${store} aponta para a rede interna (${host}). A integração recusa endereços privados — corrija ${prefixoDe(store)}_URL.`
    );
  }
  if (process.env.NODE_ENV === 'production' && !origem.startsWith('https://')) {
    throw new HttpError(409, `A loja ${store} exige HTTPS em produção — a credencial trafega em Basic Auth. Corrija ${prefixoDe(store)}_URL.`);
  }
  return origem;
}

/**
 * Resolve a URL da loja SEM lançar: devolve o motivo quando ela é inválida.
 * `configStore` precisa falhar fechado (null) em vez de estourar — uma URL
 * errada em UMA loja não pode derrubar o painel nem a leitura da outra.
 */
function resolverUrlLoja(store: StoreKey): { url: string | null; motivo: string | null } {
  try {
    return { url: validarUrlLoja(process.env[`${prefixoDe(store)}_URL`], store), motivo: null };
  } catch (e) {
    return { url: null, motivo: e instanceof HttpError ? e.message : 'URL ausente ou inválida.' };
  }
}

/**
 * Configuração de uma loja. `null` quando ela está desabilitada ou incompleta
 * (nunca lança: a ausência de UMA loja não pode derrubar a outra nem o boot).
 */
export function configStore(store: StoreKey): ConfigStore | null {
  if (!boolEnv(`${prefixoDe(store)}_ENABLED`, false)) return null;
  const ck = String(process.env[`${prefixoDe(store)}_CK`] ?? '').trim();
  const cs = String(process.env[`${prefixoDe(store)}_CS`] ?? '').trim();
  if (!ck || !cs) return null;
  const { url } = resolverUrlLoja(store);
  if (!url) return null;
  return {
    store_key: store,
    url,
    ck,
    cs,
    empresaId: empresaDaStore(store),
    fontePreco: FONTE_PRECO[store],
    canal: CANAL_PEDIDO[store],
  };
}

/** Por que a loja não está operacional (para o erro acionável e para o painel). */
export function motivoStore(store: StoreKey): string {
  const prefixo = prefixoDe(store);
  if (!boolEnv(`${prefixo}_ENABLED`, false)) return `Loja desabilitada. Defina ${prefixo}_ENABLED=true.`;
  const ck = String(process.env[`${prefixo}_CK`] ?? '').trim();
  const cs = String(process.env[`${prefixo}_CS`] ?? '').trim();
  if (!ck || !cs) return `Credenciais (CK/CS) ausentes. Defina ${prefixo}_CK e ${prefixo}_CS.`;
  const urlBruta = normalizarOrigem(process.env[`${prefixo}_URL`] as string);
  if (!urlBruta) return `URL ausente ou inválida. Defina ${prefixo}_URL (HTTPS).`;
  const { motivo } = resolverUrlLoja(store);
  if (motivo) return motivo;
  return 'Configuração incompleta.';
}

/** Mesma config, mas falhando fechado com mensagem acionável. */
export function exigirConfigStore(store: StoreKey): ConfigStore {
  const cfg = configStore(store);
  if (cfg) return cfg;
  if (!boolEnv(`${prefixoDe(store)}_ENABLED`, false)) {
    throw new HttpError(409, `A loja ${store} não está habilitada. Defina ${prefixoDe(store)}_ENABLED=true (Render › Environment).`);
  }
  throw new HttpError(409, `A loja ${store} está habilitada mas incompleta. ${motivoStore(store)}.`);
}

/** Lojas habilitadas E completas. */
export function storesConfiguradas(): ConfigStore[] {
  const out: ConfigStore[] = [];
  for (const store of STORE_KEYS) {
    const cfg = configStore(store);
    if (cfg) out.push(cfg);
  }
  return out;
}

/** Diagnóstico por loja (sem credencial): alimenta o painel administrativo. */
export function statusStores(): StatusStore[] {
  return STORE_KEYS.map((store) => {
    const habilitada = boolEnv(`${prefixoDe(store)}_ENABLED`, false);
    const cfg = configStore(store);
    const urlBruta = normalizarOrigem(process.env[`${prefixoDe(store)}_URL`] as string);
    const motivo = cfg ? null : motivoStore(store);
    return { store_key: store, habilitada, configurada: Boolean(cfg), url: cfg?.url ?? (urlBruta || null), motivo };
  });
}

/**
 * Recorte por loja: exige que a loja esteja configurada E pertença à empresa do
 * ator. Devolve a config — nunca a empresa "padrão" implícita.
 */
export function exigirStoreDaEmpresa(store: unknown, empresaId: number): ConfigStore {
  if (!ehStoreKey(store)) throw new HttpError(400, 'Loja inválida.', { store: `Use ${STORE_KEYS.join(' ou ')}` });
  const cfg = exigirConfigStore(store);
  if (cfg.empresaId !== empresaId) throw new HttpError(404, 'Loja não encontrada para esta empresa.');
  return cfg;
}

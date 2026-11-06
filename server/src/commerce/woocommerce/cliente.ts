// ============================================================================
// COMMERCE OS — WOOCOMMERCE MULTI-STORE › CLIENTE HTTP.
//
// Chamadas autenticadas à REST API v3 do WooCommerce (Basic Auth sobre HTTPS),
// sempre com a credencial da LOJA de destino. O cliente:
//
//   • nunca coloca credencial em mensagem de erro (o corpo remoto não é
//     propagado: pode conter token, PII ou dado de pedido);
//   • usa timeout e traduz falha de rede em 502 com texto em português;
//   • respeita o modo de homologação (`WOOCOMMERCE_SYNC_DRY_RUN`): em dry-run
//     nada é escrito na loja — a operação de escrita devolve uma resposta
//     sintética e o chamador registra a intenção.
//
// A validação de URL (SSRF) fica no registry: quando o cliente é construído a
// URL já passou por `validarUrlLoja`.
// ============================================================================
import { HttpError } from '../../errors';
import type { ConfigStore } from './registry';
import { dryRun } from './registry';

const TIMEOUT_MS = Number(process.env.WOOCOMMERCE_TIMEOUT_MS) || 20_000;

export type MetodoWoo = 'GET' | 'POST' | 'PUT' | 'DELETE';

export type OpcoesWoo = {
  method?: MetodoWoo;
  body?: unknown;
  /** Substitui o `fetch` global (testes). */
  fetch?: typeof fetch;
  /** Sobrescreve o timeout (ms). */
  timeoutMs?: number;
};

/** Resultado de uma escrita suprimida pelo modo de homologação. */
export type ResultadoDryRun = { dry_run: true; metodo: MetodoWoo; caminho: string };

function credencial(cfg: ConfigStore): string {
  return Buffer.from(`${cfg.ck}:${cfg.cs}`).toString('base64');
}

/**
 * Uma chamada autenticada. Escritas em dry-run NÃO chegam à rede.
 */
export async function wooStoreFetch<T = unknown>(cfg: ConfigStore, caminho: string, opcoes: OpcoesWoo = {}): Promise<T> {
  const metodo = opcoes.method ?? 'GET';
  const escreve = metodo !== 'GET';
  if (escreve && dryRun()) {
    return { dry_run: true, metodo, caminho } as unknown as T;
  }
  const doFetch = opcoes.fetch ?? fetch;
  const url = `${cfg.url}/wp-json/wc/v3${caminho}`;
  let resp: Response;
  try {
    resp = await doFetch(url, {
      method: metodo,
      signal: AbortSignal.timeout(opcoes.timeoutMs ?? TIMEOUT_MS),
      headers: {
        Authorization: `Basic ${credencial(cfg)}`,
        Accept: 'application/json',
        ...(opcoes.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(opcoes.body === undefined ? {} : { body: JSON.stringify(opcoes.body) }),
    });
  } catch {
    throw new HttpError(502, `Não foi possível falar com a loja ${cfg.store_key} (${cfg.url}). Verifique a conectividade e as credenciais.`);
  }
  const texto = await resp.text();
  if (!resp.ok) {
    // Mensagem de domínio: o corpo remoto NUNCA é propagado.
    if (resp.status === 401 || resp.status === 403) {
      throw new HttpError(
        502,
        `A loja ${cfg.store_key} recusou as credenciais. Confira WOOCOMMERCE_${cfg.store_key}_CK/CS (a chave precisa de permissão de leitura/escrita).`
      );
    }
    if (resp.status === 404) {
      throw new HttpError(502, `A REST API não foi encontrada em ${cfg.url}/wp-json/wc/v3 — o WooCommerce está ativo nesta loja?`);
    }
    throw new HttpError(502, `A loja ${cfg.store_key} respondeu ${resp.status} em ${metodo} ${caminho}.`);
  }
  if (!texto) return null as unknown as T;
  try {
    return JSON.parse(texto) as T;
  } catch {
    return null as unknown as T;
  }
}

/** True quando a resposta é o atalho sintético do modo de homologação. */
export function ehDryRun(valor: unknown): valor is ResultadoDryRun {
  return Boolean(valor && typeof valor === 'object' && (valor as ResultadoDryRun).dry_run === true);
}

/** Teste de conectividade e autenticação (nunca lança: devolve o diagnóstico). */
export async function testarConexao(
  cfg: ConfigStore,
  deps: { fetch?: typeof fetch } = {}
): Promise<{ ok: boolean; erro?: string }> {
  try {
    const resposta = await wooStoreFetch<unknown>(cfg, '/orders?per_page=1', { fetch: deps.fetch });
    return { ok: Array.isArray(resposta) };
  } catch (e) {
    return { ok: false, erro: e instanceof HttpError ? e.message : 'Falha de conexão com a loja.' };
  }
}

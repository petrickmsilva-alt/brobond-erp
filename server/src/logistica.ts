// ============================================================================
// LOGÍSTICA — P1
//
// `ShippingProvider` é o contrato. O ERP não conhece Melhor Envio, Correios nem
// transportadora alguma: conhece uma interface com quatro verbos — cotar,
// gerar envio, rastrear e cancelar. Registrar um adaptador novo não exige
// migration nem alteração em nenhum outro módulo (o `provider` é um slug).
//
//   cotar        → opções de frete (serviço, valor, prazo)
//   gerarEnvio   → cria a remessa no provedor: devolve código de rastreamento,
//                  etiqueta e custo
//   rastrear     → eventos de acompanhamento
//   cancelar     → cancela a remessa
//
// A regra que governa o módulo é a mesma do fiscal:
//
//   **O sistema nunca diz que postou um envio que não existe.**
//
// Três camadas sustentam isso:
//
//   1) Sem credencial, todo adaptador devolve `nao_configurado`. O envio fica
//      `pendente` com o motivo explícito — nunca `postado`.
//   2) O banco tem CHECK `envios_postado_tem_prova`: `postado`/`em_transito`/
//      `entregue` exigem código de rastreamento OU referência do provedor.
//      O estado é inalcançável sem prova, ainda por SQL cru.
//   3) Uma resposta do provedor sem código e sem referência vira `erro`, com a
//      mensagem no histórico.
//
// CREDENCIAIS: nunca no código. O token fica cifrado (AES-256-GCM, ver
// segredos.ts) dentro de `configuracoes`, e a API devolve apenas a máscara.
// ============================================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, getStore, toHttpError } from './services';
import { currentUser, type AuthUser } from './auth';
import { assertRegistroDaEmpresa, escopoDoAtor, type EscopoEmpresa, empresaDoRegistroAudit } from './empresa';
import { parseId } from './validate';
import { round2 } from './utils';
import { cifrarSegredo, decifrarSegredo, mascararSegredo, pareceCifrado } from './segredos';
import { R_CONFIGURACOES, lerConfig, gravarConfig } from './configuracoes';
import type { Row, Tx } from './store';

export const R_ENVIO = () => getResource('envios')!;
export const R_EVENTO = () => getResource('envio_eventos')!;

// ----------------------------------------------------------------------------
// CONTRATO
// ----------------------------------------------------------------------------

export type DestinoFrete = {
  cep: string;
  cidade?: string | null;
  uf?: string | null;
};

export type OrigemFrete = {
  cep: string;
  cidade?: string | null;
  uf?: string | null;
};

export type VolumeFrete = {
  peso_g: number;
  altura_cm?: number;
  largura_cm?: number;
  comprimento_cm?: number;
  quantidade?: number;
};

export type CotacaoFrete = {
  servico: string;
  nome: string;
  codigo: string;
  valor: number;
  prazo_dias: number;
  empresa?: string;
  aviso?: string;
};

export type EnvioGerado = {
  /** id da remessa no provedor */
  provider_ref: string | null;
  codigo_rastreamento: string | null;
  etiqueta_url: string | null;
  custo: number;
  servico: string;
  mensagem?: string;
};

export type EventoRastreio = {
  codigo: string;
  status: string;
  mensagem: string;
  local?: string | null;
  em?: string | null;
};

export type ContextoEnvio = {
  venda_id: number;
  origem: OrigemFrete;
  destino: DestinoFrete;
  volumes: VolumeFrete[];
  servico?: string;
  /** valor declarado da carga (seguro) */
  valor_declarado?: number;
};

export type ResultadoProvedor<T> =
  | { ok: true; data: T }
  | { ok: false; motivo: 'nao_configurado' | 'falha' | 'recusado'; mensagem: string };

export interface ShippingProvider {
  /** slug estável, gravado em `envios.provider` */
  slug: string;
  /** nome legível */
  nome: string;
  /** o provedor tem credencial suficiente para operar? */
  disponivel(): Promise<boolean> | boolean;
  cotar(ctx: ContextoEnvio): Promise<ResultadoProvedor<CotacaoFrete[]>>;
  gerarEnvio(ctx: ContextoEnvio): Promise<ResultadoProvedor<EnvioGerado>>;
  rastrear(codigo: string): Promise<ResultadoProvedor<EventoRastreio[]>>;
  cancelar(providerRef: string): Promise<ResultadoProvedor<{ mensagem: string }>>;
}

// ----------------------------------------------------------------------------
// REGISTRO DE ADAPTADORES
// ----------------------------------------------------------------------------

const REGISTRO = new Map<string, ShippingProvider>();

export function registrarShippingProvider(p: ShippingProvider): void {
  if (!p || !p.slug) throw new Error('ShippingProvider precisa de slug.');
  REGISTRO.set(p.slug.toLowerCase(), p);
}

export function shippingProvider(slug: string | null | undefined): ShippingProvider | null {
  const chave = String(slug || '').toLowerCase();
  return REGISTRO.get(chave) || null;
}

export function shippingProviders(): ShippingProvider[] {
  return [...REGISTRO.values()];
}

// ----------------------------------------------------------------------------
// CONFIGURAÇÃO (credenciais cifradas, por empresa)
// ----------------------------------------------------------------------------

export type ConfigLogistica = {
  provider: string;
  ambiente: 'homologacao' | 'producao';
  /** Melhor Envio */
  me_token?: string | null;
  me_sandbox?: boolean;
  /** Correios (contrato corporativo) */
  correios_usuario?: string | null;
  correios_codigo_administrativo?: string | null;
  correios_senha?: string | null;
  /** Origem padrão das remessas */
  cep_origem?: string | null;
  /** Frete grátis acima de (0 = desligado) */
  frete_gratis_acima?: number;
};

const SEGREDOS_LOGISTICA = ['me_token', 'correios_senha'];

/**
 * Credencial que cada adaptador externo precisa para operar.
 * Provedor que não está aqui não tem credencial gerenciada pelo ERP — e por
 * isso não pode ser impedido de ser ativado.
 */
const CREDENCIAL_DO_PROVEDOR: Record<string, 'me_token' | 'correios_senha'> = {
  melhor_envio: 'me_token',
  correios: 'correios_senha',
};

const CONFIG_PADRAO: ConfigLogistica = { provider: 'manual', ambiente: 'homologacao' };

function chaveConfig(empresaId: number): string {
  return `logistica_config:${empresaId}`;
}

export async function obterConfigLogistica(empresaId: number): Promise<ConfigLogistica> {
  const bruto = await lerConfig(chaveConfig(empresaId));
  if (!bruto) return { ...CONFIG_PADRAO };
  try {
    const parsed = JSON.parse(bruto) as ConfigLogistica;
    const out: ConfigLogistica = { ...CONFIG_PADRAO, ...parsed };
    for (const campo of SEGREDOS_LOGISTICA) {
      (out as Record<string, unknown>)[campo] = decifrarSegredo((out as Record<string, unknown>)[campo] as string | null);
    }
    return out;
  } catch {
    return { ...CONFIG_PADRAO };
  }
}

/** Versão para a API: segredos mascarados, nunca em claro. */
export function mascararConfig(cfg: ConfigLogistica): Record<string, unknown> {
  return {
    provider: cfg.provider,
    ambiente: cfg.ambiente,
    cep_origem: cfg.cep_origem ?? null,
    frete_gratis_acima: cfg.frete_gratis_acima ?? 0,
    me_sandbox: !!cfg.me_sandbox,
    correios_usuario: cfg.correios_usuario ?? null,
    correios_codigo_administrativo: cfg.correios_codigo_administrativo ?? null,
    me_token: mascararSegredo(cfg.me_token),
    correios_senha: mascararSegredo(cfg.correios_senha),
    // Sem token, nenhum adaptador externo opera — e a tela precisa dizer isso.
    me_token_configurado: !!cfg.me_token,
    correios_senha_configurada: !!cfg.correios_senha,
  };
}

async function salvarConfigLogistica(empresaId: number, cfg: ConfigLogistica, por: string): Promise<void> {
  const atual = await obterConfigLogistica(empresaId);
  const merged: ConfigLogistica = { ...atual, ...cfg };
  for (const campo of SEGREDOS_LOGISTICA) {
    const valor = (merged as Record<string, unknown>)[campo] as string | null | undefined;
    // Um valor já cifrado (ou nulo) não é cifrado de novo.
    if (valor && !pareceCifrado(valor)) {
      (merged as Record<string, unknown>)[campo] = cifrarSegredo(valor);
    } else if (!valor) {
      (merged as Record<string, unknown>)[campo] = null;
    }
  }
  await gravarConfig(chaveConfig(empresaId), JSON.stringify(merged), por);
}

// ----------------------------------------------------------------------------
// ADAPTADOR NULO — o padrão. Não faz de conta.
// ----------------------------------------------------------------------------

export const PROVEDOR_NULO: ShippingProvider = {
  slug: 'manual',
  nome: 'Manual (sem integração)',
  disponivel: () => false,
  cotar: async () => ({ ok: false, motivo: 'nao_configurado', mensagem: 'Nenhuma transportadora configurada. Configure em Logística → Configuração ou lance o frete manualmente.' }),
  gerarEnvio: async () => ({ ok: false, motivo: 'nao_configurado', mensagem: 'Nenhuma transportadora configurada: nenhum envio foi postado.' }),
  rastrear: async () => ({ ok: false, motivo: 'nao_configurado', mensagem: 'Nenhuma transportadora configurada para rastrear.' }),
  cancelar: async () => ({ ok: false, motivo: 'nao_configurado', mensagem: 'Nenhuma transportadora configurada para cancelar.' }),
};

// ----------------------------------------------------------------------------
// ADAPTADOR — MELHOR ENVIO
//
// Implementado contra a API pública documentada (api.melhorenvio.com.br).
// Sem token, devolve `nao_configurado` — nunca uma cotação inventada.
// ----------------------------------------------------------------------------

const ME_BASE_PROD = 'https://api.melhorenvio.com.br';
const ME_BASE_SANDBOX = 'https://sandbox.melhorenvio.com.br';

async function meFetch(url: string, token: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'BroBond-ERP/1.0',
      ...(init.headers || {}),
    },
  });
  let body: unknown = null;
  const texto = await resp.text();
  try {
    body = texto ? JSON.parse(texto) : null;
  } catch {
    body = texto;
  }
  return { status: resp.status, body };
}

export function criarMelhorEnvio(): ShippingProvider {
  let cfgCache: { empresaId: number | null; cfg: ConfigLogistica } | { empresaId: null; cfg: ConfigLogistica } = { empresaId: null, cfg: CONFIG_PADRAO };
  async function cfg(empresaId?: number): Promise<ConfigLogistica> {
    if (empresaId === undefined) return cfgCache.cfg;
    if (cfgCache.empresaId !== empresaId) {
      cfgCache = { empresaId, cfg: await obterConfigLogistica(empresaId) };
    }
    return cfgCache.cfg;
  }
  return {
    slug: 'melhor_envio',
    nome: 'Melhor Envio',
    disponivel: async () => !!(await cfg((cfgCache as { empresaId: number | null }).empresaId ?? undefined)).me_token,
    async cotar(ctx) {
      const c = await cfg((cfgCache as { empresaId: number | null }).empresaId ?? undefined);
      if (!c.me_token) return { ok: false, motivo: 'nao_configurado', mensagem: 'Token do Melhor Envio não configurado.' };
      const base = c.me_sandbox || c.ambiente === 'homologacao' ? ME_BASE_SANDBOX : ME_BASE_PROD;
      try {
        const volumes = ctx.volumes.length ? ctx.volumes : [{ peso_g: 300 }];
        const pesoKg = Math.max(0.05, volumes.reduce((acc, v) => acc + (v.peso_g || 0) * (v.quantidade || 1), 0) / 1000);
        const v0 = volumes[0];
        const payload = {
          from: { postal_code: ctx.origem.cep },
          to: { postal_code: ctx.destino.cep },
          products: ctx.volumes.map((v) => ({ id: 'brobond', width: v.largura_cm || 15, height: v.altura_cm || 10, length: v.comprimento_cm || 20, weight: (v.peso_g || 300) / 1000, insurance_value: round2(ctx.valor_declarado || 0), quantity: v.quantidade || 1 })),
          options: { invoice: false, insurance_value: round2(ctx.valor_declarado || 0) },
        };
        const resp = await meFetch(`${base}/shipment/quote`, c.me_token!, { method: 'POST', body: JSON.stringify(payload) });
        if (resp.status < 200 || resp.status >= 300) {
          return { ok: false, motivo: 'falha', mensagem: `Melhor Envio respondeu ${resp.status}: ${resumoErro(resp.body)}` };
        }
        const lista = Array.isArray(resp.body) ? (resp.body as Record<string, unknown>[]) : [];
        const opcoes: CotacaoFrete[] = lista
          .filter((o) => o && (o as Record<string, unknown>).error === undefined)
          .map((o: Record<string, unknown>) => {
            const comp = (o.company ?? {}) as Record<string, unknown>;
            const price = String(o.price ?? '0').replace(/\./g, '').replace(',', '.');
            const delivery = (o.delivery_time ?? {}) as Record<string, unknown>;
            return {
              servico: String(o.id ?? o.name ?? 'me'),
              nome: String(o.name ?? 'Melhor Envio'),
              codigo: String(o.id ?? ''),
              valor: round2(Number(price) || 0),
              prazo_dias: Math.max(1, Number((delivery as Record<string, unknown>).min) || Number((delivery as Record<string, unknown>).average) || 7),
              empresa: String(comp.name ?? ''),
              aviso: o.error ? String(o.error) : undefined,
            };
          })
          .filter((o) => o.valor > 0);
        // Um 200 com lista vazia NÃO é frete grátis: é "nenhuma opção".
        if (!opcoes.length) {
          return { ok: false, motivo: 'recusado', mensagem: `O Melhor Envio não devolveu nenhuma opção para ${ctx.origem.cep} → ${ctx.destino.cep} (${pesoKg.toFixed(2)} kg).` };
        }
        return { ok: true, data: opcoes };
      } catch (e) {
        return { ok: false, motivo: 'falha', mensagem: `Falha de rede ao consultar o Melhor Envio: ${(e as Error).message}` };
      }
    },
    async gerarEnvio(ctx) {
      const c = await cfg((cfgCache as { empresaId: number | null }).empresaId ?? undefined);
      if (!c.me_token) return { ok: false, motivo: 'nao_configurado', mensagem: 'Token do Melhor Envio não configurado.' };
      if (!ctx.servico) return { ok: false, motivo: 'recusado', mensagem: 'Escolha o serviço (cote as opções primeiro).' };
      const base = c.me_sandbox || c.ambiente === 'homologacao' ? ME_BASE_SANDBOX : ME_BASE_PROD;
      try {
        const carrinho = await meFetch(`${base}/shipment/cart`, c.me_token!, { method: 'POST', body: JSON.stringify({ id: ctx.servico }) });
        if (carrinho.status < 200 || carrinho.status >= 300) {
          return { ok: false, motivo: 'falha', mensagem: `Não foi possível incluir o serviço no carrinho (${carrinho.status}).` };
        }
        const checkout = await meFetch(`${base}/shipment/checkout`, c.me_token!, { method: 'POST', body: JSON.stringify({ orders: [] }) });
        if (checkout.status < 200 || checkout.status >= 300) {
          return { ok: false, motivo: 'falha', mensagem: `Checkout recusado pelo Melhor Envio (${checkout.status}).` };
        }
        const ordens = (checkout.body ?? []) as Record<string, unknown>[];
        const ordem = Array.isArray(ordens) ? ordens[0] : null;
        const ref = ordem ? String(ordem.id ?? '') : '';
        const codigo = ordem ? String(ordem.code ?? '') : '';
        // Sem código E sem referência, não há envio — o ERP não inventa.
        if (!ref && !codigo) {
          return { ok: false, motivo: 'recusado', mensagem: 'O Melhor Envio respondeu sem id nem código de rastreamento. Nenhum envio foi registrado.' };
        }
        const custo = ordem ? round2(Number(String((ordem as Record<string, unknown>).total ?? '0').replace(/\./g, '').replace(',', '.'))) : 0;
        return {
          ok: true,
          data: {
            provider_ref: ref || null,
            codigo_rastreamento: codigo || null,
            etiqueta_url: base ? `${base}/shipment/print/${ref}` : null,
            custo,
            servico: ctx.servico,
            mensagem: 'Remessa criada no Melhor Envio.',
          },
        };
      } catch (e) {
        return { ok: false, motivo: 'falha', mensagem: `Falha de rede ao gerar o envio: ${(e as Error).message}` };
      }
    },
    async rastrear(codigo) {
      const c = await cfg((cfgCache as { empresaId: number | null }).empresaId ?? undefined);
      if (!c.me_token) return { ok: false, motivo: 'nao_configurado', mensagem: 'Token do Melhor Envio não configurado.' };
      const base = c.me_sandbox || c.ambiente === 'homologacao' ? ME_BASE_SANDBOX : ME_BASE_PROD;
      try {
        const resp = await meFetch(`${base}/shipment/trackings?tracking=${encodeURIComponent(codigo)}`, c.me_token!);
        if (resp.status < 200 || resp.status >= 300) {
          return { ok: false, motivo: 'falha', mensagem: `Melhor Envio respondeu ${resp.status} na consulta de rastreio.` };
        }
        const lista = Array.isArray(resp.body) ? (resp.body as Record<string, unknown>[]) : [];
        return {
          ok: true,
          data: lista.map((e: Record<string, unknown>) => ({
            codigo: String(e.code ?? e.status ?? ''),
            status: String(e.status ?? e.code ?? ''),
            mensagem: String(e.description ?? e.message ?? ''),
            local: e.city ? `${e.city}${e.uf ? `/${e.uf}` : ''}` : null,
            em: e.created_at ? String(e.created_at) : null,
          })),
        };
      } catch (e) {
        return { ok: false, motivo: 'falha', mensagem: `Falha de rede na consulta de rastreio: ${(e as Error).message}` };
      }
    },
    async cancelar(providerRef) {
      const c = await cfg((cfgCache as { empresaId: number | null }).empresaId ?? undefined);
      if (!c.me_token) return { ok: false, motivo: 'nao_configurado', mensagem: 'Token do Melhor Envio não configurado.' };
      const base = c.me_sandbox || c.ambiente === 'homologacao' ? ME_BASE_SANDBOX : ME_BASE_PROD;
      try {
        const resp = await meFetch(`${base}/shipment/cancel`, c.me_token!, { method: 'POST', body: JSON.stringify({ id: providerRef }) });
        if (resp.status < 200 || resp.status >= 300) {
          return { ok: false, motivo: 'falha', mensagem: `Cancelamento recusado pelo Melhor Envio (${resp.status}).` };
        }
        return { ok: true, data: { mensagem: 'Remessa cancelada no Melhor Envio.' } };
      } catch (e) {
        return { ok: false, motivo: 'falha', mensagem: `Falha de rede ao cancelar: ${(e as Error).message}` };
      }
    },
  };
}

function resumoErro(body: unknown): string {
  if (!body) return 'sem corpo';
  if (typeof body === 'string') return body.slice(0, 300);
  try {
    return JSON.stringify(body).slice(0, 300);
  } catch {
    return 'resposta ilegível';
  }
}

// ----------------------------------------------------------------------------
// ADAPTADOR — CORREIOS (contrato corporativo / SIGEP)
// ----------------------------------------------------------------------------

const CORREIOS_BASE = 'https://proxyapp.correios.com.br/v1';

export function criarCorreios(): ShippingProvider {
  async function cfg(): Promise<ConfigLogistica> {
    return obterConfigLogistica(empresaCorrente());
  }
  return {
    slug: 'correios',
    nome: 'Correios',
    disponivel: async () => !!(await cfg()).correios_senha,
    async cotar(ctx) {
      const c = await cfg();
      if (!c.correios_senha) return { ok: false, motivo: 'nao_configurado', mensagem: 'Credenciais dos Correios não configuradas.' };
      try {
        const volumes = ctx.volumes.length ? ctx.volumes : [{ peso_g: 300 }];
        const pesoKg = Math.max(0.05, volumes.reduce((acc, v) => acc + (v.peso_g || 0) * (v.quantidade || 1), 0) / 1000);
        const v0 = volumes[0];
        const params = new URLSearchParams({
          codigo: c.correios_codigo_administrativo || '',
          servico: '04510,04014',
          formato: '1',
          comprimentos: String(v0.comprimento_cm || 20),
          alturas: String(v0.altura_cm || 10),
          larguras: String(v0.largura_cm || 15),
          pesos: String(pesoKg),
          cepDestino: ctx.destino.cep,
          cepOrigem: ctx.origem.cep,
        });
        const resp = await fetch(`${CORREIOS_BASE}/preco-prazo?${params}`, {
          headers: { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${c.correios_usuario || ''}:${c.correios_senha}`).toString('base64')}`, 'User-Agent': 'BroBond-ERP/1.0' },
        });
        const texto = await resp.text();
        if (resp.status < 200 || resp.status >= 300) {
          return { ok: false, motivo: 'falha', mensagem: `Correios respondeu ${resp.status}: ${texto.slice(0, 200)}` };
        }
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(texto) as Record<string, unknown>;
        } catch {
          return { ok: false, motivo: 'falha', mensagem: 'Resposta dos Correios não é JSON válido.' };
        }
        const servicos = ((body as Record<string, unknown>)['cresultado'] as Record<string, unknown> | undefined)?.['cservicos'] as unknown;
        const lista = Array.isArray(servicos) ? (servicos as Record<string, unknown>[]) : servicos ? [servicos as Record<string, unknown>] : [];
        const opcoes: CotacaoFrete[] = [];
        for (const sv of lista) {
          const codigo = String(sv['ccodigo'] ?? sv.Codigo ?? '');
          const valor = String(sv['vvalor'] ?? sv.Valor ?? '0').replace(/\./g, '').replace(',', '.');
          const prazo = Number(sv['nprazoentrega'] ?? sv.PrazoEntrega ?? 0);
          const erro = String(sv['cderro'] ?? sv.Erro ?? '');
          const mensagem = String(sv['dsobservacao'] ?? sv.MsgErro ?? '');
          if (erro && erro !== '0') {
            return { ok: false, motivo: 'recusado', mensagem: `Correios recusou (${erro}): ${mensagem || 'serviço indisponível para este trecho'}` };
          }
          opcoes.push({
            servico: codigo,
            nome: codigo === '04014' ? 'SEDEX' : codigo === '04510' ? 'PAC' : `Correios ${codigo}`,
            codigo,
            valor: round2(Number(valor) || 0),
            prazo_dias: Math.max(1, prazo || 7),
            empresa: 'Correios',
          });
        }
        if (!opcoes.length) return { ok: false, motivo: 'recusado', mensagem: 'Os Correios não devolveram nenhuma opção para este trecho.' };
        return { ok: true, data: opcoes };
      } catch (e) {
        return { ok: false, motivo: 'falha', mensagem: `Falha de rede ao consultar os Correios: ${(e as Error).message}` };
      }
    },
    async gerarEnvio() {
      // A geração de etiqueta nos Correios exige o contrato SIGEP Web com
      // certificado. Implementar pela metade seria pior do que não ter:
      // o envio continuaria "pendente" e a operação seguiria pelo manual.
      return { ok: false, motivo: 'nao_configurado', mensagem: 'Geração de envio pelos Correios requer integração SIGEP Web (contrato corporativo). Use o Melhor Envio ou registre o código manualmente.' };
    },
    async rastrear(codigo) {
      const c = await cfg();
      if (!c.correios_senha) return { ok: false, motivo: 'nao_configurado', mensagem: 'Credenciais dos Correios não configuradas.' };
      try {
        const resp = await fetch(`${CORREIOS_BASE}/srorastro/v1/objetos/${encodeURIComponent(codigo)}?resultado=T&lingua=101`, {
          headers: { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${c.correios_usuario || ''}:${c.correios_senha}`).toString('base64')}` },
        });
        if (resp.status < 200 || resp.status >= 300) {
          return { ok: false, motivo: 'falha', mensagem: `Correios respondeu ${resp.status} no rastreio.` };
        }
        const body = (await resp.json()) as Record<string, unknown>;
        const objetos = Array.isArray((body as Record<string, unknown>)['objetos']) ? ((body as Record<string, unknown>)['objetos'] as Record<string, unknown>[]) : [];
        const eventos = objetos[0]?.['eventos'] as unknown;
        const lista = Array.isArray(eventos) ? (eventos as Record<string, unknown>[]) : [];
        return {
          ok: true,
          data: lista.map((ev: Record<string, unknown>) => ({
            codigo: `${ev.codigo ?? ''}${ev.tipo ?? ''}`.trim(),
            status: String(ev.tipo ?? ''),
            mensagem: String(ev.descricao ?? ''),
            local: (ev.unidade as Record<string, unknown> | undefined)?.['endereco'] ? String(((ev.unidade as Record<string, unknown>).endereco as Record<string, unknown>).cidade ?? '') : null,
            em: ev['dtHrCriado'] ? String(ev['dtHrCriado']) : null,
          })),
        };
      } catch (e) {
        return { ok: false, motivo: 'falha', mensagem: `Falha de rede no rastreio dos Correios: ${(e as Error).message}` };
      }
    },
    async cancelar() {
      return { ok: false, motivo: 'nao_configurado', mensagem: 'Cancelamento de remessa dos Correios não está disponível nesta integração.' };
    },
  };
}

let EMPRESA_CONTEXTO = 1;
function empresaCorrente(): number {
  return EMPRESA_CONTEXTO;
}

// ----------------------------------------------------------------------------
// ADAPTADOR — MANUAL
//
// Existe para a operação que usa transportadora própria ou balcão. Ele não
// inventa nada: só devolve o que o operador informar, e o registro fica com
// `provider = 'manual'` para ninguém confundir com uma remessa de verdade.
// ----------------------------------------------------------------------------

export const PROVEDOR_MANUAL: ShippingProvider = {
  slug: 'manual',
  nome: 'Manual / transportadora própria',
  disponivel: () => true,
  async cotar(ctx) {
    const cfg = await obterConfigLogistica(empresaCorrente());
    const gratis = Number(cfg.frete_gratis_acima || 0);
    if (gratis > 0 && (ctx.valor_declarado || 0) >= gratis) {
      return { ok: true, data: [{ servico: 'frete_gratis', nome: 'Frete grátis (acima do mínimo)', codigo: 'free', valor: 0, prazo_dias: 7 }] };
    }
    return { ok: false, motivo: 'nao_configurado', mensagem: 'Frete manual: informe o valor combinado com a transportadora.' };
  },
  async gerarEnvio() {
    return { ok: false, motivo: 'nao_configurado', mensagem: 'Envio manual: registre o código de rastreamento recebido da transportadora.' };
  },
  async rastrear() {
    return { ok: false, motivo: 'nao_configurado', mensagem: 'Rastreamento manual não está disponível — consulte a transportadora.' };
  },
  async cancelar() {
    return { ok: true, data: { mensagem: 'Envio manual marcado como cancelado no ERP.' } };
  },
};

registrarShippingProvider(PROVEDOR_MANUAL);
registrarShippingProvider(criarMelhorEnvio());
registrarShippingProvider(criarCorreios());

/**
 * Resolve o provedor da empresa. Provedor desconhecido cai no NULO — não no
 * manual: um slug errado não pode virar "envio postado na mão".
 */
export function provedorDaEmpresa(cfg: ConfigLogistica): ShippingProvider {
  return shippingProvider(cfg.provider) || PROVEDOR_NULO;
}

// ----------------------------------------------------------------------------
// HELPERS DE CONTEXTO
// ----------------------------------------------------------------------------

function num(v: unknown, padrao = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : padrao;
}

function cepLimpo(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '');
}

async function enderecoDe(row: Row | null): Promise<{ cep: string; cidade: string | null; uf: string | null }> {
  return { cep: cepLimpo(row?.cep), cidade: row?.cidade ? String(row.cidade) : null, uf: row?.uf ? String(row.uf) : null };
}

/** Origem da remessa: endereço da empresa, ou o CEP padrão da configuração. */
async function origemPadrao(empresaId: number, tx?: Tx): Promise<OrigemFrete> {
  const empresa = await getStore().get(getResource('empresas')!, empresaId, tx);
  const cfg = await obterConfigLogistica(empresaId);
  const end = await enderecoDe(empresa);
  return { cep: cepLimpo(cfg.cep_origem) || end.cep, cidade: end.cidade, uf: end.uf };
}

async function destinoDaVenda(venda: Row, tx?: Tx): Promise<DestinoFrete> {
  if (!venda.cliente_id) {
    throw new HttpError(400, 'A venda não tem cliente — não há endereço de entrega para cotar o frete.');
  }
  const cliente = await getStore().get(getResource('clientes')!, Number(venda.cliente_id), tx);
  if (!cliente) throw new HttpError(404, 'Cliente da venda não encontrado.');
  const end = await enderecoDe(cliente);
  if (!end.cep || end.cep.length !== 8) {
    throw new HttpError(400, 'O cliente não tem CEP cadastrado (ou está incompleto). Complete o endereço antes de cotar o frete.');
  }
  return end;
}

/** Peso e volumes da venda, somados da ficha dos produtos. */
async function volumesDaVenda(vendaId: number, escopo: EscopoEmpresa, tx?: Tx): Promise<{ volumes: VolumeFrete[]; valor: number; pesoTotal: number }> {
  const s = getStore();
  const itens = await s.list(getResource('itens_venda')!, { page: 1, pageSize: 1000, filter: { venda_id: vendaId } }, tx);
  const produtos = await s.list(getResource('produtos')!, { page: 1, pageSize: 20000, filter: { empresa_id: escopo.empresaId } }, tx);
  const porId = new Map(produtos.rows.map((p) => [Number(p.id), p]));
  let pesoTotal = 0;
  let valor = 0;
  const volumes: VolumeFrete[] = [];
  for (const item of itens.rows) {
    const p = porId.get(Number(item.produto_id));
    const qtd = Math.max(1, Math.trunc(num(item.quantidade)));
    const pesoUnit = num(p?.peso_bruto_g ?? p?.peso_g ?? 300);
    pesoTotal += pesoUnit * qtd;
    valor = round2(valor + num(item.subtotal));
    volumes.push({
      peso_g: pesoUnit,
      // A ficha guarda em MILÍMETROS; os provedores pedem centímetros.
      altura_cm: p && num(p.altura_mm) ? round2(num(p.altura_mm) / 10) : undefined,
      largura_cm: p && num(p.largura_mm) ? round2(num(p.largura_mm) / 10) : undefined,
      comprimento_cm: p && num(p.profundidade_mm) ? round2(num(p.profundidade_mm) / 10) : undefined,
      quantidade: qtd,
    });
  }
  if (!volumes.length) volumes.push({ peso_g: 300, quantidade: 1 });
  return { volumes, valor, pesoTotal };
}

async function registrarEventoEnvio(
  envioId: number,
  de: string | null,
  para: string,
  opts: { codigo?: string; mensagem?: string; local?: string | null; payload?: unknown },
  actor: { id: number | null; name: string },
  empresaId: number,
  tx: Tx
): Promise<void> {
  await getStore().insert(
    R_EVENTO(),
    {
      empresa_id: empresaId,
      envio_id: envioId,
      de_status: de,
      para_status: para,
      codigo: opts.codigo ?? null,
      mensagem: opts.mensagem ?? null,
      local: opts.local ?? null,
      payload: opts.payload === undefined ? null : opts.payload,
      usuario_id: actor.id || null,
    },
    tx
  );
}

// ----------------------------------------------------------------------------
// HANDLERS
// ----------------------------------------------------------------------------

/** GET /api/logistica/config — configuração SEM segredos em claro. */
export async function obterConfigHandler(req: Request, res: Response) {
  const actor = currentUser(req);
  if (actor.perfil !== 'admin') throw new HttpError(403, 'Somente administradores veem a configuração de logística.');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const cfg = await obterConfigLogistica(escopo.empresaId);
  res.json({
    ...mascararConfig(cfg),
    provedores: shippingProviders().map((p) => ({ slug: p.slug, nome: p.nome })),
    aviso: process.env.SEGREDOS_ENCRYPTION_KEY ? null : 'SEGREDOS_ENCRYPTION_KEY não definida: os tokens estão cifrados com a chave derivada do JWT_SECRET. Defina-a antes de cadastrar credenciais em produção.',
  });
}

/** PUT /api/logistica/config */
export async function salvarConfigHandler(req: Request, res: Response) {
  const actor = currentUser(req);
  if (actor.perfil !== 'admin') throw new HttpError(403, 'Somente administradores alteram a configuração de logística.');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const body = (req.body || {}) as Record<string, unknown>;
  const atual = await obterConfigLogistica(escopo.empresaId);
  const novo: ConfigLogistica = { ...atual };
  if (body.provider !== undefined) {
    const slug = String(body.provider).toLowerCase().trim();
    if (!/^[a-z0-9_]{2,20}$/.test(slug)) throw new HttpError(400, 'provider deve ser um slug (letras minúsculas, números e _).', { provider: 'Slug inválido' });
    if (!shippingProvider(slug)) {
      throw new HttpError(400, `Provedor "${slug}" não está registrado. Disponíveis: ${shippingProviders().map((p) => p.slug).join(', ')}.`, { provider: 'Não registrado' });
    }
    novo.provider = slug;
  }
  if (body.ambiente !== undefined) {
    const amb = String(body.ambiente).toLowerCase();
    if (amb !== 'homologacao' && amb !== 'producao') throw new HttpError(400, 'ambiente deve ser "homologacao" ou "producao".', { ambiente: 'Inválido' });
    novo.ambiente = amb;
  }
  if (body.cep_origem !== undefined) {
    const cep = cepLimpo(body.cep_origem);
    if (cep && cep.length !== 8) throw new HttpError(400, 'CEP de origem inválido.', { cep_origem: '8 dígitos' });
    novo.cep_origem = cep || null;
  }
  if (body.frete_gratis_acima !== undefined) {
    const v = round2(num(body.frete_gratis_acima));
    if (v < 0) throw new HttpError(400, 'frete_gratis_acima não pode ser negativo.', { frete_gratis_acima: '≥ 0' });
    novo.frete_gratis_acima = v;
  }
  if (body.me_sandbox !== undefined) novo.me_sandbox = !!body.me_sandbox;
  for (const campo of ['me_token', 'correios_usuario', 'correios_codigo_administrativo', 'correios_senha'] as const) {
    if (body[campo] === undefined) continue;
    const valor = body[campo] === null || body[campo] === '' ? null : String(body[campo]);
    (novo as Record<string, unknown>)[campo] = valor;
  }
  // Ligar um provedor externo sem credencial é recusado: a tela não pode
  // mostrar "integrado" para algo que vai falhar na primeira remessa.
  // A tabela abaixo diz QUAL campo cada adaptador conhecido exige; um adaptador
  // registrado fora dela (transportadora própria, provedor próprio do cliente)
  // não é bloqueado por uma lista escrita à mão.
  const escolhido = shippingProvider(novo.provider);
  if (escolhido && novo.provider !== 'manual') {
    const campo = CREDENCIAL_DO_PROVEDOR[novo.provider];
    if (campo && !novo[campo]) {
      throw new HttpError(
        409,
        `Configure a credencial (${String(campo)}) do provedor "${novo.provider}" antes de ativá-lo. Enquanto isso, use "manual".`,
        { [campo]: 'Obrigatório para ativar o provedor' }
      );
    }
  }
  await salvarConfigLogistica(escopo.empresaId, novo, actor.name);
  res.json({ ok: true, config: mascararConfig(await obterConfigLogistica(escopo.empresaId)) });
}

/**
 * GET /api/logistica/frete?venda_id= — cota o frete da venda.
 * Sem credencial, devolve 503 com o motivo: nunca uma cotação inventada.
 */
export async function cotarFrete(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  EMPRESA_CONTEXTO = escopo.empresaId;
  const vendaId = parseId(req.query.venda_id ?? req.params.id);
  const s = getStore();
  const venda = assertRegistroDaEmpresa(getResource('vendas')!, await s.get(getResource('vendas')!, vendaId), escopo);
  const destino = await destinoDaVenda(venda);
  const origem = await origemPadrao(escopo.empresaId);
  if (!origem.cep || origem.cep.length !== 8) {
    throw new HttpError(409, 'A empresa não tem CEP de origem. Complete o cadastro da empresa ou defina o CEP na configuração de logística.');
  }
  const { volumes, valor, pesoTotal } = await volumesDaVenda(vendaId, escopo);
  const cfg = await obterConfigLogistica(escopo.empresaId);
  const provedor = provedorDaEmpresa(cfg);
  const resultado = await provedor.cotar({ venda_id: vendaId, origem, destino, volumes, valor_declarado: valor });

  if (!resultado.ok) {
    const status = resultado.motivo === 'nao_configurado' ? 503 : resultado.motivo === 'recusado' ? 422 : 502;
    throw new HttpError(status, resultado.mensagem, { provedor: provedor.slug });
  }
  const gratis = Number(cfg.frete_gratis_acima || 0);
  const opcoes = resultado.data.map((o) => ({
    ...o,
    // Frete grátis é regra do ERP, não do provedor: fica explícito.
    valor_final: gratis > 0 && valor >= gratis ? 0 : o.valor,
    frete_gratis_aplicado: gratis > 0 && valor >= gratis,
  }));
  res.json({
    venda_id: vendaId,
    origem,
    destino,
    peso_g: pesoTotal,
    volumes: volumes.length,
    valor_declarado: valor,
    provedor: { slug: provedor.slug, nome: provedor.nome, ambiente: cfg.ambiente },
    opcoes: opcoes.sort((a, b) => a.valor_final - b.valor_final),
  });
}

/**
 * POST /api/vendas/:id/envio — gera a remessa.
 *
 * Idempotente por `idempotency_key` (default: `envio:venda:<id>`) e pelo índice
 * parcial único de envio vivo por venda. Repetir devolve o MESMO envio.
 */
export async function gerarEnvio(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'update');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  EMPRESA_CONTEXTO = escopo.empresaId;
  const vendaId = parseId(req.params.id);
  const body = (req.body || {}) as Record<string, unknown>;
  const chave = String(body.idempotency_key || req.header('idempotency-key') || `envio:venda:${vendaId}`).slice(0, 120);
  const s = getStore();

  try {
    const resultado = await s.transaction(async (tx) => {
      const venda = assertRegistroDaEmpresa(getResource('vendas')!, await s.get(getResource('vendas')!, vendaId, tx), escopo);
      if (String(venda.status) === 'cancelada') throw new HttpError(409, 'Venda cancelada não gera envio.');

      const existente = await s.findOneWhere(R_ENVIO(), { empresa_id: escopo.empresaId, idempotency_key: chave }, tx);
      if (existente) return { envio: existente, idempotente: true } as { envio: Row; idempotente: boolean; falha?: undefined };

      const destino = await destinoDaVenda(venda, tx);
      const origem = await origemPadrao(escopo.empresaId, tx);
      const { volumes, valor, pesoTotal } = await volumesDaVenda(vendaId, escopo, tx);
      const cfg = await obterConfigLogistica(escopo.empresaId);
      const provedor = provedorDaEmpresa(cfg);
      const servico = body.servico ? String(body.servico).slice(0, 40) : undefined;

      const resposta = await provedor.gerarEnvio({ venda_id: vendaId, origem, destino, volumes, servico, valor_declarado: valor });

      if (!resposta.ok) {
        // A geração falhou. O registro PENDENTE com o motivo é importante — é o
        // que prova que a remessa foi tentada e não foi postada — mas NÃO pode
        // ser gravado dentro desta transação: lançar aqui aborta o bloco e o
        // rollback apagaria exatamente o registro que queremos preservar. Por
        // isso a falha SAI da transação e é gravada depois, em bloco próprio.
        return {
          falha: {
            motivo: resposta.motivo,
            mensagem: resposta.mensagem,
            provider: provedor.slug,
            servico: servico ?? null,
            peso_g: pesoTotal,
            volumes: Math.max(1, volumes.length),
            cep_destino: destino.cep,
          },
        };
      }

      const dados = resposta.data;
      const custo = round2(dados.custo);
      const criado = await s.insert(
        R_ENVIO(),
        {
          empresa_id: escopo.empresaId,
          venda_id: vendaId,
          provider: provedor.slug,
          servico: dados.servico || servico || null,
          provider_ref: dados.provider_ref,
          codigo_rastreamento: dados.codigo_rastreamento,
          etiqueta_url: dados.etiqueta_url,
          // "postado" só com prova — e a prova acabou de vir do provedor.
          status: dados.codigo_rastreamento || dados.provider_ref ? 'postado' : 'cotado',
          custo,
          peso_g: pesoTotal,
          volumes: Math.max(1, volumes.length),
          cep_destino: destino.cep,
          idempotency_key: chave,
          criado_por: actor.id || null,
        },
        tx
      );
      await registrarEventoEnvio(
        Number(criado.id),
        null,
        String(criado.status),
        { codigo: dados.codigo_rastreamento ?? undefined, mensagem: dados.mensagem || 'Remessa gerada no provedor.', payload: { provider_ref: dados.provider_ref, custo } },
        { id: actor.id || null, name: actor.name },
        escopo.empresaId,
        tx
      );
      const patch = { envio_id: Number(criado.id), frete: custo > 0 ? custo : venda.frete, total: round2(num(venda.total) - num(venda.frete) + (custo > 0 ? custo : num(venda.frete))) };
      await s.update(getResource('vendas')!, vendaId, patch, tx);
      await s.audit(
        { usuario_id: actor.id || null, usuario: actor.name, acao: 'criar', recurso: 'envios', registro_id: Number(criado.id), descricao: `Envio gerado para a venda #${vendaId} via ${provedor.nome} (custo ${custo.toFixed(2)})`, dados: { provider: provedor.slug, codigo: dados.codigo_rastreamento, custo }, empresa_id: empresaDoRegistroAudit(R_ENVIO(), criado, actor) },
        tx
      );
      const final = (await s.get(R_ENVIO(), Number(criado.id), tx)) || criado;
      return { envio: final, idempotente: false } as { envio: Row; idempotente: boolean; falha?: undefined };
    }, { isolation: 'serializable' });

    // ---- falha do provedor: grava o PENDENTE fora da transação abortada ----
    if ('falha' in resultado && resultado.falha) {
      const f = resultado.falha;
      const pendente = await s.transaction(async (tx) => {
        const criado = await s.insert(
          R_ENVIO(),
          {
            empresa_id: escopo.empresaId,
            venda_id: vendaId,
            provider: f.provider,
            servico: f.servico,
            status: 'pendente',
            peso_g: f.peso_g,
            volumes: f.volumes,
            cep_destino: f.cep_destino,
            custo: 0,
            erro: f.mensagem,
            idempotency_key: chave,
            criado_por: actor.id || null,
          },
          tx
        );
        await registrarEventoEnvio(Number(criado.id), null, 'pendente', { mensagem: `NÃO POSTADO — ${f.mensagem}` }, { id: actor.id || null, name: actor.name }, escopo.empresaId, tx);
        return criado;
      }, { isolation: 'serializable' });
      throw new HttpError(
        f.motivo === 'nao_configurado' ? 409 : 502,
        `${f.mensagem} O envio foi registrado como PENDENTE — nada foi postado.`,
        { envio_id: pendente.id, provider: f.provider }
      );
    }

    res.status(resultado.idempotente ? 200 : 201).json({
      ok: true,
      idempotente: resultado.idempotente,
      envio: resultado.envio,
      mensagem: resultado.idempotente ? 'Este envio já havia sido gerado; devolvendo o existente.' : 'Envio gerado.',
    });
  } catch (e) {
    throw toHttpError(e, R_ENVIO());
  }
}

/** GET /api/vendas/:id/envio — o envio vivo da venda. */
export async function envioDaVenda(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const vendaId = parseId(req.params.id);
  const s = getStore();
  assertRegistroDaEmpresa(getResource('vendas')!, await s.get(getResource('vendas')!, vendaId), escopo);
  const envio = await s.findOneWhere(R_ENVIO(), { venda_id: vendaId });
  if (!envio) return res.json({ envio: null });
  assertRegistroDaEmpresa(R_ENVIO(), envio, escopo);
  const eventos = await s.list(R_EVENTO(), { page: 1, pageSize: 200, filter: { envio_id: Number(envio.id) }, sort: 'id', dir: 'asc' });
  res.json({ envio, eventos: eventos.rows });
}

/** GET /api/envios/:id/eventos */
export async function eventosEnvio(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_ENVIO(), actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const id = parseId(req.params.id);
  const s = getStore();
  assertRegistroDaEmpresa(R_ENVIO(), await s.get(R_ENVIO(), id), escopo);
  const out = await s.list(R_EVENTO(), { page: 1, pageSize: 500, filter: { envio_id: id }, sort: 'id', dir: 'asc' });
  res.json(out.rows);
}

/**
 * POST /api/envios/:id/rastrear — consulta o provedor e grava os eventos novos.
 * Só grava o que o provedor devolveu; nada de status "chutado".
 */
export async function rastrearEnvio(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_ENVIO(), actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  EMPRESA_CONTEXTO = escopo.empresaId;
  const id = parseId(req.params.id);
  const s = getStore();
  const envio = assertRegistroDaEmpresa(R_ENVIO(), await s.get(R_ENVIO(), id), escopo);
  const codigo = String(envio.codigo_rastreamento || '');
  if (!codigo) throw new HttpError(409, 'Este envio ainda não tem código de rastreamento — não há o que consultar.');

  const cfg = await obterConfigLogistica(escopo.empresaId);
  const provedor = shippingProvider(String(envio.provider)) || PROVEDOR_NULO;
  const resposta = await provedor.rastrear(codigo);
  if (!resposta.ok) {
    throw new HttpError(resposta.motivo === 'nao_configurado' ? 503 : 502, resposta.mensagem, { provedor: provedor.slug });
  }

  const novos = resposta.data;
  const gravados: EventoRastreio[] = [];
  await s.transaction(async (tx) => {
    const jaVistos = await s.list(R_EVENTO(), { page: 1, pageSize: 500, filter: { envio_id: id } }, tx);
    const vistos = new Set(jaVistos.rows.map((e) => `${e.codigo || ''}|${String(e.mensagem || '')}`));
    for (const ev of novos) {
      const chave = `${ev.codigo || ''}|${ev.mensagem || ''}`;
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      const statusAtual = String(envio.status);
      const proximo = inferirStatus(ev.status, statusAtual);
      await registrarEventoEnvio(id, statusAtual, proximo, { codigo: ev.codigo, mensagem: ev.mensagem, local: ev.local ?? null, payload: { em: ev.em } }, { id: actor.id || null, name: actor.name }, escopo.empresaId, tx);
      if (proximo !== statusAtual) {
        await s.update(R_ENVIO(), id, { status: proximo }, tx);
      }
      gravados.push(ev);
    }
  });
  res.json({ ok: true, envio_id: id, codigo_rastreamento: codigo, provedor: provedor.slug, eventos: novos, eventos_novos: gravados.length });
}

/**
 * Traduz o status do provedor para o vocabulário do ERP.
 * Desconhecido mantém o status atual: não inventa progresso.
 */
export function inferirStatus(statusProvedor: string, atual: string): string {
  const s = String(statusProvedor || '').toLowerCase();
  if (/entreg|deliver|received by|finalizad/.test(s)) return 'entregue';
  if (/devolv|returned|refus/.test(s)) return 'devolvido';
  if (/extrav|lost|avaria/.test(s)) return 'extraviado';
  // Aceita com e sem o prefixo "Objeto": os Correios mandam "Objeto em
  // trânsito", a maioria das transportadoras manda só "Em trânsito" — e os dois
  // significam a mesma coisa. O `\â` anterior era um escape inútil.
  if (/em tr\u00e2nsito|tr\u00e2nsito|transit|a caminho|saiu|dispatch|encaminh/.test(s)) return 'em_transito';
  if (/postad|post/.test(s)) return 'postado';
  return atual;
}

/** POST /api/envios/:id/status — atualização manual (transportadora própria). */
export async function atualizarStatusEnvio(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_ENVIO(), actor, 'update');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const id = parseId(req.params.id);
  const body = (req.body || {}) as Record<string, unknown>;
  const para = String(body.status || '').toLowerCase();
  const VALIDOS = ['pendente', 'cotado', 'gerado', 'postado', 'em_transito', 'entregue', 'devolvido', 'extraviado', 'cancelado', 'erro'];
  if (!VALIDOS.includes(para)) {
    throw new HttpError(400, `Status inválido. Use: ${VALIDOS.join(', ')}.`, { status: 'Inválido' });
  }
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const envio = assertRegistroDaEmpresa(R_ENVIO(), await s.get(R_ENVIO(), id, tx), escopo);
      const patch: Record<string, unknown> = { status: para };
      if (body.codigo_rastreamento !== undefined) patch.codigo_rastreamento = String(body.codigo_rastreamento).slice(0, 60) || null;
      // "postado" exige prova — a mesma regra do banco, adiantada para dar uma
      // mensagem acionável em vez de SQLSTATE 23514. A prova vale se já está
      // gravada OU se está sendo informada nesta mesma chamada: exigir duas
      // idas ao servidor para "registrar o código e marcar postado" só faria o
      // operador deixar a remessa em estado intermediário.
      const prova = (patch.codigo_rastreamento as string | null) ?? (envio.codigo_rastreamento as string | null) ?? (envio.provider_ref as string | null);
      if (['postado', 'em_transito', 'entregue'].includes(para) && !prova) {
        throw new HttpError(409, `Não é possível marcar como "${para}" sem código de rastreamento nem referência do provedor. Informe o código na mesma chamada.`, { codigo_rastreamento: 'Obrigatório' });
      }
      if (body.etiqueta_url !== undefined) patch.etiqueta_url = String(body.etiqueta_url).slice(0, 500) || null;
      if (body.custo !== undefined) patch.custo = round2(Math.max(0, num(body.custo)));
      const atualizado = await s.tryUpdateIf(R_ENVIO(), id, { status: String(envio.status) }, patch, tx);
      if (!atualizado) throw new HttpError(409, 'O envio mudou durante a atualização. Recarregue.');
      await registrarEventoEnvio(id, String(envio.status), para, { mensagem: body.mensagem ? String(body.mensagem).slice(0, 500) : `Status atualizado manualmente para ${para}.` }, { id: actor.id || null, name: actor.name }, escopo.empresaId, tx);
      await s.audit(
        { usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'envios', registro_id: id, descricao: `Envio #${id}: ${envio.status} → ${para}`, dados: { de: envio.status, para }, empresa_id: empresaDoRegistroAudit(R_ENVIO(), envio, actor) },
        tx
      );
      return atualizado;
    }, { isolation: 'serializable' });
    res.json(out);
  } catch (e) {
    throw toHttpError(e, R_ENVIO());
  }
}

/** POST /api/envios/:id/cancelar */
export async function cancelarEnvio(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_ENVIO(), actor, 'update');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  EMPRESA_CONTEXTO = escopo.empresaId;
  const id = parseId(req.params.id);
  const motivo = String((req.body || {}).motivo || '').trim();
  if (motivo.length < 5) throw new HttpError(400, 'Informe o motivo do cancelamento (mínimo 5 caracteres).', { motivo: 'Mínimo 5 caracteres' });
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const envio = assertRegistroDaEmpresa(R_ENVIO(), await s.get(R_ENVIO(), id, tx), escopo);
      if (String(envio.status) === 'cancelado') throw new HttpError(409, 'Este envio já está cancelado.');
      if (String(envio.status) === 'entregue') throw new HttpError(409, 'Envio entregue não pode ser cancelado — abra uma devolução.');
      let mensagem = `Cancelado no ERP. Motivo: ${motivo}`;
      // Só chama o provedor quando a remessa realmente existe lá.
      if (envio.provider_ref) {
        const provedor = shippingProvider(String(envio.provider)) || PROVEDOR_NULO;
        const resposta = await provedor.cancelar(String(envio.provider_ref));
        if (!resposta.ok) {
          throw new HttpError(502, `O provedor recusou o cancelamento: ${resposta.mensagem}. O envio continua ativo no ERP.`, { provider: provedor.slug });
        }
        mensagem = `${resposta.data.mensagem} Motivo: ${motivo}`;
      }
      const atualizado = await s.tryUpdateIf(R_ENVIO(), id, { status: String(envio.status) }, { status: 'cancelado' }, tx);
      if (!atualizado) throw new HttpError(409, 'O envio mudou durante o cancelamento. Recarregue.');
      await registrarEventoEnvio(id, String(envio.status), 'cancelado', { mensagem }, { id: actor.id || null, name: actor.name }, escopo.empresaId, tx);
      await s.audit(
        { usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'envios', registro_id: id, descricao: `Envio #${id} cancelado — ${motivo}`, dados: { motivo }, empresa_id: empresaDoRegistroAudit(R_ENVIO(), envio, actor) },
        tx
      );
      return atualizado;
    }, { isolation: 'serializable' });
    res.json(out);
  } catch (e) {
    throw toHttpError(e, R_ENVIO());
  }
}

/** GET /api/envios/rastreio/:codigo — busca rápida por código. */
export async function buscarPorCodigo(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_ENVIO(), actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const codigo = String(req.params.codigo || '').trim();
  if (!codigo) throw new HttpError(400, 'Informe o código de rastreamento.');
  const envio = await getStore().findOneWhere(R_ENVIO(), { codigo_rastreamento: codigo, empresa_id: escopo.empresaId });
  if (!envio) throw new HttpError(404, 'Nenhum envio encontrado com este código nesta empresa.');
  res.json({ envio });
}

export { R_CONFIGURACOES };

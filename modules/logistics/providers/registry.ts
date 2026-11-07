// ============================================================================
// MOTOR DE FRETE › ADAPTADORES DE TRANSPORTADORA
//
// ---------------------------------------------------------------------------
// REUSO, NÃO REESCRITA
// ---------------------------------------------------------------------------
// O ERP já tinha o contrato `ShippingProvider` (server/src/logistica.ts) com
// adaptadores REAIS para Melhor Envio (agregador, API pública documentada) e
// Correios (contrato corporativo), além do provedor manual. Reescrever as
// chamadas HTTP seria criar uma segunda arquitetura paralela — proibido.
//
// Aqui esses adaptadores são ADAPTADOS ao contrato novo (`CarrierAdapter`) por
// uma PONTE. O motor novo consome a MESMA implementação, com os MESMOS
// endpoints verificados; a única diferença é o vocabulário de retorno.
//
// ---------------------------------------------------------------------------
// O QUE DEPENDE DE CONTRATO, CREDENCIAL OU HOMOLOGAÇÃO
// ---------------------------------------------------------------------------
// Jadlog, Total Express, Loggi e J&T Express exigem CONTRATO COMERCIAL e
// credenciais (token/usuário) fornecidos por cada operador. Sem contrato
// vigente não há endpoint oficial a que se conectar — e inventar endpoint é
// proibido. Eles nascem como adaptadores ESTRUTURALMENTE COMPLETOS, porém
// DESABILITADOS: sem credencial devolvem `nao_configurado` e o painel mostra
// exatamente o que falta. NÃO são simulados como integração real.
// ============================================================================
import { round2 } from '../../../server/src/utils';
import {
  criarMelhorEnvio,
  criarCorreios,
  PROVEDOR_MANUAL,
  type ShippingProvider,
  type ContextoEnvio,
} from '../../../server/src/logistica';
import { obterConfigCarrier } from '../infrastructure/config';
import { httpExterno, HttpExternaError } from './http';
import {
  registrarCarrier,
  type CarrierAdapter,
  type ContextoOperacao,
  type CotacaoBruta,
  type ResultadoProvedor,
  type EventoRastreioBruto,
  type DisponibilidadeProvedor,
  type CapacidadesProvedor,
} from './contract';

function falha(motivo: 'nao_configurado' | 'falha' | 'recusado', mensagem: string) {
  return { ok: false as const, motivo, mensagem };
}

/** Converte o contexto novo no contexto do contrato legado. */
function contextoLegado(ctx: ContextoOperacao): ContextoEnvio {
  return {
    empresaId: ctx.empresaId,
    venda_id: 0,
    origem: ctx.origem,
    destino: ctx.destino,
    volumes: ctx.volumes,
    servico: ctx.servico,
    valor_declarado: ctx.valorDeclarado,
  };
}

/**
 * Ponte: expõe um `ShippingProvider` (contrato legado, já implementado e
 * verificado) como `CarrierAdapter` (contrato do motor novo).
 */
export function ponteProvedorLegado(
  provedor: ShippingProvider,
  meta: { docUrl?: string; capacidades: CapacidadesProvedor; credenciais: CarrierAdapter['credenciais'] }
): CarrierAdapter {
  return {
    slug: provedor.slug,
    nome: provedor.nome,
    docUrl: meta.docUrl,
    capacidades: meta.capacidades,
    credenciais: meta.credenciais,
    async disponivel(empresaId): Promise<DisponibilidadeProvedor> {
      const ok = await provedor.disponivel(empresaId);
      return { configurado: ok, habilitado: ok, motivo: ok ? null : 'Credencial do operador não configurada.' };
    },
    async cotar(ctx): Promise<ResultadoProvedor<CotacaoBruta[]>> {
      const r = await provedor.cotar(contextoLegado(ctx));
      if (!r.ok) return { ok: false, motivo: r.motivo, mensagem: r.mensagem };
      return {
        ok: true,
        data: r.data.map((o) => ({
          servico: o.servico,
          nome: o.nome,
          codigo: o.codigo,
          valor: round2(o.valor),
          prazo_dias: Math.max(1, Number(o.prazo_dias) || 1),
          empresa: o.empresa,
          aviso: o.aviso,
        })),
      };
    },
    async criarRemessa(ctx): Promise<ResultadoProvedor<import('./contract').RemessaCriada>> {
      const r = await provedor.gerarEnvio(contextoLegado(ctx));
      if (!r.ok) return { ok: false, motivo: r.motivo, mensagem: r.mensagem };
      return {
        ok: true,
        data: {
          provider_ref: r.data.provider_ref,
          codigo_rastreamento: r.data.codigo_rastreamento,
          etiqueta_url: r.data.etiqueta_url,
          custo: round2(r.data.custo),
          servico: r.data.servico,
          mensagem: r.data.mensagem,
        },
      };
    },
    async rastrear(empresaId, codigo): Promise<ResultadoProvedor<EventoRastreioBruto[]>> {
      const r = await provedor.rastrear(empresaId, codigo);
      if (!r.ok) return { ok: false, motivo: r.motivo, mensagem: r.mensagem };
      return {
        ok: true,
        data: r.data.map((e) => ({ codigo: e.codigo, status: e.status, mensagem: e.mensagem, local: e.local, em: e.em })),
      };
    },
    async cancelar(empresaId, providerRef): Promise<ResultadoProvedor<{ mensagem: string }>> {
      const r = await provedor.cancelar(empresaId, providerRef);
      if (!r.ok) return { ok: false, motivo: r.motivo, mensagem: r.mensagem };
      return { ok: true, data: r.data };
    },
  };
}

// ---------------------------------------------------------------------------
// ADAPTADORES REST GENÉRICOS (operadores que exigem contrato/homologação)
//
// NÃO INVENTAMOS ENDPOINTS. A URL base, os caminhos e o token do contrato vêm
// TODOS da configuração do operador (cifrada em `configuracoes`). Enquanto não
// houver contrato vigente + credenciais + homologação, o adaptador devolve
// `nao_configurado` e NÃO chama a rede — o operador permanece DESABILITADO.
//
// Assim, adicionar um operador real é cadastrar os dados do contrato (URL,
// caminhos, token) na tela de configuração, sem tocar no núcleo logístico e
// sem inventar nenhuma superfície de API.
// ---------------------------------------------------------------------------
type SpecRest = {
  slug: string;
  nome: string;
  docUrl?: string;
  capacidades: CapacidadesProvedor;
};

/** Liga/desliga um operador por variável de ambiente (homologação). */
function habilitadoPeloAmbiente(slug: string): boolean {
  const bruto = String(process.env[`LOGISTICS_${slug.toUpperCase()}_ENABLED`] ?? '').trim().toLowerCase();
  return ['1', 'true', 'sim', 'yes', 'on'].includes(bruto);
}

/** Nomes canônicos dos campos de configuração de um operador REST. */
function camposRest(slug: string) {
  const p = slug.toUpperCase();
  return {
    token: `${slug}_token`,
    baseProducao: `${p}_BASE_URL_PRODUCAO`,
    baseHomologacao: `${p}_BASE_URL_HOMOLOGACAO`,
    caminhoCotacao: `${slug}_quote_path`,
    caminhoRastreio: `${slug}_track_path`,
  };
}

function criarAdaptadorRest(spec: SpecRest): CarrierAdapter {
  const campos = camposRest(spec.slug);
  const config = (empresaId: number) => obterConfigCarrier(empresaId, spec.slug);
  const faltando = (c: Record<string, string | null>): string | null => {
    const ausentes = [campos.token, campos.baseProducao, campos.caminhoCotacao, campos.caminhoRastreio].filter((k) => !c[k]);
    return ausentes.length ? ausentes.join(', ') : null;
  };
  return {
    slug: spec.slug,
    nome: spec.nome,
    docUrl: spec.docUrl,
    capacidades: spec.capacidades,
    credenciais: [
      { chave: campos.token, label: 'Token do contrato', obrigatoria: true },
      { chave: campos.baseProducao, label: 'URL base de produção (do contrato)', obrigatoria: true },
      { chave: campos.baseHomologacao, label: 'URL base de homologação', obrigatoria: false },
      { chave: campos.caminhoCotacao, label: 'Caminho da cotação (do contrato)', obrigatoria: true },
      { chave: campos.caminhoRastreio, label: 'Caminho do rastreio (do contrato)', obrigatoria: true },
    ],
    async disponivel(empresaId): Promise<DisponibilidadeProvedor> {
      const cfg = await config(empresaId);
      const falta = faltando(cfg.credenciais);
      if (falta) {
        return {
          configurado: false,
          habilitado: false,
          motivo: `Sem contrato/credencial do ${spec.nome}. Configure: ${falta}. Homologação pendente.`,
        };
      }
      return { configurado: true, habilitado: cfg.habilitado, motivo: cfg.habilitado ? null : 'Credencial presente, integração desligada (homologação pendente).' };
    },
    async cotar(ctx): Promise<ResultadoProvedor<CotacaoBruta[]>> {
      const cfg = await config(ctx.empresaId);
      const falta = faltando(cfg.credenciais);
      if (falta) return falha('nao_configurado', `Credencial do ${spec.nome} incompleta (${falta}).`);
      if (!cfg.habilitado && !habilitadoPeloAmbiente(spec.slug)) {
        return falha('nao_configurado', `A integração ${spec.nome} está desabilitada até a homologação.`);
      }
      const base = cfg.ambiente === 'producao' ? cfg.credenciais[campos.baseProducao] : cfg.credenciais[campos.baseHomologacao] ?? cfg.credenciais[campos.baseProducao];
      const token = cfg.credenciais[campos.token];
      const caminho = cfg.credenciais[campos.caminhoCotacao];
      try {
        const resp = await httpExterno(`${base}${caminho}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: { cepOrigem: ctx.origem.cep, cepDestino: ctx.destino.cep, peso: ctx.pesoTotalG / 1000, volumes: ctx.volumes.length },
        });
        if (!resp.ok) return falha('falha', `${spec.nome} respondeu ${resp.status} à cotação.`);
        const opcoes = mapearRestGenerico(resp.body);
        if (!opcoes.length) return falha('recusado', `${spec.nome} não devolveu nenhuma opção para este trecho.`);
        return { ok: true, data: opcoes };
      } catch (e) {
        return falha('falha', e instanceof HttpExternaError ? e.message : `Falha de rede ao consultar ${spec.nome}.`);
      }
    },
    async rastrear(empresaId, codigo): Promise<ResultadoProvedor<EventoRastreioBruto[]>> {
      const cfg = await config(empresaId);
      const falta = faltando(cfg.credenciais);
      if (falta) return falha('nao_configurado', `Credencial do ${spec.nome} incompleta (${falta}).`);
      if (!cfg.habilitado && !habilitadoPeloAmbiente(spec.slug)) {
        return falha('nao_configurado', `A integração ${spec.nome} está desabilitada até a homologação.`);
      }
      const base = cfg.ambiente === 'producao' ? cfg.credenciais[campos.baseProducao] : cfg.credenciais[campos.baseHomologacao] ?? cfg.credenciais[campos.baseProducao];
      const token = cfg.credenciais[campos.token];
      const caminho = String(cfg.credenciais[campos.caminhoRastreio] ?? '').replace('{codigo}', encodeURIComponent(codigo));
      try {
        const resp = await httpExterno(`${base}${caminho}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!resp.ok) return falha('falha', `${spec.nome} respondeu ${resp.status} no rastreio.`);
        return { ok: true, data: mapearRastreioGenerico(resp.body) };
      } catch (e) {
        return falha('falha', e instanceof HttpExternaError ? e.message : `Falha de rede no rastreio ${spec.nome}.`);
      }
    },
  };
}

/** Mapeia respostas REST heterogêneas para o formato interno (defensivo). */
function mapearRestGenerico(body: unknown): CotacaoBruta[] {
  const b = (body ?? {}) as Record<string, unknown>;
  const lista = Array.isArray(body) ? body : Array.isArray(b.services) ? b.services : Array.isArray(b.options) ? b.options : [];
  return lista
    .map((o) => {
      const r = o as Record<string, unknown>;
      const valor = round2(Number(String(r.valor ?? r.price ?? r.value ?? '0').replace(/\./g, '').replace(',', '.')) || 0);
      if (valor <= 0) return null;
      return {
        servico: String(r.servico ?? r.service ?? r.code ?? ''),
        nome: String(r.nome ?? r.name ?? 'Serviço'),
        codigo: String(r.codigo ?? r.code ?? r.id ?? ''),
        valor,
        prazo_dias: Math.max(1, Number(r.prazo ?? r.delivery_time ?? r.prazo_dias ?? 7) || 7),
        empresa: String(r.empresa ?? r.carrier ?? ''),
      } as CotacaoBruta;
    })
    .filter((o): o is CotacaoBruta => o !== null);
}

function mapearRastreioGenerico(body: unknown): EventoRastreioBruto[] {
  const b = (body ?? {}) as Record<string, unknown>;
  const lista = Array.isArray(body) ? body : Array.isArray(b.events) ? b.events : Array.isArray(b.tracking) ? b.tracking : [];
  return lista.map((e) => {
    const r = e as Record<string, unknown>;
    const quando = r.data ?? r.date ?? r.created_at;
    return {
      codigo: String(r.codigo ?? r.code ?? ''),
      status: String(r.status ?? r.descricao ?? ''),
      mensagem: String(r.mensagem ?? r.description ?? r.descricao ?? ''),
      local: r.local ? String(r.local) : null,
      em: quando ? String(quando) : null,
      bruto: e,
    };
  });
}

// Os operadores abaixo exigem CONTRATO COMERCIAL e credenciais próprias. NÃO
// há endpoint público a que se conectar antes disso — e inventar endpoint é
// proibido. Por isso o adaptador é ESTRUTURALMENTE completo, mas a URL base, os
// caminhos e o token vêm da CONFIGURAÇÃO DO CONTRATO (cifrada). Sem eles, o
// operador permanece DESABILITADO e devolve `nao_configurado` com o que falta.
export const jadlogAdapter = criarAdaptadorRest({
  slug: 'jadlog',
  nome: 'Jadlog',
  docUrl: 'https://www.jadlog.com.br/central-de-ajuda',
  capacidades: { cotacao: true, remessa: false, etiqueta: false, rastreio: true, cancelamento: false, webhook: true },
});

export const totalExpressAdapter = criarAdaptadorRest({
  slug: 'total_express',
  nome: 'Total Express',
  capacidades: { cotacao: true, remessa: false, etiqueta: false, rastreio: true, cancelamento: false, webhook: true },
});

export const loggiAdapter = criarAdaptadorRest({
  slug: 'loggi',
  nome: 'Loggi',
  docUrl: 'https://docs.loggi.com',
  capacidades: { cotacao: true, remessa: false, etiqueta: false, rastreio: true, cancelamento: false, webhook: true },
});

export const jtExpressAdapter = criarAdaptadorRest({
  slug: 'jt_express',
  nome: 'J&T Express',
  capacidades: { cotacao: true, remessa: false, etiqueta: false, rastreio: true, cancelamento: false, webhook: true },
});

// ---------------------------------------------------------------------------
// REGISTRO — chamado no boot do módulo.
// ---------------------------------------------------------------------------
let registrado = false;
export function registrarCarriers(): void {
  if (registrado) return;
  registrado = true;
  registrarCarrier(
    ponteProvedorLegado(PROVEDOR_MANUAL, {
      capacidades: { cotacao: false, remessa: false, etiqueta: false, rastreio: false, cancelamento: true, webhook: false },
      credenciais: [],
    })
  );
  registrarCarrier(
    ponteProvedorLegado(criarMelhorEnvio(), {
      docUrl: 'https://docs.melhorenvio.com.br',
      capacidades: { cotacao: true, remessa: true, etiqueta: true, rastreio: true, cancelamento: true, webhook: false },
      credenciais: [{ chave: 'me_token', label: 'Token de acesso (Bearer)', obrigatoria: true }],
    })
  );
  registrarCarrier(
    ponteProvedorLegado(criarCorreios(), {
      docUrl: 'https://www.correios.com.br/atendimento/developers',
      capacidades: { cotacao: true, remessa: false, etiqueta: false, rastreio: true, cancelamento: false, webhook: false },
      credenciais: [
        { chave: 'correios_usuario', label: 'Usuário do contrato', obrigatoria: true },
        { chave: 'correios_senha', label: 'Senha do contrato', obrigatoria: true },
        { chave: 'correios_codigo_administrativo', label: 'Código administrativo', obrigatoria: false },
      ],
    })
  );
  registrarCarrier(jadlogAdapter);
  registrarCarrier(totalExpressAdapter);
  registrarCarrier(loggiAdapter);
  registrarCarrier(jtExpressAdapter);
}

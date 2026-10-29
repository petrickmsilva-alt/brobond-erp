// ============================================================================
// COMMERCE OS — FRETE (FreightProvider).
//
// O Commerce NÃO inventa preço de transportadora. Existem exatamente três
// posturas configuradas em `commerce_configuracoes.frete_provedor`:
//
//   • 'nenhum'   → orçamento INDISPONÍVEL: a cotação responde com a mensagem
//                  "Frete não configurado" (o front exibe sem número falso);
//   • 'retirada' → retirada na loja, valor 0 (regra real de negócio);
//   • 'manual'   → valor/prazo tabelados pela empresa (frete CIF por tabela).
//
// O cálculo de prazo/valor do ERP (ViaCEP/PAC/SEDEX — server/src/frete.ts)
// continua sendo o motor de COTAÇÃO de transportadora; ele entra aqui quando a
// empresa configurar esse provedor — nunca é chamado "para encher tela".
// ============================================================================
import { HttpError } from '../errors';
import { round2 } from './regras';

export type ConfigFrete = {
  frete_provedor: string;
  frete_valor?: number | string | null;
  frete_gratis_acima?: number | string | null;
  frete_prazo_dias?: number | string | null;
};

export type CotacaoFrete =
  | {
      disponivel: true;
      provedor: 'retirada' | 'manual' | 'transportadora';
      valor: number;
      gratis: boolean;
      prazoDias: number | null;
      observacao?: string;
    }
  | {
      disponivel: false;
      provedor: string;
      motivo: 'Frete não configurado';
    };

export interface FreightProvider {
  readonly id: 'nenhum' | 'retirada' | 'manual';
  cotar(input: { subtotal: number; cep?: string | null }): Promise<CotacaoFrete>;
}

/** Sem frete configurado — NUNCA devolve número. */
export const freteNaoConfigurado: FreightProvider = {
  id: 'nenhum',
  async cotar() {
    return { disponivel: false, provedor: 'nenhum', motivo: 'Frete não configurado' };
  },
};

/** Retirada na loja: valor 0, sem prazo de entrega. */
export const freteRetirada: FreightProvider = {
  id: 'retirada',
  async cotar() {
    return { disponivel: true, provedor: 'retirada', valor: 0, gratis: true, prazoDias: null, observacao: 'Retirada na loja.' };
  },
};

/** Configuração inválida nunca vira frete zero/NaN, mesmo em linhas legadas. */
export function configuracaoFreteValida(cfg: ConfigFrete | null | undefined): boolean {
  if (cfg?.frete_provedor === 'retirada') return true;
  if (cfg?.frete_provedor !== 'manual') return false;
  const valor = Number(cfg.frete_valor);
  const limite = cfg.frete_gratis_acima;
  const prazo = cfg.frete_prazo_dias;
  return Number.isFinite(valor) && round2(valor) > 0
    && (limite == null || limite === '' || (Number.isFinite(Number(limite)) && Number(limite) >= 0))
    && (prazo == null || prazo === '' || (Number.isInteger(Number(prazo)) && Number(prazo) >= 0 && Number(prazo) <= 120));
}

export function validarConfiguracaoFrete(cfg: ConfigFrete): void {
  if (cfg.frete_provedor !== 'nenhum' && !configuracaoFreteValida(cfg)) {
    throw new HttpError(400, 'Configuração de frete inválida: informe uma tabela com valor positivo, limite válido e prazo de 0 a 120 dias, ou selecione retirada.', { frete_valor: 'Revise a configuração de frete.' });
  }
}

/** Tabela manual da empresa (frete CIF com valor e prazo configurados). */
export function freteManual(cfg: ConfigFrete): FreightProvider {
  return {
    id: 'manual',
    async cotar({ subtotal }) {
      if (!configuracaoFreteValida(cfg) || !Number.isFinite(subtotal) || subtotal < 0) return freteNaoConfigurado.cotar({ subtotal });
      const valor = Math.max(0, round2(Number(cfg.frete_valor ?? 0)));
      const gratisAcima = cfg.frete_gratis_acima == null || cfg.frete_gratis_acima === '' ? null : Math.max(0, round2(Number(cfg.frete_gratis_acima)));
      const gratis = gratisAcima != null && subtotal >= gratisAcima;
      const prazo = cfg.frete_prazo_dias == null || cfg.frete_prazo_dias === '' ? null : Math.max(0, Math.trunc(Number(cfg.frete_prazo_dias)));
      return {
        disponivel: true,
        provedor: 'manual',
        valor: gratis ? 0 : valor,
        gratis,
        prazoDias: prazo,
        ...(gratis && gratisAcima != null ? { observacao: `Frete grátis acima de R$ ${gratisAcima.toFixed(2)}.` } : {}),
      };
    },
  };
}

/** Resolve o provedor de frete a partir da configuração da empresa. */
export function resolverFreteProvider(cfg: ConfigFrete | null | undefined): FreightProvider {
  const provedor = String(cfg?.frete_provedor || 'nenhum');
  if (provedor === 'retirada') return freteRetirada;
  if (provedor === 'manual') return freteManual(cfg ?? { frete_provedor: 'manual' });
  return freteNaoConfigurado;
}

/** Cotação rápida (usa a configuração da loja da empresa). */
export function cotarFrete(cfg: ConfigFrete | null | undefined, input: { subtotal: number; cep?: string | null }): Promise<CotacaoFrete> {
  return resolverFreteProvider(cfg).cotar(input);
}

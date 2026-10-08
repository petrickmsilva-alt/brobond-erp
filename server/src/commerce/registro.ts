// ============================================================================
// REGISTRO DE CANAIS (Fase P3, §2)
//
// Um mapa exaustivo — `Record<CanalComercio, CommerceProvider>` — garante em
// TEMPO DE COMPILAÇÃO que todo canal da especificação tem adaptador. Não
// existe `if (canal === 'mercadolivre')` no resto do sistema: quem precisa de
// um canal pede `providerDe(canal)`.
// ============================================================================
import { CANAIS_COMERCIO, type CanalComercio, type CommerceProvider } from './contrato';
import { criarWooCommerceAdapter } from './adapters/woocommerce';
import { criarMercadoLivreAdapter } from './adapters/mercadolivre';
import { criarNuvemshopAdapter } from './adapters/nuvemshop';

let cache: Record<CanalComercio, CommerceProvider> | null = null;

/** Constrói (uma vez) os adaptadores. Os testes injetam `fetch`/config próprios. */
export function provedoresComercio(deps: Partial<Record<CanalComercio, CommerceProvider>> = {}): Record<CanalComercio, CommerceProvider> {
  if (!cache) {
    cache = {
      MERCADOLIVRE: criarMercadoLivreAdapter(),
      NUVEMSHOP: criarNuvemshopAdapter(),
      WOOCOMMERCE: criarWooCommerceAdapter(),
    } satisfies Record<CanalComercio, CommerceProvider>;
  }
  return { ...cache, ...deps };
}

export function providerDe(canal: CanalComercio, deps: Partial<Record<CanalComercio, CommerceProvider>> = {}): CommerceProvider {
  return provedoresComercio(deps)[canal];
}

/** Ficha de cada canal para a tela de integrações (sem nenhum segredo). */
export function catalogoDeCanais(deps: Partial<Record<CanalComercio, CommerceProvider>> = {}, ctx: any = {}) {
  return CANAIS_COMERCIO.map((canal) => {
    const provider = providerDe(canal, deps);
    const config = provider.configurado(ctx);
    return {
      canal,
      rotulo: provider.rotulo,
      capacidades: provider.capacidades,
      requerCredencial: provider.requerCredencial,
      configurado: config.ok,
      motivo: config.motivo || null,
    };
  });
}

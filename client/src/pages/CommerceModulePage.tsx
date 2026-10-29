import type { Module } from '../modules';
import CommerceProdutosPage from './commerce/ProdutosPage';
import CommerceProdutoNovoPage from './commerce/ProdutoNovoPage';
import CommerceProdutoDetalhePage from './commerce/ProdutoDetalhePage';
import CommercePublicacoesPage from './commerce/PublicacoesPage';
import CommercePedidosPage from './commerce/PedidosPage';
import CommercePedidoDetalhePage from './commerce/PedidoDetalhePage';
import CommerceTrendsPage from './commerce/TrendsPage';
import CommerceDeliveryPage from './commerce/DeliveryPage';
import CommerceFilaPage from './commerce/FilaPage';
import CommerceLojaConfigPage from './commerce/LojaConfigPage';
import CommercePromocoesPage from './commerce/PromocoesPage';
import CommercePromocaoFormPage from './commerce/PromocaoFormPage';
import CommerceCuponsPage from './commerce/CuponsPage';
import CommerceCupomFormPage from './commerce/CupomFormPage';

/** Dispatcher das páginas operacionais de Commerce. */
const COMMERCE_PAGES: Record<string, () => JSX.Element> = {
  'commerce-produtos': CommerceProdutosPage,
  'commerce-produtos-novo': CommerceProdutoNovoPage,
  'commerce-produtos-detalhe': CommerceProdutoDetalhePage,
  'commerce-publicacoes': CommercePublicacoesPage,
  'commerce-pedidos': CommercePedidosPage,
  'commerce-pedido-detalhe': CommercePedidoDetalhePage,
  'commerce-trends': CommerceTrendsPage,
  'commerce-delivery': CommerceDeliveryPage,
  'commerce-fila': CommerceFilaPage,
  'commerce-loja': CommerceLojaConfigPage,
  'commerce-promocoes': CommercePromocoesPage,
  'commerce-promocao-nova': CommercePromocaoFormPage,
  'commerce-promocao-editar': CommercePromocaoFormPage,
  'commerce-cupons': CommerceCuponsPage,
  'commerce-cupom-novo': CommerceCupomFormPage,
  'commerce-cupom-editar': CommerceCupomFormPage,
};

export default function CommerceModulePage({ module }: { module: Module }) {
  if (module.space === 'commerce') {
    const Pagina = COMMERCE_PAGES[module.id];
    if (Pagina) return <Pagina />;
    // Módulo commerce sem página = erro honesto (nunca placeholder com métricas vazias).
    return (
      <div className="rounded-xl border border-line bg-surface p-6 text-sm text-muted">
        Página do módulo “{module.label}” não registrada no dispatcher — corrija o deploy ou contate o suporte.
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-line bg-surface p-6 text-sm text-muted">
      Página não registrada neste espaço.
    </div>
  );
}

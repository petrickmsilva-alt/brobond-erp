import { Fragment, lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from './auth/AuthContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import { MODULES, usaCrudGenerico, visibleModules } from './modules';

// Code-splitting: só a tela de login e o dashboard (a primeira coisa que qualquer
// pessoa vê) entram no bundle inicial. O resto — inclusive as páginas públicas
// (catálogo, portal, convite), o CRUD genérico e as telas administrativas mais
// pesadas (Usuários, Financeiro, dentro de ModulePage) — é baixado sob demanda,
// quando a rota é realmente acessada.
const ModulePage = lazy(() => import('./pages/ModulePage'));
const FiscalObrigacaoDetalhePage = lazy(() => import('./pages/FiscalObrigacaoDetalhePage'));
const FiscalExecucoesPage = lazy(() => import('./pages/FiscalExecucoesPage'));
const Settings = lazy(() => import('./pages/Settings'));
const ImpressaoPage = lazy(() => import('./pages/ImpressaoPage'));
const ProductDetail = lazy(() => import('./pages/ProductDetail'));
const ClienteFormPage = lazy(() => import('./pages/ClienteFormPage'));
const ProdutoFormPage = lazy(() => import('./pages/ProdutoFormPage'));
const CategoriaFormPage = lazy(() => import('./pages/CategoriaFormPage'));
const CorFormPage = lazy(() => import('./pages/CorFormPage'));
const ColecaoFormPage = lazy(() => import('./pages/ColecaoFormPage'));
const TamanhoFormPage = lazy(() => import('./pages/TamanhoFormPage'));
const GradeFormPage = lazy(() => import('./pages/GradeFormPage'));
const InsumoFormPage = lazy(() => import('./pages/InsumoFormPage'));
const CategoriaInsumoFormPage = lazy(() => import('./pages/CategoriaInsumoFormPage'));
const FornecedorFormPage = lazy(() => import('./pages/FornecedorFormPage'));
const RepresentanteFormPage = lazy(() => import('./pages/RepresentanteFormPage'));
const RepresentanteDetailPage = lazy(() => import('./pages/RepresentanteDetailPage'));
// Fundação comercial (MASTER): formulário em PÁGINA PRÓPRIA (nunca modal).
const CadastroComercialFormPage = lazy(() => import('./pages/CadastroComercialFormPage'));
const MetaAcompanhamentoPage = lazy(() => import('./pages/MetaAcompanhamentoPage'));
const OrderPage = lazy(() => import('./pages/OrderPage'));
const OrdemDetail = lazy(() => import('./pages/OrdemDetail'));
const CotacoesCompraPage = lazy(() => import('./pages/CotacoesCompraPage'));
const CotacoesCompraFormPage = lazy(() => import('./pages/CotacoesCompraFormPage'));
const FichaDetail = lazy(() => import('./pages/FichaDetail'));
const ForgotPage = lazy(() => import('./pages/ForgotReset').then((m) => ({ default: m.ForgotPage })));
const ResetPage = lazy(() => import('./pages/ForgotReset').then((m) => ({ default: m.ResetPage })));
const Convite = lazy(() => import('./pages/Convite'));
const CatalogoPublico = lazy(() => import('./pages/CatalogoPublico'));
const PortalCliente = lazy(() => import('./pages/PortalCliente'));
// Catálogo de componentes de UI, só para referência visual — não entra no menu.
const ComponentCatalog = lazy(() => import('./pages/dev/ComponentCatalog'));
// Página genérica de NOVO/EDITAR — destino de TODO recurso do CRUD genérico.
const RegistroPage = lazy(() => import('./pages/RegistroPage'));
// BROBOND COMMERCE OS — detalhe/novo/edição em rotas próprias (ZERO MODAL) e
// vitrine B2C pública (/loja) fora do Layout do ERP.
const CommerceProdutoNovoPage = lazy(() => import('./pages/commerce/ProdutoNovoPage'));
const CommerceProdutoDetalhePage = lazy(() => import('./pages/commerce/ProdutoDetalhePage'));
const CommercePedidoDetalhePage = lazy(() => import('./pages/commerce/PedidoDetalhePage'));
const CommercePromocaoFormPage = lazy(() => import('./pages/commerce/PromocaoFormPage'));
const CommerceCupomFormPage = lazy(() => import('./pages/commerce/CupomFormPage'));
// Publicações: fila → nova/detalhe/editar em rota própria (CRIAR→EDITAR→SALVAR
// →PUBLICAR→DESPUBLICAR→REPROCESSAR sem modal).
const CommercePublicacaoNovaPage = lazy(() => import('./pages/commerce/PublicacaoNovaPage'));
const CommercePublicacaoDetalhePage = lazy(() => import('./pages/commerce/PublicacaoDetalhePage'));
const CommercePublicacaoEditarPage = lazy(() => import('./pages/commerce/PublicacaoEditarPage'));
// Ofertas por canal (preço/promo/vigência — precedência server-side).
const CommerceOfertasPage = lazy(() => import('./pages/commerce/OfertasPage'));
const CommerceOfertaDetalhePage = lazy(() => import('./pages/commerce/OfertaDetalhePage'));
const CommerceOfertaFormPage = lazy(() => import('./pages/commerce/OfertaFormPage'));
// Painéis operacionais consumindo APIs reais do commerce.
const PaymentEnginePage = lazy(() => import('./pages/commerce/PaymentEnginePage'));
const CommercePagamentosPage = lazy(() => import('./pages/commerce/PagamentosPage'));
const CommerceReservasPage = lazy(() => import('./pages/commerce/ReservasPage'));
const CommerceFulfillmentPage = lazy(() => import('./pages/commerce/FulfillmentPage'));
const CommerceEventosPage = lazy(() => import('./pages/commerce/EventosPage'));
const CommerceErrosPage = lazy(() => import('./pages/commerce/ErrosPage'));
const CommerceDevolucoesPage = lazy(() => import('./pages/commerce/DevolucoesPage'));
const LojaInicioPage = lazy(() => import('./pages/commerce/loja/LojaInicioPage'));
const LojaProdutoPage = lazy(() => import('./pages/commerce/loja/LojaProdutoPage'));
const LojaCarrinhoPage = lazy(() => import('./pages/commerce/loja/LojaCarrinhoPage'));
const LojaCheckoutPage = lazy(() => import('./pages/commerce/loja/LojaCheckoutPage'));
const LojaPedidoPage = lazy(() => import('./pages/commerce/loja/LojaPedidoPage'));
// Usuários: cadastro/edição em PÁGINA própria (nunca em modal/drawer).
const UsuarioRegistroPage = lazy(() =>
  import('./pages/UsuariosPage').then((m) => ({ default: m.UsuarioRegistroPage }))
);
// ERP 3.0 — homologação final: os 11 fluxos de módulo que viviam em painel
// inline agora são PÁGINAS próprias (LISTA → NOVO/EDITAR).
const NcmFormPage = lazy(() => import('./pages/NcmFormPage'));
const WebhookFormPage = lazy(() => import('./pages/WebhookFormPage'));
const EmpresaFormPage = lazy(() => import('./pages/EmpresaFormPage'));
const NovaFichaPage = lazy(() => import('./pages/NovaFichaPage'));
const DevolucaoNovaPage = lazy(() => import('./pages/DevolucaoNovaPage'));
const ImportarPage = lazy(() => import('./pages/ImportarPage'));
const RecebimentoCompraPage = lazy(() => import('./pages/RecebimentoCompraPage'));
const ImpressaoTerminalFormPage = lazy(() => import('./pages/ImpressaoTerminalFormPage'));
const ImpressaoAgenteNovaPage = lazy(() => import('./pages/ImpressaoAgenteNovaPage'));
const ImpressaoAgenteEdicaoPage = lazy(() => import('./pages/ImpressaoAgenteEdicaoPage'));

function Loading() {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-400">
      <Loader2 className="h-4 w-4 animate-spin" /> Carregando...
    </div>
  );
}

function Protected({ children }: { children: JSX.Element }) {
  const { user, loading, meta } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  if (!meta) return <Loading />;
  // Fase 6 — senha padrão/legada: o sistema só libera o resto após a troca.
  if (user.trocar_senha && loc.pathname !== '/config') {
    return <Navigate to="/config?trocar=1" replace />;
  }
  return children;
}

function AdminOnly({ children }: { children: JSX.Element }) {
  const { user } = useAuth();
  if (user?.perfil !== 'admin') return <Navigate to="/" replace />;
  return children;
}

/**
 * UX-02.1 — URL direta usa a mesma fonte de descoberta do menu.
 *
 * Isto não substitui a autorização do servidor: apenas evita que um item
 * escondido por `minPerfil`/permissão comercial abra a página e só falhe
 * depois nas chamadas. O servidor continua decidindo cada API/ação.
 */
function ModuleAccess({ moduleId, children }: { moduleId: string; children: JSX.Element }) {
  const { user } = useAuth();
  if (!visibleModules(user).some((m) => m.id === moduleId)) return <Navigate to="/" replace />;
  return children;
}

/** Cotações de compra — documento em rota própria (/cotacoes-compra/:id). */
function CotacoesCompraDetalhe() {
  const { id } = useParams();
  return <CotacoesCompraPage initialId={id ? Number(id) : null} />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/esqueci" element={<ForgotPage />} />
          <Route path="/redefinir/:token" element={<ResetPage />} />
          <Route path="/convite/:token" element={<Convite />} />
          <Route path="/catalogo/:token" element={<CatalogoPublico />} />
          <Route path="/portal/:token" element={<PortalCliente />} />
          {/* Vitrine B2C própria do BROBOND COMMERCE OS — pública, sem sessão ERP. */}
          <Route path="/loja" element={<LojaInicioPage />} />
          <Route path="/loja/produto/:slug" element={<LojaProdutoPage />} />
          <Route path="/loja/carrinho" element={<LojaCarrinhoPage />} />
          <Route path="/loja/checkout" element={<LojaCheckoutPage />} />
          <Route path="/loja/pedido/:token" element={<LojaPedidoPage />} />
          <Route
            path="/"
            element={
              <Protected>
                <Layout />
              </Protected>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="config" element={<Settings />} />
            <Route path="config/impressao" element={<ImpressaoPage />} />
            <Route path="produtos/:id" element={<ProductDetail />} />
            {/* Cadastro de clientes PF/PJ em página própria (fora do modal). */}
            <Route
              path="clientes/novo"
              element={
                <ModuleAccess moduleId="clientes">
                  <ClienteFormPage />
                </ModuleAccess>
              }
            />
            <Route
              path="clientes/:id/editar"
              element={
                <ModuleAccess moduleId="clientes">
                  <ClienteFormPage />
                </ModuleAccess>
              }
            />
            {/* Cadastro de produtos em página própria (fora do modal). */}
            <Route
              path="produtos/novo"
              element={
                <ModuleAccess moduleId="produtos">
                  <ProdutoFormPage />
                </ModuleAccess>
              }
            />
            <Route
              path="produtos/:id/editar"
              element={
                <ModuleAccess moduleId="produtos">
                  <ProdutoFormPage />
                </ModuleAccess>
              }
            />
            {/* Cadastro de categorias em página própria (fora do modal). */}
            <Route
              path="categorias/novo"
              element={
                <ModuleAccess moduleId="categorias">
                  <CategoriaFormPage />
                </ModuleAccess>
              }
            />
            <Route
              path="categorias/:id/editar"
              element={
                <ModuleAccess moduleId="categorias">
                  <CategoriaFormPage />
                </ModuleAccess>
              }
            />
            {/* Cadastro de cores em página própria (fora de qualquer modal/drawer). */}
            <Route
              path="cores/novo"
              element={
                <ModuleAccess moduleId="cores">
                  <CorFormPage />
                </ModuleAccess>
              }
            />
            <Route
              path="cores/:id/editar"
              element={
                <ModuleAccess moduleId="cores">
                  <CorFormPage />
                </ModuleAccess>
              }
            />
            {/* Cadastro de coleções em página própria (fora de qualquer modal/drawer). */}
            <Route
              path="colecoes/novo"
              element={
                <ModuleAccess moduleId="colecoes">
                  <ColecaoFormPage />
                </ModuleAccess>
              }
            />
            <Route
              path="colecoes/:id/editar"
              element={
                <ModuleAccess moduleId="colecoes">
                  <ColecaoFormPage />
                </ModuleAccess>
              }
            />
            {/* Cadastro de tamanhos em página própria (fora de qualquer modal/drawer). */}
            <Route
              path="tamanhos/novo"
              element={
                <ModuleAccess moduleId="tamanhos">
                  <TamanhoFormPage />
                </ModuleAccess>
              }
            />
            <Route
              path="tamanhos/:id/editar"
              element={
                <ModuleAccess moduleId="tamanhos">
                  <TamanhoFormPage />
                </ModuleAccess>
              }
            />
            {/* Cadastro de grades em página própria (fora de qualquer modal/drawer):
                a relação ordenada grade × tamanho precisa de espaço próprio. */}
            <Route
              path="grades/novo"
              element={
                <ModuleAccess moduleId="grades">
                  <GradeFormPage />
                </ModuleAccess>
              }
            />
            <Route
              path="grades/:id/editar"
              element={
                <ModuleAccess moduleId="grades">
                  <GradeFormPage />
                </ModuleAccess>
              }
            />
            {/* Cadastro de insumos em página própria (fora de qualquer modal/drawer):
                a matéria-prima é consultada na compra, na ficha técnica e no
                estoque — o formulário vive na rota, não sobreposto à lista. */}
            <Route
              path="insumos/novo"
              element={
                <ModuleAccess moduleId="insumos">
                  <InsumoFormPage />
                </ModuleAccess>
              }
            />
            <Route
              path="insumos/:id/editar"
              element={
                <ModuleAccess moduleId="insumos">
                  <InsumoFormPage />
                </ModuleAccess>
              }
            />
            {/* Categorias de insumos — cadastro auxiliar em página própria
                (LISTA → PÁGINA), como Categorias de produto e Coleções. */}
            <Route
              path="categorias-insumos/novo"
              element={
                <ModuleAccess moduleId="categorias-insumos">
                  <CategoriaInsumoFormPage />
                </ModuleAccess>
              }
            />
            <Route
              path="categorias-insumos/:id/editar"
              element={
                <ModuleAccess moduleId="categorias-insumos">
                  <CategoriaInsumoFormPage />
                </ModuleAccess>
              }
            />
            {/* Cadastro de fornecedores em página própria (fora de qualquer
                modal/drawer): PF/PJ, fiscal, endereço e comercial precisam de
                espaço próprio — o formulário vive na rota, não sobreposto à
                lista. */}
            <Route
              path="fornecedores/novo"
              element={
                <ModuleAccess moduleId="fornecedores">
                  <FornecedorFormPage />
                </ModuleAccess>
              }
            />
            <Route
              path="fornecedores/:id/editar"
              element={
                <ModuleAccess moduleId="fornecedores">
                  <FornecedorFormPage />
                </ModuleAccess>
              }
            />
            {/* Cadastro de representantes em página própria (fora de qualquer
                modal/drawer): identificação, comissão, acesso ao ERP, contato e
                situação profissional precisam de espaço próprio — o formulário
                vive na rota, não sobreposto à lista. */}
            <Route
              path="representantes/novo"
              element={
                <ModuleAccess moduleId="representantes">
                  <RepresentanteFormPage />
                </ModuleAccess>
              }
            />
            <Route
              path="representantes/:id/editar"
              element={
                <ModuleAccess moduleId="representantes">
                  <RepresentanteFormPage />
                </ModuleAccess>
              }
            />
            {/* FICHA + PAINEL do representante — PÁGINA própria (nunca drawer/
                modal). Apresenta cadastro, território, equipe, hierarquia,
                carteira, metas, comissão e indicadores derivados. */}
            <Route
              path="representantes/:id"
              element={
                <ModuleAccess moduleId="representantes">
                  <RepresentanteDetailPage />
                </ModuleAccess>
              }
            />

            {/* =============================================================
                FUNDAÇÃO COMERCIAL (MASTER MA-02..MA-08) — cadastro em
                PÁGINA PRÓPRIA. A listagem fica na rota do módulo; incluir e
                editar navegam. Nenhuma dessas telas abre formulário
                sobreposto à lista.
                ============================================================= */}
            {[
              { rota: 'territorios', modulo: 'territorios', recurso: 'territorios' },
              { rota: 'equipes-comerciais', modulo: 'equipes_comerciais', recurso: 'equipes_comerciais' },
              { rota: 'equipe-membros', modulo: 'equipe_membros', recurso: 'equipe_membros' },
              { rota: 'hierarquia-comercial', modulo: 'representante_hierarquia', recurso: 'representante_hierarquia' },
              { rota: 'carteira-clientes', modulo: 'representante_cliente', recurso: 'representante_cliente' },
              { rota: 'atribuicao-comercial', modulo: 'venda_atribuicao', recurso: 'venda_atribuicao' },
              { rota: 'metas', modulo: 'metas', recurso: 'metas' },
              { rota: 'planos-comissao', modulo: 'planos_comissao', recurso: 'planos_comissao' },
              { rota: 'regras-comissao', modulo: 'regras_comissao', recurso: 'regras_comissao' },
            ].flatMap(({ rota, modulo, recurso }) => [
              <Route
                key={`${recurso}-novo`}
                path={`${rota}/novo`}
                element={
                  <ModuleAccess moduleId={modulo}>
                    <CadastroComercialFormPage recurso={recurso} />
                  </ModuleAccess>
                }
              />,
              <Route
                key={`${recurso}-editar`}
                path={`${rota}/:id/editar`}
                element={
                  <ModuleAccess moduleId={modulo}>
                    <CadastroComercialFormPage recurso={recurso} />
                  </ModuleAccess>
                }
              />,
            ])}
            {/* Acompanhamento da meta: realizado DERIVADO das vendas (MA-04). */}
            <Route
              path="metas/:id/acompanhamento"
              element={
                <ModuleAccess moduleId="metas">
                  <MetaAcompanhamentoPage />
                </ModuleAccess>
              }
            />
            {/* Pedidos de venda PF/PJ em página própria (motor único de venda, fora do modal). */}
            <Route
              path="vendas/novo"
              element={
                <ModuleAccess moduleId="vendas">
                  <OrderPage tipo="venda" modo="novo" />
                </ModuleAccess>
              }
            />
            <Route
              path="vendas/:id/editar"
              element={
                <ModuleAccess moduleId="vendas">
                  <OrderPage tipo="venda" modo="editar" />
                </ModuleAccess>
              }
            />
            <Route
              path="vendas/:id"
              element={
                <ModuleAccess moduleId="vendas">
                  <OrderPage tipo="venda" />
                </ModuleAccess>
              }
            />
            {/* =============================================================
                HOMOLOGAÇÃO FINAL — fluxos de módulo que eram painel inline
                agora são PÁGINAS. Cada rota abaixo tem teste de rota e é
                exigida pelo gate `npm run audit:ux` (não podem voltar).
                ============================================================= */}
            <Route
              path="ncm/novo"
              element={
                <ModuleAccess moduleId="ncm">
                  <NcmFormPage modo="novo" />
                </ModuleAccess>
              }
            />
            <Route
              path="ncm/:id/editar"
              element={
                <ModuleAccess moduleId="ncm">
                  <NcmFormPage modo="editar" />
                </ModuleAccess>
              }
            />
            <Route path="empresas/novo" element={<AdminOnly><EmpresaFormPage modo="novo" /></AdminOnly>} />
            <Route path="empresas/:id/editar" element={<AdminOnly><EmpresaFormPage modo="editar" /></AdminOnly>} />
            <Route
              path="custo/nova"
              element={
                <ModuleAccess moduleId="custo">
                  <NovaFichaPage />
                </ModuleAccess>
              }
            />
            <Route
              path="devolucoes/nova"
              element={
                <ModuleAccess moduleId="devolucoes">
                  <DevolucaoNovaPage />
                </ModuleAccess>
              }
            />
            <Route path="importar/:tipo" element={<ImportarPage />} />
            <Route
              path="compras/:id/receber"
              element={
                <ModuleAccess moduleId="compras">
                  <RecebimentoCompraPage />
                </ModuleAccess>
              }
            />
            <Route path="webhooks/novo" element={<AdminOnly><WebhookFormPage modo="novo" /></AdminOnly>} />
            <Route path="webhooks/:id/editar" element={<AdminOnly><WebhookFormPage modo="editar" /></AdminOnly>} />
            <Route
              path="config/impressao/terminais/novo"
              element={<ImpressaoTerminalFormPage modo="novo" />}
            />
            <Route
              path="config/impressao/terminais/:id/editar"
              element={<ImpressaoTerminalFormPage modo="editar" />}
            />
            <Route path="config/impressao/agentes/novo" element={<ImpressaoAgenteNovaPage />} />
            <Route path="config/impressao/agentes/:machineId/editar" element={<ImpressaoAgenteEdicaoPage />} />
            {/* Usuários: LISTA → PÁGINA (formulário em rota própria). */}
            <Route
              path="usuarios/novo"
              element={
                <AdminOnly>
                  <UsuarioRegistroPage modo="novo" />
                </AdminOnly>
              }
            />
            <Route
              path="usuarios/:id/editar"
              element={
                <AdminOnly>
                  <UsuarioRegistroPage modo="editar" />
                </AdminOnly>
              }
            />
            <Route path="fiscal/obrigacoes/:id/execucoes" element={<ModuleAccess moduleId="fiscal-obrigacoes"><FiscalExecucoesPage /></ModuleAccess>} />
            <Route path="fiscal/obrigacoes/:id" element={<ModuleAccess moduleId="fiscal-obrigacoes"><FiscalObrigacaoDetalhePage /></ModuleAccess>} />
            {/* BROBOND COMMERCE OS — detalhe/novo/edição em rotas próprias (ZERO MODAL).
                As rotas de lista (/commerce/...) vêm do loop de MODULES abaixo. */}
            <Route path="commerce/produtos/novo" element={<ModuleAccess moduleId="commerce-produtos"><CommerceProdutoNovoPage /></ModuleAccess>} />
            <Route path="commerce/produtos/:id" element={<ModuleAccess moduleId="commerce-produtos"><CommerceProdutoDetalhePage /></ModuleAccess>} />
            <Route path="commerce/pedidos/:saleId" element={<ModuleAccess moduleId="commerce-pedidos"><CommercePedidoDetalhePage /></ModuleAccess>} />
            <Route path="commerce/promocoes/nova" element={<ModuleAccess moduleId="commerce-promocoes"><CommercePromocaoFormPage /></ModuleAccess>} />
            <Route path="commerce/promocoes/:id/editar" element={<ModuleAccess moduleId="commerce-promocoes"><CommercePromocaoFormPage /></ModuleAccess>} />
            <Route path="commerce/cupons/novo" element={<ModuleAccess moduleId="commerce-cupons"><CommerceCupomFormPage /></ModuleAccess>} />
            <Route path="commerce/cupons/:id/editar" element={<ModuleAccess moduleId="commerce-cupons"><CommerceCupomFormPage /></ModuleAccess>} />
            {/* Publicações — fluxo completo em rotas próprias (ZERO MODAL). */}
            <Route path="commerce/publicacoes/novo" element={<ModuleAccess moduleId="commerce-publicacoes"><CommercePublicacaoNovaPage /></ModuleAccess>} />
            <Route path="commerce/publicacoes/:id/editar" element={<ModuleAccess moduleId="commerce-publicacoes"><CommercePublicacaoEditarPage /></ModuleAccess>} />
            <Route path="commerce/publicacoes/:id" element={<ModuleAccess moduleId="commerce-publicacoes"><CommercePublicacaoDetalhePage /></ModuleAccess>} />
            {/* Ofertas por canal — preço/promo/vigência com precedência server-side. */}
            <Route path="commerce/ofertas" element={<ModuleAccess moduleId="commerce-promocoes"><CommerceOfertasPage /></ModuleAccess>} />
            <Route path="commerce/ofertas/novo" element={<ModuleAccess moduleId="commerce-promocoes"><CommerceOfertaFormPage /></ModuleAccess>} />
            <Route path="commerce/ofertas/:id/editar" element={<ModuleAccess moduleId="commerce-promocoes"><CommerceOfertaFormPage /></ModuleAccess>} />
            <Route path="commerce/ofertas/:id" element={<ModuleAccess moduleId="commerce-promocoes"><CommerceOfertaDetalhePage /></ModuleAccess>} />
            {/* Painéis operacionais — APIs reais, dados reais, ZERO MODAL. */}
            <Route path="commerce/pagamentos/:section" element={<ModuleAccess moduleId="commerce-pedidos"><PaymentEnginePage /></ModuleAccess>} />
            <Route path="commerce/pagamentos/provedores/:code/editar" element={<ModuleAccess moduleId="commerce-pedidos"><PaymentEnginePage /></ModuleAccess>} />
            <Route path="commerce/pagamentos/metodos/:code/editar" element={<ModuleAccess moduleId="commerce-pedidos"><PaymentEnginePage /></ModuleAccess>} />
            <Route path="commerce/pagamentos/regras/:id/editar" element={<ModuleAccess moduleId="commerce-pedidos"><PaymentEnginePage /></ModuleAccess>} />
            <Route path="commerce/pagamentos/regras/novo" element={<ModuleAccess moduleId="commerce-pedidos"><PaymentEnginePage /></ModuleAccess>} />
            <Route path="commerce/pagamentos/transacoes/:id" element={<ModuleAccess moduleId="commerce-pedidos"><PaymentEnginePage /></ModuleAccess>} />
            <Route path="commerce/pagamentos/transacoes/:id/:action" element={<ModuleAccess moduleId="commerce-pedidos"><PaymentEnginePage /></ModuleAccess>} />
            <Route path="commerce/pagamentos/reconciliacao/:id/resolver" element={<ModuleAccess moduleId="commerce-pedidos"><PaymentEnginePage /></ModuleAccess>} />
            <Route path="commerce/pagamentos" element={<ModuleAccess moduleId="commerce-pedidos"><CommercePagamentosPage /></ModuleAccess>} />
            <Route path="commerce/reservas" element={<ModuleAccess moduleId="commerce-pedidos"><CommerceReservasPage /></ModuleAccess>} />
            <Route path="commerce/fulfillment" element={<ModuleAccess moduleId="commerce-pedidos"><CommerceFulfillmentPage /></ModuleAccess>} />
            <Route path="commerce/devolucoes" element={<ModuleAccess moduleId="commerce-pedidos"><CommerceDevolucoesPage /></ModuleAccess>} />
            <Route path="commerce/eventos" element={<ModuleAccess moduleId="commerce-fila"><CommerceEventosPage /></ModuleAccess>} />
            <Route path="commerce/erros" element={<ModuleAccess moduleId="commerce-fila"><CommerceErrosPage /></ModuleAccess>} />
            <Route path="compras/:id" element={<OrderPage tipo="compra" />} />
            <Route path="ordens/:id" element={<OrdemDetail />} />
            {/* Cotações de compra — ZERO MODAL: criação em /cotacoes-compra/novo
                e o documento em /cotacoes-compra/:id. Nenhum formulário sobreposto. */}
            <Route
              path="cotacoes-compra/novo"
              element={
                <ModuleAccess moduleId="cotacoes-compra">
                  <CotacoesCompraFormPage />
                </ModuleAccess>
              }
            />
            <Route
              path="cotacoes-compra/:id"
              element={
                <ModuleAccess moduleId="cotacoes-compra">
                  <CotacoesCompraDetalhe />
                </ModuleAccess>
              }
            />
            <Route path="fichas/:id" element={<FichaDetail />} />
            <Route path="dev/componentes" element={<AdminOnly><ComponentCatalog /></AdminOnly>} />
            {/* ZERO MODAL — LISTA → PÁGINA em todo o ERP.
                Todo módulo que usa o CRUD genérico ganha rota própria de cadastro
                (`/recurso/novo`) e de edição (`/recurso/:id/editar`). A listagem
                nunca abre formulário sobreposto: ela navega. */}
            {MODULES.filter(usaCrudGenerico).map((m) => {
              const base = m.path.replace(/^\//, '');
              return (
                <Fragment key={`crud-${m.id}`}>
                  <Route
                    path={`${base}/novo`}
                    element={
                      <ModuleAccess moduleId={m.id}>
                        <RegistroPage module={m} modo="novo" />
                      </ModuleAccess>
                    }
                  />
                  <Route
                    path={`${base}/:id/editar`}
                    element={
                      <ModuleAccess moduleId={m.id}>
                        <RegistroPage module={m} modo="editar" />
                      </ModuleAccess>
                    }
                  />
                </Fragment>
              );
            })}
            {MODULES.filter((m) => m.path !== '/' && m.id !== 'config').map((m) => {
              const el = <ModulePage module={m} />;
              return (
                <Route
                  key={m.id}
                  path={m.path.replace('/', '')}
                  element={
                    m.adminOnly ? (
                      <AdminOnly>{el}</AdminOnly>
                    ) : (
                      <ModuleAccess moduleId={m.id}>{el}</ModuleAccess>
                    )
                  }
                />
              );
            })}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

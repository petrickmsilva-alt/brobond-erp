import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from './auth/AuthContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import { MODULES, visibleModules } from './modules';

// Code-splitting: só a tela de login e o dashboard (a primeira coisa que qualquer
// pessoa vê) entram no bundle inicial. O resto — inclusive as páginas públicas
// (catálogo, portal, convite), o CRUD genérico e as telas administrativas mais
// pesadas (Usuários, Financeiro, dentro de ModulePage) — é baixado sob demanda,
// quando a rota é realmente acessada.
const ModulePage = lazy(() => import('./pages/ModulePage'));
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
const FornecedorFormPage = lazy(() => import('./pages/FornecedorFormPage'));
const RepresentanteFormPage = lazy(() => import('./pages/RepresentanteFormPage'));
const OrderPage = lazy(() => import('./pages/OrderPage'));
const OrdemDetail = lazy(() => import('./pages/OrdemDetail'));
const FichaDetail = lazy(() => import('./pages/FichaDetail'));
const ForgotPage = lazy(() => import('./pages/ForgotReset').then((m) => ({ default: m.ForgotPage })));
const ResetPage = lazy(() => import('./pages/ForgotReset').then((m) => ({ default: m.ResetPage })));
const Convite = lazy(() => import('./pages/Convite'));
const CatalogoPublico = lazy(() => import('./pages/CatalogoPublico'));
const PortalCliente = lazy(() => import('./pages/PortalCliente'));
// Catálogo de componentes de UI, só para referência visual — não entra no menu.
const ComponentCatalog = lazy(() => import('./pages/dev/ComponentCatalog'));

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
            <Route path="compras/:id" element={<OrderPage tipo="compra" />} />
            <Route path="ordens/:id" element={<OrdemDetail />} />
            <Route path="fichas/:id" element={<FichaDetail />} />
            <Route path="dev/componentes" element={<AdminOnly><ComponentCatalog /></AdminOnly>} />
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

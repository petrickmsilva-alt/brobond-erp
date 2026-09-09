import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from './auth/AuthContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import { MODULES } from './modules';

// Code-splitting: só a tela de login e o dashboard (a primeira coisa que qualquer
// pessoa vê) entram no bundle inicial. O resto — inclusive as páginas públicas
// (catálogo, portal, convite), o CRUD genérico e as telas administrativas mais
// pesadas (Usuários, Financeiro, dentro de ModulePage) — é baixado sob demanda,
// quando a rota é realmente acessada.
const ModulePage = lazy(() => import('./pages/ModulePage'));
const Settings = lazy(() => import('./pages/Settings'));
const ProductDetail = lazy(() => import('./pages/ProductDetail'));
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
            <Route path="produtos/:id" element={<ProductDetail />} />
            <Route path="vendas/:id" element={<OrderPage tipo="venda" />} />
            <Route path="compras/:id" element={<OrderPage tipo="compra" />} />
            <Route path="ordens/:id" element={<OrdemDetail />} />
            <Route path="fichas/:id" element={<FichaDetail />} />
            <Route path="dev/componentes" element={<AdminOnly><ComponentCatalog /></AdminOnly>} />
            {MODULES.filter((m) => m.path !== '/' && m.id !== 'config').map((m) => {
              const el = <ModulePage module={m} />;
              return <Route key={m.id} path={m.path.replace('/', '')} element={m.adminOnly ? <AdminOnly>{el}</AdminOnly> : el} />;
            })}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

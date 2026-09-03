import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from './auth/AuthContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import ModulePage from './pages/ModulePage';
import Settings from './pages/Settings';
import { MODULES } from './modules';

function Loading() {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-400">
      <Loader2 className="h-4 w-4 animate-spin" /> Carregando...
    </div>
  );
}

function Protected({ children }: { children: JSX.Element }) {
  const { user, loading, meta } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  if (!meta) return <Loading />;
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
      <Routes>
        <Route path="/login" element={<Login />} />
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
          {MODULES.filter((m) => m.path !== '/' && m.id !== 'config').map((m) => {
            const el = <ModulePage module={m} />;
            return <Route key={m.id} path={m.path.replace('/', '')} element={m.adminOnly ? <AdminOnly>{el}</AdminOnly> : el} />;
          })}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

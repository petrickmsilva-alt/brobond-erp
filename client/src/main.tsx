import React from 'react';
import ReactDOM from 'react-dom/client';
import './lib/sentry'; // Sentry deve ser inicializado ANTES do render
import App from './App';
import { AuthProvider } from './auth/AuthContext';
import { ToastProvider } from './components/ui';
import ErrorBoundary from './components/ErrorBoundary';
import { applyStoredTheme } from './lib/theme';
import './index.css';

// Aplica claro/escuro antes do primeiro paint, para não "piscar" o tema errado.
applyStoredTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ToastProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ToastProvider>
    </ErrorBoundary>
  </React.StrictMode>
);

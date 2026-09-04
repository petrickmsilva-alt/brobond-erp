import React from 'react';
import ReactDOM from 'react-dom/client';
import './lib/sentry'; // Sentry deve ser inicializado ANTES do render
import App from './App';
import { AuthProvider } from './auth/AuthContext';
import { ToastProvider } from './components/ui';
import ErrorBoundary from './components/ErrorBoundary';
import './index.css';

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

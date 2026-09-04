import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Em dev o Vite faz proxy de /api para a API (porta 3001).
// Em produção o front e a API ficam no mesmo serviço (Render), então /api é relativo.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Permite acesso pelo host de preview (ex.: *.e2b.app). Ajuste se o seu proxy exigir.
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  // Expõe variáveis VITE_ para o frontend (ex.: VITE_SENTRY_DSN)
  define: {
    'import.meta.env.VITE_VERSION': JSON.stringify(process.env.npm_package_version || '0.5.0'),
  },
});

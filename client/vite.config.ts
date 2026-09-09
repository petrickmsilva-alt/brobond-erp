import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Em dev o Vite faz proxy de /api para a API (porta 3001).
// Em produção o front e a API ficam no mesmo serviço (Render), então /api é relativo.
export default defineConfig({
  plugins: [
    react(),
    // PWA: instala o app (ícone na tela inicial/desktop) e cacheia o bundle
    // estático (JS/CSS/imagens) para abrir mais rápido em conexões ruins de
    // loja/fábrica. As chamadas a /api NUNCA são cacheadas — o ERP sempre
    // precisa do dado mais recente de estoque/financeiro, nunca uma versão
    // antiga servida offline por engano.
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: false, // usamos o public/manifest.json já existente, com os textos e ícones da marca
      workbox: {
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: 'NetworkOnly',
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
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
    'import.meta.env.VITE_VERSION': JSON.stringify(process.env.npm_package_version || '0.6.0'),
  },
});

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Config separada do vite.config.ts de produção: os testes não precisam do
// plugin de PWA nem do proxy de /api (o que é chamada de API é mockado).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    // Define uma origem válida para o JSDOM: sem URL, localStorage é
    // indisponível (opaque origin) e derruba suites que testam persistência.
    environmentOptions: {
      jsdom: {
        url: 'http://localhost/',
      },
    },
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    exclude: ['node_modules/**', 'dist/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    isolate: true,
  },
});

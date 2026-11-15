// Gera o Service Worker de PRODUÇÃO fora do build completo, para os testes.
//
// Carrega o `vite.config.ts` REAL (mesmas opções do vite-plugin-pwa usadas no
// deploy) e pede ao próprio plugin que gere `sw.js` + runtime do Workbox num
// diretório temporário. Roda em processo filho porque o Vite/esbuild não
// funciona dentro do ambiente jsdom do vitest.
//
// Uso: node src/test/gerarServiceWorker.mjs <diretório de saída>   (cwd = client/)
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveConfig } from 'vite';

const saida = process.argv[2];
if (!saida) {
  console.error('Informe o diretório de saída.');
  process.exit(2);
}
// O precache precisa do index.html: é ele que o fallback de navegação entrega.
writeFileSync(path.join(saida, 'index.html'), '<!doctype html><title>BROBOND ERP</title>');

const config = await resolveConfig(
  { root: process.cwd(), configFile: path.resolve('vite.config.ts'), build: { outDir: saida }, logLevel: 'silent' },
  'build',
  'production'
);
const pwa = config.plugins.find((p) => p.name === 'vite-plugin-pwa');
if (!pwa?.api?.generateSW) {
  console.error('vite-plugin-pwa não encontrado no vite.config.ts.');
  process.exit(3);
}
await pwa.api.generateSW();

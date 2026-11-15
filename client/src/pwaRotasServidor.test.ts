// ============================================================================
// PWA › O SERVICE WORKER NÃO PODE RESPONDER PELAS ROTAS DO SERVIDOR
//
// Regressão do hotfix pós-deploy do PR #142: em produção,
//   /.well-known/oauth-authorization-server
//   /.well-known/oauth-protected-resource
// abriam o dashboard no navegador. O Express respondia JSON corretamente; quem
// entregava o `index.html` era o Service Worker do PWA (fallback de navegação
// do Workbox), sem a requisição chegar ao servidor.
//
// Este teste NÃO confere uma lista escrita à mão: ele gera o Service Worker de
// PRODUÇÃO a partir do `vite.config.ts` real (mesmo plugin, mesmas opções,
// mesmo runtime minificado do Workbox que vai para a Render), EXECUTA esse
// arquivo e dispara eventos `fetch` de navegação. Interceptar = chamar
// `event.respondWith`, exatamente o que faz o navegador receber o SPA.
// ============================================================================
import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { ROTAS_DO_SERVIDOR, ehRotaDoServidor } from './pwaRotasServidor';

const CLIENTE = path.resolve(__dirname, '..');
const ORIGEM = 'https://erp.brobond.test';

type Ouvinte = (evento: unknown) => void;
const ouvintes: Record<string, Ouvinte[]> = {};
let swGerado = '';

/** Carrega `sw.js` (e o runtime que ele importa) num escopo de Service Worker mínimo. */
function executarServiceWorker(dir: string): void {
  const cacheVazio = { match: async () => undefined, put: async () => undefined, keys: async () => [], delete: async () => true };
  const escopo: Record<string, unknown> = {
    console,
    URL,
    Headers,
    Response,
    Promise,
    setTimeout,
    clearTimeout,
    // `createHandlerBoundToURL('index.html')` cria uma Request relativa ao escopo.
    Request: class {
      url: string;
      method = 'GET';
      mode = 'cors';
      headers = new Headers();
      constructor(alvo: unknown) {
        this.url = new URL(String(alvo), `${ORIGEM}/`).href;
      }
      clone() {
        return this;
      }
    },
    location: new URL(`${ORIGEM}/sw.js`),
    registration: { scope: `${ORIGEM}/` },
    caches: { open: async () => cacheVazio, match: async () => undefined, keys: async () => [], delete: async () => true, has: async () => false },
    fetch: async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    clients: { claim: async () => undefined },
    skipWaiting: async () => undefined,
    addEventListener: (tipo: string, fn: Ouvinte) => {
      (ouvintes[tipo] ??= []).push(fn);
    },
  };
  escopo.self = escopo;
  const contexto = vm.createContext(escopo);
  escopo.importScripts = (...urls: string[]) => {
    for (const url of urls) {
      const arquivo = path.basename(new URL(url, ORIGEM).pathname);
      vm.runInContext(readFileSync(path.join(dir, arquivo), 'utf8'), contexto, { filename: arquivo });
    }
  };
  vm.runInContext(swGerado, contexto, { filename: 'sw.js' });
}

/** Simula o navegador abrindo `caminho` na barra de endereços. */
function serviceWorkerIntercepta(caminho: string): boolean {
  let interceptou = false;
  const evento = {
    request: { url: ORIGEM + caminho, method: 'GET', mode: 'navigate', headers: new Headers(), clone() { return this; } },
    respondWith(resposta: unknown) {
      interceptou = true;
      Promise.resolve(resposta).catch(() => undefined);
    },
    waitUntil(pendente: unknown) {
      Promise.resolve(pendente).catch(() => undefined);
    },
  };
  for (const fn of ouvintes.fetch ?? []) fn(evento);
  return interceptou;
}

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'brobond-sw-'));
  try {
    const r = spawnSync(process.execPath, ['src/test/gerarServiceWorker.mjs', dir], {
      cwd: CLIENTE,
      // Mesmo modo do build da Render: runtime de produção do Workbox.
      env: { ...process.env, NODE_ENV: 'production' },
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(r.status, `falha ao gerar o Service Worker:\n${r.stderr}`).toBe(0);
    swGerado = readFileSync(path.join(dir, 'sw.js'), 'utf8');
    executarServiceWorker(dir);
    // O loader do Workbox resolve os módulos de forma assíncrona.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 150_000);

describe('Service Worker de produção × rotas do servidor', () => {
  it('controle: o fallback de navegação existe e continua entregando o SPA nas rotas do ERP', () => {
    expect(swGerado).toContain('NavigationRoute');
    expect(swGerado).toContain('createHandlerBoundToURL("index.html")');
    expect((ouvintes.fetch ?? []).length).toBeGreaterThan(0);
    // Sem este controle, um Service Worker que não intercepta NADA passaria no resto.
    for (const rota of ['/', '/login', '/produtos', '/produtos/1/editar', '/config']) {
      expect(serviceWorkerIntercepta(rota), `${rota} deveria abrir o SPA`).toBe(true);
    }
  });

  it('Authorization Server Metadata vai para a rede (não recebe o index.html)', () => {
    expect(serviceWorkerIntercepta('/.well-known/oauth-authorization-server')).toBe(false);
  });

  it('Protected Resource Metadata vai para a rede (não recebe o index.html)', () => {
    expect(serviceWorkerIntercepta('/.well-known/oauth-protected-resource')).toBe(false);
    // RFC 9728: o cliente MCP também consulta a variante com o caminho do recurso.
    expect(serviceWorkerIntercepta('/.well-known/oauth-protected-resource/mcp')).toBe(false);
  });

  it('JWKS, Authorization Server, MCP e API também ficam fora do fallback', () => {
    for (const rota of [
      '/.well-known/jwks.json',
      '/oauth/authorize?response_type=code&client_id=x&code_challenge_method=S256',
      '/oauth/register',
      '/oauth/token',
      '/oauth/revoke',
      '/mcp',
      '/mcp?sessao=1',
      '/mcp/',
      '/api/health',
    ]) {
      expect(serviceWorkerIntercepta(rota), `${rota} é do servidor`).toBe(false);
    }
  });

  it('a exclusão é ancorada: caminhos parecidos continuam sendo do SPA', () => {
    for (const rota of ['/mcpx', '/oauthx', '/well-known/x', '/config/.well-known/x', '/apix']) {
      expect(serviceWorkerIntercepta(rota), `${rota} é do SPA`).toBe(true);
    }
  });

  it('a lista compartilhada é a que foi parar no Service Worker', () => {
    for (const re of ROTAS_DO_SERVIDOR) expect(swGerado).toContain(String(re));
    expect(ehRotaDoServidor('/.well-known/oauth-authorization-server')).toBe(true);
    expect(ehRotaDoServidor('/.well-known/oauth-protected-resource')).toBe(true);
    expect(ehRotaDoServidor('/produtos')).toBe(false);
  });
});

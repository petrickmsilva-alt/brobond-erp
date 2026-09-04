/// <reference lib="webworker" />
// Service Worker do BROBOND ERP — PWA com cache de assets e fallback offline.
// Estratégia: Stale While Revalidate para assets estáticos; Network First para API.

declare const self: ServiceWorkerGlobalScope;

const CACHE_NAME = 'brobond-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.png',
  '/logo.png',
  '/logo-mark.png',
];

// Install: pré-cache dos assets estáticos
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch(() => {
        // Alguns assets podem falhar (ex.: / requer auth); não bloqueia a instalação
      });
    })
  );
  self.skipWaiting();
});

// Activate: limpa caches antigos
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: estratégia por tipo de recurso
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // API: Network First (sempre tenta rede; se falhar, retorna cache se houver)
  if (url.pathname.startsWith('/api/')) {
    if (request.method !== 'GET') return; // Só cacheia GET
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Clona e cacheia respostas de sucesso
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME + '-api').then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          // Fallback: tenta cache
          return caches.match(request).then((cached) => {
            if (cached) return cached;
            // Retorna erro JSON para a API
            return new Response(JSON.stringify({ error: 'Sem conexão com o servidor.' }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' },
            });
          });
        })
    );
    return;
  }

  // Assets estáticos (JS, CSS, imagens): Stale While Revalidate
  if (url.pathname.match(/\.(js|css|png|jpg|jpeg|svg|woff2?|ico)$/)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        // Busca rede em background para atualizar o cache
        const fetchPromise = fetch(request)
          .then((response) => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            }
            return response;
          })
          .catch(() => cached);

        // Retorna cache imediatamente (se tiver), ou aguarda rede
        return cached || fetchPromise;
      })
    );
    return;
  }

  // HTML/SPA: Network First com fallback para index.html (offline)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          return caches.match('/index.html').then((index) => {
            return index || new Response('BROBOND ERP — Sem conexão. Verifique sua internet.', {
              status: 503,
              headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            });
          });
        })
    );
    return;
  }
});

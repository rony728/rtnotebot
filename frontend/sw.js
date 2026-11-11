/* ============================================================
   RTNote Service Worker - PWA Offline & Cache Manager
   ============================================================ */

const CACHE_NAME = 'rtnote-pwa-v1.2.3';

// Recursos estáticos locales para pre-cachear (rutas relativas a la raíz del frontend)
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/api.js?v=1.2.3',
  './js/auth.js?v=1.2.3',
  './js/app.js?v=1.2.3',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

/* --- Evento Install: pre-cachear archivos esenciales --- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Usamos addAll con catch para no bloquear instalación si algún icono tarda
      return cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn('[SW] Algunos recursos no pudieron pre-cachearse:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

/* --- Evento Activate: purgar cachés obsoletas y tomar control inmediato --- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[SW] Purgando caché antigua:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

/* --- Evento Fetch: Stale-While-Revalidate para estáticos; Network-Only para API --- */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. REGLA ESTRICTA: Peticiones que NO sean GET o llamadas a API (api-rtnotebot.rtdev.uk o /api/)
  // NUNCA se cachean; van directamente a la red (Network-Only).
  if (
    request.method !== 'GET' ||
    url.hostname.includes('api-rtnotebot.rtdev.uk') ||
    url.pathname.includes('/api/') ||
    url.hostname.includes('telegram.org')
  ) {
    return; // Dejar que el navegador gestione por red normal
  }

  // 2. Para navegación principal (HTML), usar Network-First con fallback a caché
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
          }
          return networkResponse;
        })
        .catch(() => {
          return caches.match('./index.html').then((cached) => cached || caches.match(request));
        })
    );
    return;
  }

  // 3. Para activos estáticos (CSS, JS, iconos): Stale-While-Revalidate
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      const fetchPromise = fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
          }
          return networkResponse;
        })
        .catch(() => {
          // Si no hay red, la respuesta en caché ya fue retornada
        });

      return cachedResponse || fetchPromise;
    })
  );
});

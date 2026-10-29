// Service worker: guarda o app no celular para abrir e funcionar sem sinal.
const VERSAO = 'inspecao-v1.3.0';
const ARQUIVOS = [
  './',
  'index.html',
  'css/app.css',
  'js/config.js',
  'js/app.js',
  'js/geo.js',
  'js/db.js',
  'js/stamp.js',
  'js/sync.js',
  'js/video.js',
  'js/orientacao.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-180.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(VERSAO).then((c) => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== VERSAO && !k.startsWith('fontes')).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Fontes do Google: guarda depois do primeiro uso
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    ev.respondWith(caches.open('fontes').then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const resp = await fetch(req);
        c.put(req, resp.clone());
        return resp;
      } catch (e) {
        return hit || Response.error();
      }
    }));
    return;
  }

  if (url.origin !== self.location.origin) return; // servidor (Apps Script) vai direto para a rede

  // config.js: rede primeiro (para receber o endereço do servidor), cache se sem sinal
  if (url.pathname.endsWith('/js/config.js')) {
    ev.respondWith(fetch(req).then((resp) => {
      caches.open(VERSAO).then((c) => c.put(req, resp.clone()));
      return resp;
    }).catch(() => caches.match(req)));
    return;
  }

  // demais arquivos do app: cache primeiro
  ev.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((resp) => {
    if (resp.ok) caches.open(VERSAO).then((c) => c.put(req, resp.clone()));
    return resp;
  }).catch(() => (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});

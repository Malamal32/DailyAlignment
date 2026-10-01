// DailyAlignment offline support. Bump VERSION when you deploy a new index.html.
const VERSION = 'da-v18';
const CORE = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/favicon-48.png', './logo.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.includes('open-meteo.com') || url.pathname.startsWith('/cdn-cgi/')) return; // place search needs the network
  if (req.mode === 'navigate') { // network first, so updates arrive; cache when offline
    e.respondWith(fetch(req).then(r => { if (r.ok && r.type === 'basic') { const cp = r.clone(); caches.open(VERSION).then(c => c.put('./index.html', cp)); } return r; }).catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok || r.type === 'opaque') { const cp = r.clone(); caches.open(VERSION).then(c => c.put(req, cp)); } return r; })));
});

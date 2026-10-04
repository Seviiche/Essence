/* À la pompe — service worker (v2.1, fichiers à plat)
   Coquille en cache pour l'usage hors ligne ; la bibliothèque de carte (CDN) est gardée en cache après le premier chargement.
   Les API de prix, d'enseignes et d'adresses ne passent jamais par ce cache. */
const VERSION = "a-la-pompe-v2.1.0";
const COQUILLE = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];
const BIBLIOTHEQUES = ["cdnjs.cloudflare.com", "cdn.jsdelivr.net"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(COQUILLE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== VERSION).map(x => caches.delete(x)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET") return;
  if (BIBLIOTHEQUES.includes(url.hostname) && url.pathname.includes("leaflet")) {
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(rep => {
      caches.open(VERSION).then(c => c.put(req, rep.clone())); return rep;
    })));
    return;
  }
  if (url.origin !== self.location.origin) return;
  e.respondWith(fetch(req).then(rep => {
    if (rep.ok) { const copie = rep.clone(); caches.open(VERSION).then(c => c.put(req, copie)); }
    return rep;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match("./index.html"))));
});

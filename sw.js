/* À la pompe — service worker
   - Coquille de l'application en cache (fonctionne hors ligne avec les dernières données)
   - Les API (prix, enseignes, adresses) ne sont jamais servies depuis ce cache :
     l'application gère elle-même l'affichage des dernières données datées. */
const VERSION = "a-la-pompe-v2.0.0";
const COQUILLE = [
  "./", "./index.html", "./styles.css", "./app.js", "./manifest.webmanifest",
  "./vendor/leaflet.js", "./vendor/leaflet.css",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png"
];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(COQUILLE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(cles => Promise.all(cles.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  // Réseau d'abord (version à jour), cache en secours
  e.respondWith(
    fetch(req).then(rep => {
      if (rep.ok) { const copie = rep.clone(); caches.open(VERSION).then(c => c.put(req, copie)); }
      return rep;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match("./index.html")))
  );
});

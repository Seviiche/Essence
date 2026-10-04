/* À la pompe — logique de l'application
   Sources :
   - Prix, ruptures, dates : flux officiel « Prix des carburants en France – Flux instantané v2 »
     (ministère de l'Économie, data.economie.gouv.fr, licence ouverte)
   - Enseignes : API tierce prix-carburants.2aaz.fr (enrichissement facultatif, mis en cache 30 jours)
   - Géocodage : Géoplateforme IGN (data.geopf.fr)
*/
"use strict";

const C = {
  OFFICIEL: "https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2",
  ENSEIGNES: "https://api.prix-carburants.2aaz.fr",
  GEOCODAGE: "https://data.geopf.fr/geocodage",
  RAYON_DEFAUT: 30, RAYON_MIN: 5, RAYON_MAX: 50,
  COEF_ROUTE: 1.3,            // vol d'oiseau -> distance routière approchée
  RECENT_H: 72,               // seuil « prix fiable » pour les comparaisons
  SUSPECT: 0.20,              // écart > 20 % à la médiane = prix suspect
  ENSEIGNES_PAGES_MAX: 8,     // 8 × 20 stations les plus proches au maximum
  ENSEIGNES_TTL_J: 30,
  ENSEIGNES_MAX: 4000,
  NATIONAL_TTL_MIN: 60
};
const CARBUS = [
  { k: "gazole", n: "Gazole",   d: "B7, diesel" },
  { k: "e10",    n: "SP95-E10", d: "Sans plomb 95, 10 % éthanol" },
  { k: "sp95",   n: "SP95",     d: "Sans plomb 95 (E5)" },
  { k: "sp98",   n: "SP98",     d: "Sans plomb 98 (E5)" },
  { k: "e85",    n: "E85",      d: "Superéthanol" },
  { k: "gplc",   n: "GPLc",     d: "GPL carburant" }
];
const H = 36e5, J = 864e5;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const enc = encodeURIComponent;

/* ================= Stockage local tolérant aux erreurs ================= */
const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
};

/* ================= Préférences ================= */
const prefs = Object.assign(
  { carbu: "gazole", rayon: C.RAYON_DEFAUT, volume: 40, conso: 6.5, tri: "prix",
    filtres: { recent: false, rupt: false, autoroute: false, h24: false } },
  store.get("prefs", {})
);
(function lireURL() {
  const q = new URLSearchParams(location.search);
  if (CARBUS.some(c => c.k === q.get("carbu"))) prefs.carbu = q.get("carbu");
  const r = Number(q.get("rayon"));
  if (r >= C.RAYON_MIN && r <= C.RAYON_MAX) prefs.rayon = Math.round(r / 5) * 5;
})();
const sauverPrefs = () => store.set("prefs", prefs);
const nomCarbu = k => (CARBUS.find(c => c.k === k) || {}).n || k;

/* ================= État ================= */
const etat = {
  pos: null,                 // {lat, lon, precision?, libelle, source:"gps"|"adresse"}
  brut: [], charge: null,    // stations chargées + contexte {carbu, rayon, pos, t}
  nat: null, flux: null,
  enseignes: store.get("enseignes", {}),
  enseignesStatut: "attente",
  horsLigne: false,
  carte: null, calque: null, marqueurs: new Map(),
  jeton: 0
};

/* ================= Utilitaires ================= */
const pause = ms => new Promise(r => setTimeout(r, ms));
class ErreurHTTP extends Error { constructor(s) { super(`HTTP ${s}`); this.status = s; } }

async function fetchJSON(url, { timeout = 12000, retries = 2, headers = {} } = {}) {
  let derniere;
  for (let i = 0; i <= retries; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { headers, signal: ctl.signal });
      clearTimeout(t);
      if (r.ok) return { data: await r.json(), headers: r.headers };
      derniere = new ErreurHTTP(r.status);
      if (r.status < 500 && r.status !== 429) break;          // erreur client : inutile de réessayer
    } catch (e) {
      clearTimeout(t);
      derniere = e.name === "AbortError" ? new Error("délai de réponse dépassé")
               : e instanceof TypeError ? new Error("serveur injoignable ou pas de connexion") : e;
    }
    if (i < retries) await pause(700 * 2 ** i);
  }
  throw derniere;
}

const echap = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const titreCasse = s => String(s || "").toLowerCase().replace(/(^|[\s\-'’(])\p{L}/gu, m => m.toUpperCase()).trim();
const euros3 = v => v.toFixed(3).replace(".", ",");
const euros2 = v => v.toFixed(2).replace(".", ",");
const km = v => (v < 10 ? v.toFixed(1) : Math.round(v).toString()).replace(".", ",");
const centimes = d => `${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(d * 100).toFixed(1).replace(".", ",")} ct`;
const signeEuros = d => `${d > 0 ? "+" : d < 0 ? "−" : ""}${euros2(Math.abs(d))} €`;
function mediane(t) {
  if (!t.length) return null;
  const s = [...t].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function distanceKm(a, b, c, d) {
  const R = 6371, r = x => x * Math.PI / 180, dl = r(c - a), dg = r(d - b);
  const h = Math.sin(dl / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dg / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ---- Dates : le flux affiche « +00:00 » mais les heures sont en heure de Paris ---- */
const fmtParis = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
function decalageParis(ts) {
  const p = Object.fromEntries(fmtParis.formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ts;
}
function heureParis(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const naif = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const d = new Date(naif - decalageParis(naif));
  return d.getTime() > Date.now() + 2 * H ? null : d;            // date dans le futur = donnée invalide
}
const hhmm = d => d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }).replace(":", "h");
function quand(d) {
  if (!d) return "à une date inconnue";
  const auj = new Date(); auj.setHours(0, 0, 0, 0);
  const jour = new Date(d); jour.setHours(0, 0, 0, 0);
  const n = Math.round((auj - jour) / J);
  if (n <= 0) return `aujourd'hui à ${hhmm(d)}`;
  if (n === 1) return `hier à ${hhmm(d)}`;
  return `il y a ${n} jours (${d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })})`;
}
function fiabilite(ageH) {
  if (!isFinite(ageH)) return { c: "f-douteux", t: "très faible" };
  if (ageH <= 24) return { c: "f-frais", t: "élevée" };
  if (ageH <= 72) return { c: "f-moyen", t: "moyenne" };
  if (ageH <= 168) return { c: "f-vieux", t: "faible" };
  return { c: "f-douteux", t: "très faible" };
}

/* ================= Sources de données ================= */
async function chargerOfficiel(carbu, pos, rayon) {
  const f = carbu;
  const champs = ["id", "adresse", "ville", "cp", "pop", "geom", "horaires_automate_24_24",
    `${f}_prix`, `${f}_maj`, `${f}_rupture_debut`, `${f}_rupture_type`].join(",");
  const ou = `within_distance(geom, geom'POINT(${pos.lon.toFixed(5)} ${pos.lat.toFixed(5)})', ${rayon}km)` +
             ` and (${f}_prix is not null or ${f}_rupture_type="temporaire")`;
  const { data } = await fetchJSON(`${C.OFFICIEL}/exports/json?select=${enc(champs)}&where=${enc(ou)}`, { timeout: 20000 });
  if (!Array.isArray(data)) throw new Error("réponse inattendue de l'API officielle");
  const sortie = [];
  for (const s of data) {
    const lat = Number(s.geom?.lat), lon = Number(s.geom?.lon);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const rupture = s[`${f}_rupture_type`] === "temporaire";
    const p = Number(s[`${f}_prix`]);
    const prix = !rupture && p > 0.2 && p < 6 ? p : null;      // bornes physiques grossières
    if (prix == null && !rupture) continue;
    sortie.push({
      id: String(s.id), adresse: titreCasse(s.adresse), ville: titreCasse(s.ville), cp: s.cp || "",
      autoroute: s.pop === "A", h24: s.horaires_automate_24_24 === "Oui", lat, lon,
      prix, maj: heureParis(s[`${f}_maj`]),
      rupture, ruptureDebut: rupture ? heureParis(s[`${f}_rupture_debut`]) : null,
      dist: distanceKm(pos.lat, pos.lon, lat, lon)
    });
  }
  return sortie;
}

async function chargerNational(carbu) {
  const cache = store.get("national", {});
  const c = cache[carbu];
  if (c && Date.now() - c.t < C.NATIONAL_TTL_MIN * 60000) return c;
  const sel = `median(${carbu}_prix) as med, count(*) as n`;
  const ou = `${carbu}_maj >= now(days=-7)`;
  const { data } = await fetchJSON(`${C.OFFICIEL}/records?select=${enc(sel)}&where=${enc(ou)}&limit=1`, { retries: 1 });
  const r = data?.results?.[0];
  if (!r || !(r.med > 0)) return null;
  cache[carbu] = { med: r.med, n: r.n, t: Date.now() };
  store.set("national", cache);
  return cache[carbu];
}

async function chargerFlux() {
  const { data } = await fetchJSON(C.OFFICIEL, { retries: 1, timeout: 8000 });
  const d = data?.metas?.default?.data_processed;          // horodatage réellement en UTC
  return d ? new Date(d) : null;
}

/* ---- Enseignes (source tierce, facultative) ---- */
function nettoyerEnseigne(b) {
  if (!b) return null;
  return /sans enseigne/i.test(b) ? "Indépendant" : b;
}
function enseigneDe(id) {
  const e = etat.enseignes[id];
  return e && Date.now() - e.t < C.ENSEIGNES_TTL_J * J ? e : null;
}
function memoriserEnseigne(s) {
  etat.enseignes[String(s.id)] = { b: nettoyerEnseigne(s.Brand?.name), n: s.name ? titreCasse(s.name) : null, t: Date.now() };
}
function sauverEnseignes() {
  const ids = Object.keys(etat.enseignes);
  if (ids.length > C.ENSEIGNES_MAX) {
    ids.sort((a, b) => etat.enseignes[a].t - etat.enseignes[b].t)
       .slice(0, ids.length - C.ENSEIGNES_MAX).forEach(id => delete etat.enseignes[id]);
  }
  store.set("enseignes", etat.enseignes);
}
async function enrichirEnseignes(pos, rayon, ids) {
  const manquants = new Set(ids.filter(id => !enseigneDe(id)));
  if (!manquants.size) { etat.enseignesStatut = "ok"; return false; }
  let modifie = false;
  try {
    for (let p = 0; p < C.ENSEIGNES_PAGES_MAX && manquants.size; p++) {
      const a = p * 20 + 1, b = a + 19;
      const rep = await fetchJSON(`${C.ENSEIGNES}/stations/around/${pos.lat.toFixed(5)},${pos.lon.toFixed(5)}`,
        { headers: { Range: `station=${a}-${b}` }, retries: 1, timeout: 8000 });
      const liste = Array.isArray(rep.data) ? rep.data : [];
      for (const s of liste) { memoriserEnseigne(s); manquants.delete(String(s.id)); modifie = true; }
      const total = Number((rep.headers.get("Content-Range") || "").split("/")[1]) || 0;
      const dernier = liste[liste.length - 1];
      if (!liste.length || (total && b >= total) || (dernier && dernier.distance > rayon * 1000)) break;
    }
    etat.enseignesStatut = manquants.size ? "partiel" : "ok";
  } catch (e) {
    etat.enseignesStatut = modifie || ids.some(id => enseigneDe(id)) ? "partiel" : "ko";
  }
  if (modifie) sauverEnseignes();
  return modifie;
}
async function enseigneUnitaire(id) {
  try {
    const { data } = await fetchJSON(`${C.ENSEIGNES}/station/${enc(id)}`, { retries: 1, timeout: 6000 });
    if (data && data.id) { memoriserEnseigne(data); sauverEnseignes(); return enseigneDe(id); }
  } catch (e) { /* source tierce indisponible : on garde l'adresse */ }
  return null;
}

/* ---- Géolocalisation et géocodage ---- */
function localiser() {
  return new Promise((ok, ko) => {
    if (!("geolocation" in navigator)) return ko(new Error("Ce navigateur ne permet pas la géolocalisation. Cherchez autour d'une adresse."));
    navigator.geolocation.getCurrentPosition(
      p => ok({ lat: p.coords.latitude, lon: p.coords.longitude, precision: p.coords.accuracy, source: "gps",
                libelle: `position GPS (± ${p.coords.accuracy < 1000 ? Math.round(p.coords.accuracy) + " m" : km(p.coords.accuracy / 1000) + " km"})` }),
      e => ko(new Error(e.code === 1
        ? "Localisation refusée. Autorisez-la pour ce site dans les réglages du navigateur, ou cherchez autour d'une adresse."
        : "Position introuvable pour le moment. Vérifiez que la localisation de l'appareil est activée, ou cherchez autour d'une adresse.")),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 120000 });
  });
}
async function geocoder(q) {
  const { data } = await fetchJSON(`${C.GEOCODAGE}/search?q=${enc(q)}&limit=6&autocomplete=1`, { retries: 1, timeout: 6000 });
  return (data?.features || []).map(f => ({
    lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
    libelle: f.properties.label, contexte: f.properties.context, source: "adresse"
  }));
}

/* ================= Persistance du dernier résultat (hors ligne) ================= */
function sauverDernier() {
  const s = etat.brut.map(x => ({ ...x, maj: x.maj?.toISOString() || null, ruptureDebut: x.ruptureDebut?.toISOString() || null }));
  store.set("dernier", { charge: { ...etat.charge, t: etat.charge.t.toISOString() }, brut: s,
    nat: etat.nat, flux: etat.flux?.toISOString() || null });
}
function restaurerDernier() {
  const d = store.get("dernier", null);
  if (!d || !Array.isArray(d.brut)) return false;
  etat.brut = d.brut.map(x => ({ ...x, maj: x.maj ? new Date(x.maj) : null, ruptureDebut: x.ruptureDebut ? new Date(x.ruptureDebut) : null }));
  etat.charge = { ...d.charge, t: new Date(d.charge.t) };
  etat.pos = d.charge.pos; etat.nat = d.nat; etat.flux = d.flux ? new Date(d.flux) : null;
  prefs.carbu = d.charge.carbu;
  prefs.rayon = d.charge.rayon;          // on affiche le rayon réellement couvert par ces données
  return true;
}

/* ================= Analyse ================= */
function coutPlein(s) {
  const kmTrajet = 2 * s.dist * C.COEF_ROUTE;
  return s.prix * prefs.volume + kmTrajet * prefs.conso / 100 * s.prix;
}
function analyser() {
  const now = Date.now(), f = prefs.filtres;
  const tous = etat.brut.filter(s => s.dist <= prefs.rayon + 1e-9);
  const recents7 = tous.filter(s => s.prix != null && s.maj && now - s.maj < 7 * J);
  const medZone = mediane(recents7.map(s => s.prix));
  const refSuspect = etat.nat?.med ?? medZone;
  for (const s of tous) {
    s.ageH = s.maj ? (now - s.maj) / H : Infinity;
    s.ecartZone = s.prix != null && medZone ? s.prix - medZone : null;
    s.ecartNat = s.prix != null && etat.nat ? s.prix - etat.nat.med : null;
    s.suspect = s.prix != null && refSuspect ? Math.abs(s.prix - refSuspect) / refSuspect > C.SUSPECT : false;
    s.ruptureAncienne = s.rupture && s.ruptureDebut ? now - s.ruptureDebut > 7 * J : false;
    s.cout = s.prix != null ? coutPlein(s) : null;
  }
  const fiables = tous.filter(s => s.prix != null && !s.suspect && s.ageH <= C.RECENT_H);
  const reference = fiables.reduce((m, s) => (!m || s.dist < m.dist ? s : m), null);
  for (const s of tous) s.gain = reference && s.cout != null ? reference.cout - s.cout : null;
  const visibles = tous.filter(s =>
    !(f.rupt && s.rupture) &&
    !(f.recent && !s.rupture && s.ageH > C.RECENT_H) &&
    !(f.autoroute && s.autoroute) &&
    !(f.h24 && !s.h24));
  const meilleurPrix = fiables.reduce((m, s) => (!m || s.prix < m.prix || (s.prix === m.prix && s.dist < m.dist) ? s : m), null);
  const meilleurCout = fiables.reduce((m, s) => (!m || s.cout < m.cout ? s : m), null);
  return { tous, visibles, fiables, medZone, n7: recents7.length, reference, meilleurPrix, meilleurCout };
}
function trier(liste) {
  const l = [...liste], inf = Infinity;
  const k = prefs.tri;
  const douteux = s => s.prix == null ? 2 : (s.suspect || s.ageH > 168) ? 1 : 0;
  if (k === "prix") l.sort((a, b) => douteux(a) - douteux(b) || (a.prix ?? inf) - (b.prix ?? inf) || a.dist - b.dist);
  if (k === "cout") l.sort((a, b) => douteux(a) - douteux(b) || (a.cout ?? inf) - (b.cout ?? inf) || a.dist - b.dist);
  if (k === "dist") l.sort((a, b) => a.dist - b.dist);
  if (k === "maj")  l.sort((a, b) => a.ageH - b.ageH);
  return l;
}

/* ================= Interface v2 : carte plein écran ================= */
const ICONE_FERMER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
const nomStation = s => { const e = enseigneDe(s.id); return e?.b || e?.n || "Enseigne inconnue"; };
const estBureau = () => matchMedia("(min-width:900px)").matches;
let derniereAnalyse = null, stationActive = null;

function bandeau(msg) {
  const b = $("#bandeau");
  if (msg) { b.textContent = msg; b.hidden = false; } else { b.hidden = true; b.textContent = ""; }
}

/* ---------- Carte ---------- */
function initCarte() {
  if (etat.carte) return;
  etat.carte = L.map("carte", { zoomControl: false, attributionControl: true, zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 90 }).setView([46.6, 2.4], 6);
  const prix = ' · Prix : <a href="https://data.economie.gouv.fr/explore/dataset/prix-des-carburants-en-france-flux-instantane-v2/">data.economie.gouv.fr</a>';
  const ign = L.tileLayer("https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2" +
    "&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/png&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}",
    { minZoom: 3, maxZoom: 19, attribution: '&copy; <a href="https://geoservices.ign.fr/">IGN</a>' + prix }).addTo(etat.carte);
  let echecs = 0;
  ign.on("tileerror", () => {
    if (++echecs !== 6) return;
    etat.carte.removeLayer(ign);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' + prix }).addTo(etat.carte);
  });
  const zoomClasse = () => {
    const z = etat.carte.getZoom(), el = etat.carte.getContainer();
    el.classList.toggle("z-loin", z < 11);
    el.classList.toggle("z-moyen", z >= 11 && z < 13);
  };
  etat.carte.on("zoomend", zoomClasse); zoomClasse();
  etat.carte.on("click", () => { if (stationActive) fermerDetail(); });
  window.addEventListener("resize", () => { etat.carte.invalidateSize(); placerFeuille(); });
}
function margesCarte() {
  const h = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--feuille-h")) || 130;
  return estBureau()
    ? { paddingTopLeft: [436, 76], paddingBottomRight: [70, 20] }
    : { paddingTopLeft: [12, 70], paddingBottomRight: [12, Math.min(h, innerHeight * .5) + 12] };
}
function rendreCarte(a, recadrer) {
  const c = etat.carte, pos = etat.pos;
  if (etat.calque) etat.calque.remove();
  etat.calque = L.layerGroup();
  etat.marqueurs.clear();
  if (recadrer) c.fitBounds(L.latLng(pos.lat, pos.lon).toBounds(prefs.rayon * 2000), margesCarte());
  L.circle([pos.lat, pos.lon], { radius: prefs.rayon * 1000, color: "#2350E6", weight: 2, opacity: .85,
    dashArray: "6 7", fill: true, fillColor: "#2350E6", fillOpacity: .04, interactive: false }).addTo(etat.calque);
  L.marker([pos.lat, pos.lon], { icon: L.divIcon({ className: "", html: '<div class="moi"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
    keyboard: false, interactive: false, zIndexOffset: -1e7 }).addTo(etat.calque);
  // Ordre d'empilement : le moins cher toujours au-dessus, les ruptures dessous
  const ordre = [...a.visibles].filter(s => !s.rupture).sort((x, y) => (x.suspect - y.suspect) || x.prix - y.prix);
  const rang = new Map(ordre.map((s, i) => [s.id, i]));
  const topId = a.meilleurPrix?.id;
  for (const s of a.visibles) {
    const cls = s.rupture ? "f-rupture rupt" : fiabilite(s.ageH).c + (s.suspect ? " suspect" : "");
    const txt = s.rupture ? "Rupture" : euros3(s.prix);
    const z = s.id === topId ? 1e7 : s.rupture ? -1e6 : (ordre.length - rang.get(s.id)) * 1000;
    const m = L.marker([s.lat, s.lon], {
      icon: L.divIcon({ className: "", iconSize: [0, 0],
        html: `<div class="etq ${cls}${s.id === topId ? " top" : ""}${s.id === stationActive ? " actif" : ""}">${txt}</div>` }),
      zIndexOffset: z, title: `${nomStation(s)} — ${s.rupture ? "rupture" : euros3(s.prix) + " €"}`, riseOnHover: true
    }).on("click", e => {
      L.DomEvent.stopPropagation(e);
      // Vue large et étiquettes serrées : on rapproche d'abord pour rendre le secteur lisible
      if (etat.carte.getZoom() < 12) etat.carte.setView([s.lat, s.lon], 13.5, { animate: true });
      ouvrirDetail(s.id, false);
    });
    m.addTo(etat.calque);
    etat.marqueurs.set(s.id, m);
  }
  etat.calque.addTo(c);
}

/* ---------- Feuille du bas ---------- */
const feuille = () => $("#feuille");
function hauteurBasse() {
  if (stationActive) return Math.min(innerHeight * .62, 520);
  const r = $("#resume");
  return Math.max(110, Math.min(240, 24 + (r?.offsetHeight || 80) + 18));
}
function placerFeuille() {
  const f = feuille(), e = f.dataset.etat;
  let h;
  if (estBureau()) h = innerHeight - 16 - 72;
  else h = e === "haut" ? innerHeight * .88 : e === "mi" ? innerHeight * .55 : hauteurBasse();
  document.documentElement.style.setProperty("--feuille-h", `${Math.round(h)}px`);
}
function etatFeuille(e) { feuille().dataset.etat = e; placerFeuille(); }
(function gesteFeuille() {
  const p = $("#poignee"); let y0 = null, h0 = 0, bouge = false;
  p.addEventListener("pointerdown", ev => { y0 = ev.clientY; h0 = feuille().offsetHeight; bouge = false; p.setPointerCapture(ev.pointerId); feuille().style.transition = "none"; });
  p.addEventListener("pointermove", ev => {
    if (y0 == null) return;
    const dy = y0 - ev.clientY; if (Math.abs(dy) > 6) bouge = true;
    document.documentElement.style.setProperty("--feuille-h", `${Math.max(90, Math.min(innerHeight * .92, h0 + dy))}px`);
  });
  p.addEventListener("pointerup", () => {
    if (y0 == null) return;
    feuille().style.transition = "";
    const h = feuille().offsetHeight; y0 = null;
    if (!bouge) { const e = feuille().dataset.etat; etatFeuille(e === "bas" ? "mi" : "bas"); return; }
    const cibles = [["bas", hauteurBasse()], ["mi", innerHeight * .55], ["haut", innerHeight * .88]];
    etatFeuille(cibles.reduce((m, c) => Math.abs(c[1] - h) < Math.abs(m[1] - h) ? c : m)[0]);
  });
})();

/* ---------- Résumé, liste, détail ---------- */
function rendreResume(a) {
  const n = nomCarbu(prefs.carbu), el = $("#resume");
  if (!a.tous.length) {
    el.innerHTML = `<div class="ou"><b>Aucune station ne déclare de ${n}</b> dans un rayon de ${prefs.rayon} km.</div>
      <div class="etat">Augmentez la distance ou changez de carburant.</div>`;
    return;
  }
  const mp = a.meilleurPrix;
  const rupt = a.tous.filter(s => s.rupture).length;
  const etatTxt = `${a.tous.length - rupt} prix · ${rupt} rupture${rupt > 1 ? "s" : ""} · ${prefs.rayon} km${etat.horsLigne ? " · hors ligne" : ""}`;
  el.innerHTML = mp
    ? `<div class="ligne1"><span class="gros">${euros3(mp.prix)} €</span>
         <span class="ou"><b>${echap(nomStation(mp))}</b><br>${echap(mp.ville)} · ${km(mp.dist)} km · ${quand(mp.maj)}</span></div>
       <div class="etat">Meilleur prix ${n} à jour (moins de 72 h) · ${etatTxt}</div>`
    : `<div class="ou"><b>Aucun prix ${n} à jour depuis moins de 72 h.</b> Les prix affichés sont anciens : à vérifier sur place.</div>
       <div class="etat">${etatTxt}</div>`;
}
function rendreInfos(a) {
  const el = $("#infos");
  if (!a.tous.length) { el.innerHTML = ""; return; }
  let h = "";
  const mc = a.meilleurCout, ref = a.reference;
  if (mc && ref) {
    h += mc.id !== ref.id && mc.gain > 0.5
      ? `<div class="encart">Pour ${prefs.volume} L, trajet compris : <b>${echap(nomStation(mc))}</b> (${km(mc.dist)} km) fait gagner
         <b class="plus">${signeEuros(mc.gain)}</b> par rapport à la plus proche à jour (${echap(nomStation(ref))}, ${km(ref.dist)} km).</div>`
      : `<div class="encart neutre">Pour ${prefs.volume} L, le détour ne vaut pas le coup : la plus proche à jour (${echap(nomStation(ref))}, ${km(ref.dist)} km) est la plus avantageuse une fois le trajet compté.</div>`;
  }
  h += `<div class="reperes">
    <div><b>${a.medZone ? euros3(a.medZone) + " €" : "—"}</b><span>Médiane de la zone · ${a.n7} prix &lt; 7 j</span></div>
    <div><b>${etat.nat ? euros3(etat.nat.med) + " €" : "—"}</b><span>${etat.nat ? `Médiane nationale · ${etat.nat.n.toLocaleString("fr-FR")} stations` : "Médiane nationale indisponible"}</span></div></div>`;
  el.innerHTML = h;
}
function statutStation(s) {
  if (s.rupture) return `<span class="pastille f-rupture"></span><span class="alerte">Rupture</span> déclarée ${quand(s.ruptureDebut)}${s.ruptureAncienne ? " · statut incertain" : ""}`;
  const f = fiabilite(s.ageH);
  return `<span class="pastille ${f.c}"></span>${quand(s.maj)}${s.suspect ? ' · <span class="alerte">prix suspect</span>' : ""}`;
}
function rendreListe(a) {
  const ol = $("#liste");
  if (!a.visibles.length) {
    ol.innerHTML = `<li class="vide">${a.tous.length ? "Aucune station ne correspond aux réglages d'affichage." : "Aucune station dans ce rayon."}</li>`;
    return;
  }
  ol.innerHTML = trier(a.visibles).map(s => {
    const droite = s.rupture
      ? `<div class="prix rupt">Rupture</div>`
      : `<div class="prix">${euros3(s.prix)}</div>${s.gain != null && a.reference && s.id !== a.reference.id
          ? `<div class="sous ${s.gain >= 0 ? "plus" : "moins"}">${signeEuros(s.gain)}</div>` : `<div class="sous">${s.ecartZone != null ? centimes(s.ecartZone) : ""}</div>`}`;
    return `<li data-id="${s.id}" tabindex="0">
      <div class="nom">${echap(nomStation(s))}</div>
      <div class="adr">${echap(s.ville)} · ${km(s.dist)} km${s.autoroute ? " · autoroute" : ""}</div>
      <div class="statut">${statutStation(s)}</div>
      <div class="droite">${droite}</div></li>`;
  }).join("");
}
function rendreSource() {
  const m = [];
  m.push(etat.flux ? `Flux officiel rafraîchi ${quand(etat.flux)}` : "Fraîcheur du flux officiel inconnue");
  if (etat.charge) m.push(`chargé ${quand(etat.charge.t)}`);
  if (etat.pos) m.push(`autour de : ${etat.pos.libelle}`);
  m.push({ ok: "enseignes : 2aaz.fr (source tierce)", partiel: "enseignes partielles (source tierce)",
           ko: "enseignes indisponibles", attente: "enseignes en cours…" }[etat.enseignesStatut]);
  $("#source").textContent = m.join(" · ");
}
function contenuDetail(s, a) {
  const e = enseigneDe(s.id);
  const dest = `${s.lat},${s.lon}`;
  let corps;
  if (s.rupture) {
    corps = `<div class="detail-prix" style="color:var(--rupture)">Rupture</div>
      <span class="badge"><span class="pastille f-rupture"></span>${nomCarbu(prefs.carbu)} indisponible, déclaré ${quand(s.ruptureDebut)}</span>
      ${s.ruptureAncienne ? `<p class="alerte">Rupture déclarée il y a plus de 7 jours : la station a peut-être oublié de lever le statut.</p>` : ""}`;
  } else {
    const f = fiabilite(s.ageH);
    corps = `<div class="detail-prix">${euros3(s.prix)} <small>€/L</small></div>
      <span class="badge"><span class="pastille ${f.c}"></span>Mis à jour ${quand(s.maj)} · fiabilité ${f.t}</span>
      ${s.suspect ? `<p class="alerte">Prix suspect : plus de 20 % d'écart avec la médiane. Erreur de saisie probable.</p>` : ""}
      <table class="tableau">
        ${s.ecartZone != null ? `<tr><td>Écart à la médiane de la zone</td><td>${centimes(s.ecartZone)}</td></tr>` : ""}
        ${s.ecartNat != null ? `<tr><td>Écart à la médiane nationale</td><td>${centimes(s.ecartNat)}</td></tr>` : ""}
        <tr><td>Plein de ${prefs.volume} L + aller-retour</td><td>${euros2(s.cout)} €</td></tr>
        ${s.gain != null && a.reference && a.reference.id !== s.id
          ? `<tr><td>Par rapport à la plus proche à jour</td><td class="${s.gain >= 0 ? "plus" : "moins"}">${signeEuros(s.gain)}</td></tr>` : ""}
      </table>`;
  }
  return `<div class="detail-haut"><div><h2>${echap(e?.b || "Enseigne inconnue")}</h2>
      <div class="adr">${e?.n && e.n !== e.b ? echap(e.n) + " · " : ""}${echap(s.adresse)}, ${echap(s.cp)} ${echap(s.ville)}</div>
      <div class="adr">${km(s.dist)} km${s.autoroute ? " · autoroute" : ""}${s.h24 ? " · automate 24 h/24" : ""}</div></div>
      <button class="fermer" id="fermerDetail" type="button" aria-label="Fermer">${ICONE_FERMER}</button></div>
    ${corps}
    <div class="nav">
      <a href="https://waze.com/ul?ll=${dest}&navigate=yes" target="_blank" rel="noopener">Waze</a>
      <a href="https://www.google.com/maps/dir/?api=1&destination=${dest}" target="_blank" rel="noopener">Google</a>
      <a href="https://maps.apple.com/?daddr=${dest}" target="_blank" rel="noopener">Plans</a>
    </div>
    <a class="lien-off" href="https://www.prix-carburants.gouv.fr/station/${enc(s.id)}" target="_blank" rel="noopener">Fiche sur prix-carburants.gouv.fr</a>`;
}
function marquerActif(id) {
  for (const [k, m] of etat.marqueurs) m.getElement()?.querySelector(".etq")?.classList.toggle("actif", k === id);
}
async function ouvrirDetail(id, centrer) {
  const a = derniereAnalyse, s = a?.tous.find(x => x.id === id);
  if (!s) return;
  stationActive = id;
  $("#vueListe").hidden = true;
  const v = $("#vueDetail"); v.hidden = false; v.innerHTML = contenuDetail(s, a);
  $("#fermerDetail").onclick = fermerDetail;
  marquerActif(id);
  etatFeuille("bas");
  $(".feuille-corps").scrollTop = 0;
  if (centrer) etat.carte.setView([s.lat, s.lon], Math.max(etat.carte.getZoom(), 14), { animate: true });
  else if (!estBureau()) etat.carte.panInside([s.lat, s.lon], { paddingBottomRight: [20, hauteurBasse() + 30], paddingTopLeft: [20, 80] });
  if (!enseigneDe(id)) {
    const e = await enseigneUnitaire(id);
    if (e && stationActive === id) { v.innerHTML = contenuDetail(s, a); $("#fermerDetail").onclick = fermerDetail; }
  }
}
function fermerDetail() {
  stationActive = null;
  $("#vueDetail").hidden = true; $("#vueDetail").innerHTML = "";
  $("#vueListe").hidden = false;
  marquerActif(null);
  etatFeuille("bas");
}

function rendre(recadrer = true) {
  initCarte();
  const a = analyser();
  derniereAnalyse = a;
  rendreResume(a); rendreInfos(a); rendreListe(a); rendreSource();
  placerFeuille();
  rendreCarte(a, recadrer);
  if (stationActive) {
    if (a.tous.some(s => s.id === stationActive)) ouvrirDetail(stationActive, false); else fermerDetail();
  }
  synchroniserControles();
}

/* ================= Orchestration ================= */
function memeContexte() {
  const ch = etat.charge;
  return ch && ch.carbu === prefs.carbu && ch.pos && etat.pos &&
         ch.pos.lat === etat.pos.lat && ch.pos.lon === etat.pos.lon && prefs.rayon <= ch.rayon;
}
async function charger({ forcer = false } = {}) {
  if (!etat.pos) return;
  if (!forcer && memeContexte()) { rendre(true); return; }
  const mon = ++etat.jeton;
  const carbu = prefs.carbu, rayon = prefs.rayon, pos = { ...etat.pos };
  $("#resume").innerHTML = `<div class="ou">Chargement des prix ${nomCarbu(carbu)} dans un rayon de ${rayon} km…</div>`;
  bandeau(null);
  const [off, nat, flux] = await Promise.allSettled([chargerOfficiel(carbu, pos, rayon), chargerNational(carbu), chargerFlux()]);
  if (mon !== etat.jeton) return;
  if (off.status === "rejected") {
    const raison = off.reason?.message || "erreur réseau";
    const d = store.get("dernier", null);
    if (d && d.charge?.carbu === carbu && restaurerDernier()) {
      etat.horsLigne = true; rendre(true);
      bandeau(`Le flux officiel ne répond pas (${raison}). Dernières données enregistrées : ${etat.charge.rayon} km, chargées ${quand(etat.charge.t)}.`);
    } else {
      $("#resume").innerHTML = `<div class="ou"><b>Données indisponibles.</b></div>`;
      bandeau(`Le flux officiel des prix ne répond pas (${raison}). Vérifiez la connexion puis réessayez.`);
    }
    return;
  }
  etat.brut = off.value;
  etat.nat = nat.status === "fulfilled" ? nat.value : null;
  etat.flux = flux.status === "fulfilled" ? flux.value : null;
  etat.charge = { carbu, rayon, pos, t: new Date() };
  etat.horsLigne = false; etat.enseignesStatut = "attente";
  sauverDernier();
  rendre(true);
  if (etat.flux && Date.now() - etat.flux > 6 * H) bandeau(`Le flux officiel n'a pas été rafraîchi depuis ${quand(etat.flux)} : les ruptures récentes peuvent manquer.`);
  else if (etat.pos.source === "gps" && etat.pos.precision > 3000) bandeau(`Position peu précise (± ${km(etat.pos.precision / 1000)} km) : distances approximatives.`);
  const modifie = await enrichirEnseignes(pos, rayon, etat.brut.map(s => s.id));
  if (mon !== etat.jeton) return;
  if (modifie) rendre(false); else rendreSource();
}

/* ================= Contrôles ================= */
function remplirCarbus() {
  $("#listeCarbus").innerHTML = CARBUS.map(c => `<input type="radio" name="carbu" id="c-${c.k}" value="${c.k}" ${c.k === prefs.carbu ? "checked" : ""}>
    <label for="c-${c.k}" title="${c.d}">${c.n}</label>`).join("");
  $("#puces").innerHTML = CARBUS.map(c => `<button type="button" class="puce" role="radio" data-carbu="${c.k}" aria-checked="false" title="${c.d}">${c.n}</button>`).join("");
}
function synchroniserControles() {
  $$("#puces .puce").forEach(b => b.setAttribute("aria-checked", String(b.dataset.carbu === prefs.carbu)));
  $("#puces .puce[aria-checked=true]")?.scrollIntoView({ inline: "nearest", block: "nearest" });
  $("#rayonPuce").textContent = `${prefs.rayon} km`;
  $("#rayon").value = prefs.rayon; $("#rayonVal").textContent = `${prefs.rayon} km`;
  $("#rayonAccueil").value = prefs.rayon; $("#rayonAccueilVal").textContent = `${prefs.rayon} km`;
  $$(".barre-tri button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.tri === prefs.tri)));
  try {
    const u = new URL(location.href);
    u.searchParams.set("carbu", prefs.carbu); u.searchParams.set("rayon", prefs.rayon);
    history.replaceState(null, "", u);
  } catch (e) {}
}
function ouvrirAppli() {
  $("#accueil").hidden = true;
  ["#haut", "#boutonsCarte", "#feuille"].forEach(s => { $(s).hidden = false; });
  initCarte();
  placerFeuille();
  setTimeout(() => etat.carte.invalidateSize(), 0);
}
async function demarrerGPS(bouton) {
  const libelle = bouton?.textContent;
  if (bouton) { bouton.disabled = true; if (bouton.id === "btnGo") bouton.textContent = "Localisation…"; }
  try {
    etat.pos = await localiser();
    ouvrirAppli();
    await charger({ forcer: true });
  } catch (e) {
    if (!$("#accueil").hidden) $("#msgAccueil").innerHTML = `<div class="erreur">${echap(e.message)}</div>`;
    else bandeau(e.message);
  } finally {
    if (bouton) { bouton.disabled = false; if (bouton.id === "btnGo") bouton.textContent = libelle; }
  }
}

/* Recherche d'adresse */
let minuteur = null, requeteAdresse = 0, resultats = [];
function ouvrirAdresse() {
  $("#resultatsAdresse").innerHTML = ""; $("#champAdresse").value = "";
  $("#dlgAdresse").showModal(); $("#champAdresse").focus();
}
$("#champAdresse").addEventListener("input", e => {
  clearTimeout(minuteur);
  const q = e.target.value.trim();
  if (q.length < 3) { $("#resultatsAdresse").innerHTML = ""; return; }
  minuteur = setTimeout(async () => {
    const mon = ++requeteAdresse;
    try {
      resultats = await geocoder(q);
      if (mon !== requeteAdresse) return;
      $("#resultatsAdresse").innerHTML = resultats.length
        ? resultats.map((r, i) => `<li><button type="button" data-i="${i}">${echap(r.libelle)}<small>${echap(r.contexte || "")}</small></button></li>`).join("")
        : `<li class="aide">Aucune adresse trouvée.</li>`;
    } catch (err) {
      if (mon === requeteAdresse) $("#resultatsAdresse").innerHTML = `<li class="aide">Service d'adresses indisponible (${echap(err.message)}).</li>`;
    }
  }, 300);
});
$("#resultatsAdresse").addEventListener("click", ev => {
  const b = ev.target.closest("button[data-i]"); if (!b) return;
  etat.pos = resultats[+b.dataset.i];
  $("#dlgAdresse").close();
  ouvrirAppli(); charger({ forcer: true });
});
$("#fermerAdresse").addEventListener("click", () => $("#dlgAdresse").close());

/* Accueil */
$("#formAccueil").addEventListener("submit", ev => {
  ev.preventDefault();
  prefs.carbu = new FormData(ev.target).get("carbu") || prefs.carbu; sauverPrefs();
  demarrerGPS($("#btnGo"));
});
$("#btnAdresseAccueil").addEventListener("click", () => {
  prefs.carbu = new FormData($("#formAccueil")).get("carbu") || prefs.carbu; sauverPrefs(); ouvrirAdresse();
});
$("#rayonAccueil").addEventListener("input", e => { prefs.rayon = +e.target.value; $("#rayonAccueilVal").textContent = `${prefs.rayon} km`; sauverPrefs(); });

/* Barre du haut */
$("#puces").addEventListener("click", e => {
  const b = e.target.closest(".puce"); if (!b || b.dataset.carbu === prefs.carbu) return;
  prefs.carbu = b.dataset.carbu; sauverPrefs(); synchroniserControles(); fermerDetail(); charger();
});
$("#btnRayon").addEventListener("click", () => { $("#rayon").value = prefs.rayon; $("#rayonVal").textContent = `${prefs.rayon} km`; $("#dlgRayon").showModal(); });
$("#rayon").addEventListener("input", e => { $("#rayonVal").textContent = `${e.target.value} km`; });
$("#dlgRayon").addEventListener("close", () => {
  if ($("#dlgRayon").returnValue !== "ok") return;
  const r = +$("#rayon").value; if (r === prefs.rayon) return;
  prefs.rayon = r; sauverPrefs(); charger();
});
$("#btnMenu").addEventListener("click", () => {
  $("#volume").value = prefs.volume; $("#conso").value = prefs.conso;
  $$("[data-filtre]").forEach(i => { i.checked = !!prefs.filtres[i.dataset.filtre]; });
  $("#dlgMenu").showModal();
});
$("#dlgMenu").addEventListener("close", () => {
  if ($("#dlgMenu").returnValue !== "ok") return;
  const v = Number($("#volume").value), c = Number($("#conso").value);
  if (v >= 5 && v <= 150) prefs.volume = v;
  if (c >= 2 && c <= 30) prefs.conso = c;
  $$("[data-filtre]").forEach(i => { prefs.filtres[i.dataset.filtre] = i.checked; });
  sauverPrefs();
  if (etat.charge) rendre(false);
});
$("#btnPosition").addEventListener("click", e => demarrerGPS(e.currentTarget));
$("#btnAdresse").addEventListener("click", ouvrirAdresse);

/* Feuille */
$$(".barre-tri button").forEach(b => b.addEventListener("click", () => {
  prefs.tri = b.dataset.tri; sauverPrefs(); synchroniserControles();
  if (derniereAnalyse) rendreListe(derniereAnalyse);
}));
$("#liste").addEventListener("click", e => { const li = e.target.closest("li[data-id]"); if (li) ouvrirDetail(li.dataset.id, true); });
$("#liste").addEventListener("keydown", e => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const li = e.target.closest("li[data-id]"); if (li) { e.preventDefault(); ouvrirDetail(li.dataset.id, true); }
});
$("#resume").addEventListener("click", () => {
  if (derniereAnalyse?.meilleurPrix) ouvrirDetail(derniereAnalyse.meilleurPrix.id, true);
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && stationActive) fermerDetail(); });
window.addEventListener("online", () => { if (etat.horsLigne) charger({ forcer: true }); });

/* ================= Démarrage ================= */
(async function demarrer() {
  remplirCarbus();
  synchroniserControles();
  initCarte();
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  if (!navigator.onLine && restaurerDernier()) {
    etat.horsLigne = true; ouvrirAppli(); rendre(true);
    bandeau(`Hors ligne : données chargées ${quand(etat.charge.t)}. Le fond de carte peut manquer.`);
    return;
  }
  try {
    const p = await navigator.permissions?.query({ name: "geolocation" });
    if (p && p.state === "granted" && store.get("prefs", null)) await demarrerGPS(null);
  } catch (e) {}
})();

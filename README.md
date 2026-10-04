# À la pompe

Application web statique : prix et disponibilité d'un carburant autour de soi (5 à 50 km, 30 km par défaut), avec l'âge de chaque information et un niveau de fiabilité.

## Mise en ligne (GitHub Pages)

1. Créer un dépôt (ex. `a-la-pompe`) et y déposer **tout le contenu de ce dossier** (garder `vendor/` et `icons/`).
2. Settings → Pages → Source : branche `main`, dossier `/ (root)`.
3. L'adresse sera `https://<compte>.github.io/a-la-pompe/`.

Le HTTPS est obligatoire pour la géolocalisation et l'installation sur l'écran d'accueil ; GitHub Pages le fournit.
Après chaque mise à jour du code, incrémenter `VERSION` dans `sw.js` pour forcer le renouvellement du cache.

## Sources de données

| Donnée | Source | Statut |
|---|---|---|
| Prix, ruptures, dates de mise à jour | Flux instantané v2, ministère de l'Économie (data.economie.gouv.fr, licence ouverte) | Officielle, indispensable |
| Médiane nationale | Même flux, agrégation des prix de moins de 7 jours | Officielle, facultative |
| Enseignes | API prix-carburants.2aaz.fr | Tierce, facultative, cache 30 jours |
| Adresses | Géoplateforme IGN | Officielle |
| Fond de carte | Plan IGN v2 (secours : OpenStreetMap) | Officielle |

La bibliothèque Leaflet 1.9.4 est copiée dans `vendor/` : pas de dépendance à un CDN. Aucun regroupement des stations : chaque prix est affiché sur la carte.

## Règles de fiabilité appliquées

- **Heures** : le flux annonce « +00:00 » mais les heures sont en heure de Paris ; l'application corrige ce décalage.
- **Fiabilité d'un prix** selon son âge : < 24 h élevée, 1–3 j moyenne, 3–7 j faible, > 7 j très faible.
- **Comparaisons et calcul du détour** : uniquement sur les prix de moins de 72 h et non suspects.
- **Prix suspect** : écart de plus de 20 % à la médiane nationale (sinon à celle de la zone). Le prix reste affiché, signalé.
- **Rupture** : seules les ruptures temporaires sont affichées ; une rupture déclarée il y a plus de 7 jours est signalée comme statut incertain.
- **Pannes** : délais de réponse, nouvelles tentatives, et repli sur les dernières données enregistrées, datées dans un bandeau.

## Calcul « le détour vaut-il le coup »

Coût = prix × litres + aller-retour (distance à vol d'oiseau × 1,3) × consommation × prix.
Référence : la station à jour la plus proche. Le temps passé n'est pas compté.

## Limites connues

- Disponibilité déclarative : « disponible » signifie « aucune rupture déclarée ».
- Les enseignes manquent pour les stations inconnues de la source tierce ; elles sont recherchées à l'ouverture de la fiche.
- Hors ligne, le fond de carte peut ne pas s'afficher.

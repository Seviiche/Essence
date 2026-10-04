# À la pompe — v2.1

Tous les fichiers sont à plat, sans sous-dossier : on peut les déposer depuis un iPhone.

- `index.html` contient toute l'application (styles et code intégrés). Il suffit à lui seul.
- `sw.js`, `manifest.webmanifest` et les icônes `.png` servent à l'installation sur l'écran d'accueil et à l'usage hors ligne. Ils sont facultatifs.

La bibliothèque de carte (Leaflet 1.9.4) est chargée depuis cdnjs, puis depuis jsDelivr si le premier échoue. Si les deux échouent, l'application l'indique au lieu d'afficher un écran vide.

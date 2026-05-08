# 🎯 OBJECTIF

Créer une application desktop avec Electron permettant d'afficher un overlay Rocket League en temps réel basé sur la Stats API officielle.

L'application doit proposer 2 modes :

1. Mode OBS (browser source via serveur local)
2. Mode overlay (fenêtre transparente always-on-top visible en jeu en mode borderless)

⚠️ CONTRAINTE MAJEURE :
L'application doit être EXTREMEMENT légère et optimisée (CPU, RAM, GPU), car elle tourne en parallèle d’un jeu.

---

# 🧩 STACK TECHNIQUE

* Electron (main process + preload)
* React (frontend overlay)
* Vite (build rapide et léger)
* Node.js (socket TCP Stats API)
* Zustand (state management léger)
* Aucun framework lourd (pas Redux, pas Next.js)

---

# ⚡ EXIGENCES DE PERFORMANCE (CRITIQUE)

* CPU usage cible : < 2%
* RAM cible : < 150MB
* Pas de re-render React inutiles
* Pas de polling intensif (utiliser event-driven uniquement)
* Pas d’animations lourdes (GPU minimal)
* Throttle UI updates (max 10 fps pour overlay)
* Désactiver DevTools en production
* Minimiser le nombre de fenêtres Electron
* Utiliser `contextIsolation: true` et `preload` pour éviter surcharge

---

# 🧠 ARCHITECTURE

## Main process (Electron)

* Gère :

  * Socket TCP vers Stats API (localhost:49123)
  * Calcul des stats session (wins, losses, streak)
  * Fetch MMR (interval 30–60 sec)
  * Envoi des données vers renderer via IPC (event-driven)

## Renderer (React)

* Affiche overlay
* Ne contient AUCUNE logique métier
* Reçoit uniquement des updates via IPC

## Preload

* Expose API sécurisée :

```js
window.api.onStatsUpdate(callback)
```

---

# 🔌 STATS API (Rocket League)

Connexion TCP locale :

* host: 127.0.0.1
* port: 49123

Lire les events JSON en continu.

Détecter fin de match via :

* Event: "UpdateState"
* Data.Game.bHasWinner === true

⚠️ Éviter double comptage (flag interne)

---

# 📊 LOGIQUE SESSION

Stocker en mémoire :

```js
{
  wins: number,
  losses: number,
  streak: number,
  mmr: number,
  lastMatchHandled: boolean
}
```

Règles :

* Win → streak positif
* Loss → streak négatif
* Reset streak si changement de résultat
* Aucun stockage disque obligatoire

---

# 🎨 OVERLAY (React)

UI minimaliste :

* Wins / Losses
* Streak (couleur dynamique)
* MMR

Contraintes :

* Pas de librairie UI lourde
* CSS simple ou Tailwind (config minimal)
* Pas d’images lourdes
* Pas d’animations complexes

---

# 🪟 FENÊTRE OVERLAY ELECTRON

Créer une fenêtre :

* transparent: true
* frame: false
* alwaysOnTop: true
* focusable: false
* skipTaskbar: true
* resizable: false

Important :

```js
win.setIgnoreMouseEvents(true)
```

⚠️ Compatible uniquement avec mode fenêtré/borderless de Rocket League

---

# 📡 MODE OBS

Lancer un serveur HTTP local :

* Express minimal OU serveur natif Node
* Endpoint `/stats`
* Endpoint `/overlay` (HTML statique)

OBS pointera vers :
http://localhost:3000/overlay

---

# 🔄 COMMUNICATION

Utiliser IPC :

Main → Renderer uniquement

* channel: "stats:update"

⚠️ PAS de communication Renderer → Main en boucle

---

# 🧪 OPTIMISATIONS OBLIGATOIRES

* Debounce / throttle des updates UI (100ms min)
* Memoization React (React.memo)
* Zustand avec selectors précis
* Pas de setInterval agressif
* Nettoyage des listeners socket
* Utiliser `requestAnimationFrame` si nécessaire
* Build production minifié

---

# 🔐 SECURITE / STABILITE

* contextIsolation: true
* nodeIntegration: false
* preload script obligatoire
* Gestion erreurs socket (reconnect automatique)
* Ne jamais crasher si API indisponible

---

# 🎛️ FEATURES BONUS (SI PEU COÛTEUX)

* Toggle overlay (raccourci clavier)
* Position configurable
* Sauvegarde légère config JSON
* Couleur dynamique streak (vert/rouge)

---

# 🚫 INTERDIT

* Pas de polling API intensif
* Pas de WebSocket externe inutile
* Pas de dépendances lourdes
* Pas de charts temps réel coûteux
* Pas d’animations React complexes
* Pas de logs console en production

---

# 🎯 RESULTAT ATTENDU

Une app :

* fluide
* stable
* quasi invisible en consommation
* capable de tourner pendant plusieurs heures sans fuite mémoire

---

# 🧾 BONUS

Structurer le projet :

```bash
/electron
  main.js
  preload.js
/src
  /overlay (React)
  store.js
```

---

# FIN

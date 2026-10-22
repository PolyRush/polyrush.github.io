# Poly Rush

Jeu de parkour 3D dans le navigateur, façon obby Roblox : un parcours brut dans une grotte blanche éclairée par des puits de lumière, un chrono, et un éditeur de niveaux intégré.

**Jouer :** ouvre `index.html` dans un navigateur, ou active GitHub Pages sur ce dépôt (branche `main`, dossier racine).

## Commandes

| Touche | Action |
| --- | --- |
| Z Q S D (W A S D en QWERTY), ↑ ↓ | Se déplacer |
| ← → | Tourner la caméra |
| Espace | Sauter |
| Clic droit + souris | Tourner la caméra |
| Maj | Verrou caméra (le perso suit la caméra) |
| Molette, I / O | Zoom (à fond : première personne) |
| R | Recommencer |

## Contenu

- Comptes (e-mail ou Google, via Firebase) : pseudo, records gardés sur le compte, classement par niveau.

- 8 niveaux officiels, débloqués un par un, avec records et écart de temps.
- Un mode entraînement.
- Un éditeur : blocs, blocs mobiles (point A → B, vitesse), tapis roulants, rotation sur 3 axes, salles de plusieurs tailles (dont une tour), test immédiat, export / import texte.

Tout tient dans un seul fichier `index.html` (three.js r128 chargé depuis cdnjs). Sans compte, les records sont gardés dans le navigateur ; avec un compte, ils sont aussi enregistrés dans Firebase. Les niveaux faits dans l'éditeur restent dans le navigateur.

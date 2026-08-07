# AI Worker XSpro

Serveur autonome de remplissage IA en mode spreadsheet pour XSpro BTP.

## Installation

```bash
npm install
```

## Scripts npm

| Script | Description |
|--------|-------------|
| `npm start` | Mode serveur (écoute XSpro) |
| `npm run standalone` | Mode test avec standalone-payload.json par défaut |
| `npm run standalone:detailsDevis` | Mode test — carnet de devis |
| `npm run standalone:listeQuestions` | Mode test — liste de questions |
| `npm run standalone:formulaireGetDetailsFichesTechniques` | Mode test — carnet de liaisons |
| `npm run standalone:formulaireGetDetailsTravaux` | Mode test — fiche de travaux |
| `npm run electron` | Application Electron |
| `npm run electron:standalone` | Electron en mode standalone |
| `npm run build:for-xspro` | Compile `server.js` en exécutable (`pkg`) et le déploie directement dans `../XSpro/assets/model/` — voir [`XSPRO_INTEGRATION.md`](./XSPRO_INTEGRATION.md) §6bis |

## Intégration XSpro

Ce serveur peut être lancé manuellement (`npm start`, ou l'appli Electron autonome —
tray icône dans la zone de notification) **ou** géré directement par XSpro (menu
*Préférences → Serveur IA externe*, sans tray propre puisque c'est alors XSpro qui
pilote le cycle de vie). Les deux modes sont pleinement rétrocompatibles : un
lancement manuel n'est jamais perturbé par XSpro (jamais dupliqué, jamais arrêté).

Pour livrer une modification de ce projet à XSpro : `npm run build:for-xspro`, puis
redémarrer XSpro (ou juste basculer Inactif → Actif dans son menu) — l'exécutable et
les assets (`public/`, `views/`, `worker-config.json`, `standalone/`) embarqués sont
rafraîchis automatiquement s'ils sont plus récents que la copie de travail de XSpro.

Détails complets (spawn, variables d'environnement, cycle de vie, `pkg`) :
[`XSPRO_INTEGRATION.md`](./XSPRO_INTEGRATION.md). Cette étape n'est qu'une partie
de la checklist complète avant de livrer un nouvel installateur XSpro : voir
[`XSpro/docs/mise-en-production.md`](../../XSpro/docs/mise-en-production.md).

## Structure des dossiers

```
/standalone/
  standalone-payload-detailsDevis.json
  standalone-payload-listeQuestions.json
  standalone-payload-formulaireGetDetailsFichesTechniques.json
  standalone-payload-formulaireGetDetailsTravaux.json
/views/
  detailsDevis.js
  formulaireGetDetailsFichesTechniques.js
  formulaireGetDetailsTravaux.js
  formulaireListeQuestions.js
/public/
  index.html
  grid.js
  style.css
```

## Vue : detailsDevis

Gestion des devis avec hiérarchie niveauListe (0, 1, 2, 3).

Styles de ligne configurables via `rowStyles` dans le MANIFEST :
- Niveau 0 et 1 (chapitres) : fond bleu clair, texte gras
- Niveau 2 et 3 : fond blanc cassé

### Champ `tauxHoraire`

Le champ `tauxHoraire` est un **indice numérique** (0, 1, 2, 3...) qui pointe vers une liste de taux horaires. Il ne stocke jamais un montant libre.

**Fonctionnement :**
- Le LLM reçoit des **libellés lisibles** (ex: `"35 €/h"`) via le mécanisme `selectChoix.sendLabel = true`
- Son retour est normalisé en **indice BDD** par `normalizeSelectChoixValue()`
- Si le LLM retourne une valeur hors plage, un **fallback** s'applique :
   - `heuresUnitaire` vide/0 → tauxHoraire = 0 (`—`)
   - `heuresUnitaire` > 0 → tauxHoraire = 1 (premier taux disponible)

**Surcharge dynamique depuis XSpro :**
Payload XSpro → `data.infosVue.parametresDevis.listeTauxHoraires` :
```json
"parametresDevis": {
  "listeTauxHoraires": ["T", 35, 30, 28]
}
```
La fonction `buildSelectChoix()` dans `views/detailsDevis.js` détecte cette liste et reconstruit les labels (ex: `"35 €/h"`, `"30 €/h"`, `"28 €/h"`).

**Correction automatique (postProcess) :**
Deux passes de correction après le LLM :
1. **`postProcessDefaults`** : si `tauxHoraire` vide, valeur conditionnelle selon `heuresUnitaire`
2. **`postProcessMerge`** : cohérence forcée selon `niveauListe` et `sousTraitance`
   - Niveau 0 → toujours 0 (pas de prix ni heures)
   - Niveaux > 1 non sous-traités → 0 si pas d'heures, 1 sinon
   - Sous-traitance = `✓` → heuresUnitaire = 0 et tauxHoraire = `—`

## Vue : formulaireGetDetailsFichesTechniques

Carnet de liaisons (câbles, fluides entre équipements).

## Vue : formulaireGetDetailsTravaux

Fiche de travaux/liste de tâches à réaliser sur chantier.
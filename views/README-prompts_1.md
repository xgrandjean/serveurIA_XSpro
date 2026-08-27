# Contrat JSON / JS des hooks de vue (AI Worker)

Documente les décisions prises le 2026-07-16 sur l'externalisation du paramétrage
prompt. À lire avant de créer ou modifier un hook de vue.

## 1. Pourquoi ce découpage

Chaque vue (`formulaireListeQuestions.js`, `formulaireGetDetailsTravaux.js`, ...)
mélangeait jusqu'ici deux natures de contenu très différentes dans un seul fichier
JS :

- du **comportement** (fonctions : post-traitement, validation de cellule, calcul
  d'effets de bord, restriction de menus déroulants) — nécessairement du code.
- du **texte/paramétrage déclaratif** (prompts système, règles métier sérialisées,
  suggestions, format de réponse attendu) — pas de logique, juste du contenu que
  quelqu'un de non-dev doit pouvoir ajuster sans toucher au code, et qu'on veut
  pouvoir faire évoluer (cycle de vie du contexte envoyé/reçu au LLM) sans
  redéployer.

Le second est désormais extrait dans un fichier JSON **pairé**, même dossier,
même nom de base : `formulaireListeQuestions.js` ↔ `formulaireListeQuestions.json`.

## 2. Ce qui va où

| Reste dans le `.js` | Va dans le `.json` |
|---|---|
| `editionParActions`, `champsMultiligne`, `champsArray`, `champsIndexRef` | `systemPrompt` (base + par mode) |
| `rowStyles`, `surchargesColonnes`, `colonnesUiHidden/LlmHidden` | `regles` (typesEtRegles, formatChamps, valeursPossibles, qualite) |
| `reglesPostProcess`, `exportFormat` | `promptsSuggeres`, `formatReponse` (base + par mode) |
| `postProcessDefaults`, `postProcessMerge` | `historique` (limite de conservation) |
| `validateCellEdit`, `getInvalidFields`, `getMissingFields` | `slots` (policy de cycle de vie, base + par mode) |
| `computeIndexRefSideEffects`, `computeChampsRestreints` | — |

Règle simple pour trancher un cas ambigu futur : **si ça peut se lire comme une
instruction ou une donnée de configuration figée, ça va en JSON ; si ça a besoin
d'un `if`/d'une boucle/d'un calcul, ça reste en JS.**

## 3. Chargement et fusion

Au chargement d'un hook de vue, le loader :

1. Charge le `.js` (comportement + `MANIFEST`/`MODES` tels qu'ils existent
   aujourd'hui).
2. Cherche un `.json` de même nom de base dans le même dossier.
3. **S'il n'existe pas** → comportement actuel inchangé, aucune régression (le
   `.js` reste seul maître du prompt, comme avant cette évolution). C'est le cas
   de rétrocompatibilité pour tout hook non encore migré.
4. **S'il existe** → les clés `systemPrompt`, `regles`, `promptsSuggeres`,
   `formatReponse` du JSON **surchargent** celles du `MANIFEST`/`MODES` du `.js`
   (le `.js` peut donc garder ces clés à `null` une fois migré, comme c'est déjà
   l'usage pour les valeurs héritées). `historique` et `slots` n'existent que
   dans le JSON — pas d'équivalent `.js` à surcharger, puisque c'est un concept
   nouveau.
5. La fusion des `modes.<mode>` suit la même logique que l'actuel `MODES` :
   chaque clé de mode ne surcharge que ce qu'elle définit, le reste hérite du
   socle (racine du JSON, ou `MANIFEST` si absent du JSON).

Aucun changement dans la façon dont `viewResolver.js`/`effectiveWorkerConfig`
consomment le résultat final : la fusion JSON/JS produit la même forme d'objet
qu'aujourd'hui, seule son origine (un ou deux fichiers) change.

## 4. Résolution des policies par slot (défaut si absent)

**Important, corrigé le 2026-07-17** : la seule présence d'un `.json` pairé
n'active *pas* l'historisation. Un hook migré uniquement pour factoriser son
texte de prompt (`systemPrompt`/`regles`/...), sans section `slots` ni
`historique`, se comporte **exactement comme avant sa migration** — aucun
message historisé n'est envoyé au LLM. C'est un choix délibéré : un refactor
structurel (sortir le texte en JSON) ne doit jamais avoir pour effet de bord de
changer le comportement d'exécution d'une vue.

L'activation de l'historisation exige donc une décision explicite : le JSON
doit définir une section `slots` (racine ou dans au moins un `modes.<mode>`).
Dans ce cas seulement, les slots non explicités dans cette section héritent des
policies par défaut ci-dessous — qui reproduisent le comportement historique de
`llmClient.js` :

| Slot | Policy par défaut | Raison |
|---|---|---|
| `systemPrompt`, `regles`, `modele`, `promptAdditions`, `formatReponse` | `once` | Instructions stables, pas de sens à les faire varier tour après tour |
| `donnees`, `plan` | `latest` | Toujours le snapshot courant, comme aujourd'hui |
| `infosParent` | `latest` (figé — aucun hook ne peut le surcharger en `historise`) | Vient de XSpro, jamais retravaillé par le LLM |
| `infosVue` | `historise` | Retravaillé par le LLM au fil des tours, la continuité a de la valeur |
| `demande` | `historise` | Comprendre l'enchaînement des demandes utilisateur d'un tour à l'autre |
| `reponse` | `nonHistorise` | Comportement historique : consommée pour mettre à jour les rows, puis jetée — sauf convention §7bis ci-dessous |

Un mode qui ne surcharge pas `slots` hérite de ces valeurs (ou de celles
définies à la racine du JSON, si le hook les a explicitées — comme
`formulaireListeQuestions.json` le fait pour `reponse: nonHistorise` à la
racine, surchargé en `historise` par `analyse` et `creation`).

## 5. `resume` — réservé, non actif

Sous-clé optionnelle disponible uniquement sur un slot en `historise`, à
n'importe quel niveau (racine ou dans un `modes.<mode>.slots.<slot>`) :

```json
"resume": { "actif": false, "prompt": null, "declencheur": null }
```

Tant que `actif` vaut `false` (ou que la sous-clé est absente), aucun
comportement n'est déclenché — `llmClient.js` ignore ce champ. Prévu pour une
future implémentation d'un résumé du contenu historisé au-delà d'un certain
seuil (via un appel LLM dédié demandant un résumé dans un format donné), sans
avoir à retoucher le schéma JSON le jour où on l'active.

## 6. Troncature de l'historique et avertissement

`historique.limite` (`{ type: 'tours' | 'caracteres', valeur: <n> }`) est
**global au hook**, pas surchargeable par mode (décision du 2026-07-16). Quand
la limite est dépassée, les tours historisés les plus anciens sont retirés en
priorité (parmi les slots en `historise`), et `run()` renvoie désormais un
`meta.warnings` (2e argument de `onDone`, voir `llmClient.js`) contenant :

```json
{ "type": "troncature_historique", "limiteAppliquee": 6, "toursSupprimes": 2 }
```

C'est un **nouveau paramètre**, ajouté en fin de signature — tout code
appelant existant qui ignore ce 2e argument continue de fonctionner sans
modification. Reste à faire côté UI : consommer `meta.warnings` pour afficher
un avertissement visible (hors périmètre de ce document).

## 7. Migrer un hook existant

1. Créer le `.json` pairé en extrayant `systemPrompt`/`regles`/`promptsSuggeres`/
   `formatReponse` du `MANIFEST` et des `MODES` du `.js`, mot pour mot (pas de
   reformulation à l'occasion de la migration — un changement de comportement du
   LLM doit être une décision séparée, explicite, pas un effet de bord d'un
   refactor structurel).
2. Dans le `.js`, remplacer les valeurs migrées par `null` — **deux variantes**,
   selon que le fichier lit ou non ces champs en interne :
   - **Cas général** (`detailsDevis`, `formulaireGetDetailsTravaux`,
     `formulaireGetDetailsFichesTechniques`, `formulaireGetDetailsAF`,
     `formulaireGetDetailsFacturationClient`) : rien dans le `.js` ne lit
     `MANIFEST.regles`/`systemPrompt`/etc. en dehors de la fusion externe faite
     par `viewResolver.js` → simple `null`, pas de `require()`.
   - **Cas particulier** (`formulaireListeQuestions`) : des fonctions du `.js`
     (`validateCellEdit`, `getInvalidFields`, `computeChampsRestreints`...) lisent
     `MANIFEST.regles` **directement**, sans passer par la fusion de
     `viewResolver.js`. Mettre `null` casserait ces fonctions. Dans ce cas :
     `const promptConfig = require('./<nomDuHook>.json');` en tête de fichier,
     puis `MANIFEST.regles: promptConfig.regles` (etc.) — une seule source de
     vérité, lue aux deux endroits qui en ont besoin. Vérifier au préalable avec
     `grep -n "MANIFEST\.\(regles\|systemPrompt\|formatReponse\)" <fichier>.js`
     (en excluant la déclaration elle-même) pour savoir quel cas s'applique.
3. Ajouter `historique` et `slots` — voir §7bis, c'est désormais la convention
   par défaut plutôt qu'une case à cocher au cas par cas.
4. Ne rien migrer qu'on n'a pas de raison de vouloir ajuster prochainement — un
   hook peut très bien rester 100% `.js` indéfiniment (§3, point 3).
5. **Toujours valider avant de livrer** : `node -c <fichier>.js` (syntaxe),
   `JSON.parse` sur le `.json`, puis un test end-to-end via
   `viewResolver.resolveEffectiveWorkerConfig` (systemPrompt/regles fusionnés,
   modes hérités correctement) et `resolveSlotPolicies` de `llmClient.js`
   (policies attendues, `historique.limite` correct). Voir les migrations
   précédentes pour le pattern de test (stubs `providers.js`/`fileTypes.js`/
   `fileHandlers.js` si le require de `llmClient.js` les réclame).

## 7bis. Convention par défaut : historisation activée (2026-07-17)

Décision actée le 2026-07-17 : **par défaut, tout hook migré active
l'historisation** — `slots.reponse: historise` à la racine du JSON (donc
commun à tous les modes, sauf besoin explicite de différencier), avec
`historique.limite = { type: 'tours', valeur: 15 }`. Le nombre de tours est
ajustable au cas par cas ensuite, à la hausse ou à la baisse, sans reconsidérer
le principe d'activation lui-même.

`formulaireListeQuestions` reste une exception assumée à 6 tours (valeur fixée
avant cette convention, conservée telle quelle pour l'instant — questions/cours
produisent des tours plus volumineux que des lignes de devis/tâches/articles,
ce qui justifierait une limite plus basse, mais ce n'est pas tranché
définitivement).

## Annexe — État des hooks migrés

| Hook | `require()` JSON ? | `slots.reponse` | Limite historique |
|---|---|---|---|
| `formulaireListeQuestions` | Oui | `historise` (asymétrie : `resume` prévu en `analyse`, absent en `creation`) | 6 tours |
| `detailsDevis` | Non | `historise` (racine, uniforme) | 15 tours |
| `formulaireGetDetailsTravaux` | Non | `historise` (racine, uniforme) | 15 tours |
| `formulaireGetDetailsFichesTechniques` | Non | `historise` (racine, uniforme) | 15 tours |
| `formulaireGetDetailsAF` | Non | `historise` (racine, uniforme) | 15 tours |
| `formulaireGetDetailsFacturationClient` | Non | `historise` (racine, uniforme) | 15 tours |

## 8. Encart `VOCABULAIRE UTILISATEUR` (synonymes → code)

L'utilisateur emploie souvent, dans sa demande, du vocabulaire courant au lieu des codes
exacts attendus dans les données (ex. « texte long » pour `type="ouverte"`, « question
courte » pour `type="courte"`). Plutôt que de dupliquer les règles (déjà sérialisées dans
`regles` sous `== RÈGLES DE CONSTRUCTION D'UNE LIGNE ==`), on ajoute en **fin de
`systemPrompt`** un court encart déclaratif qui **prévient** l'IA de cette correspondance
et pointe vers les règles existantes pour tout le reste (pas de doublon).

Emplacement : dans le JSON pairé, à la fin du `systemPrompt` de **chaque mode** concerné
(`modes.<modeId>.systemPrompt`) — pas à la racine, car les `systemPrompt` par mode
écrasent celui de la racine lors de la fusion (`mergePromptFields` de `viewResolver.js`).

Convention : l'encart commence par la ligne `VOCABULAIRE UTILISATEUR :`, se limite
essentiellement à la correspondance des types / noms de champs / objets métier (les cas les
plus sujets à confusion), reste court, et se termine par un renvoi explicite aux règles
existantes pour ne pas créer de doublon. Aucune modification de code n'est requise.

L'encart est **personnalisé, propre à chaque vue** (jamais un mécanisme générique) : il est
dupliqué dans le `systemPrompt` de chaque mode effectif. Vues couvertes :

| Vue | Modes avec encart | Correspondances principales |
|---|---|---|
| `formulaireListeQuestions` | `analyse`, `creation` | `type` : texte long/réponse courte/QCM ↔ `ouverte`/`courte`/`qcm` ; piège « Atelier » |
| `detailsDevis` | root, `decomposition`, `chiffrage` | `niveauListe` : titre/chapitre/sous-chapitre/ligne ↔ `' '`/`▶ ◇ ○`/`○ ◆ ○`/`○ ○ ●` ; `sousTraitance` ✓ ; `tauxHoraire` |
| `formulaireGetDetailsTravaux` | root, `creation` | objet « tâche/poste/ouvrage » ; champs `repere`/`intitule`/`quantite` |
| `formulaireGetDetailsFichesTechniques` | root, `creation` | objet « liaison/raccordement » ; `tenant`/`aboutissant` ; champs `repere`/`longueurLiaison` |
| `formulaireGetDetailsAF` | root, `creation` | objet « article/ligne/produit » ; champs `reference`/`designation`/`quantite`/`montant`/`codeTVA` |
| `formulaireGetDetailsFacturationClient` | root, `creation` | objet « prestation/ligne/ouvrage » ; champs `reference`/`designation`/`quantite`/`montant`/`codeTVA` |
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

Si un hook (migré ou non) ne définit pas de `slots` du tout, ou omet un slot
précis, la policy par défaut appliquée est celle qui correspond au comportement
**actuel** de `llmClient.js` — donc migrer un hook vers un `.json` sans y toucher
ne change rien à ce qu'il envoie au LLM :

| Slot | Policy par défaut | Raison |
|---|---|---|
| `systemPrompt`, `regles`, `modele`, `promptAdditions`, `formatReponse` | `once` | Instructions stables, pas de sens à les faire varier tour après tour |
| `donnees`, `plan` | `latest` | Toujours le snapshot courant, comme aujourd'hui |
| `infosParent` | `latest` (figé — aucun hook ne peut le surcharger en `historise`) | Vient de XSpro, jamais retravaillé par le LLM |
| `infosVue` | `historise` | Retravaillé par le LLM au fil des tours, la continuité a de la valeur |
| `demande` | `historise` | Comprendre l'enchaînement des demandes utilisateur d'un tour à l'autre |
| `reponse` | `nonHistorise` | Comportement actuel : consommée pour mettre à jour les rows, puis jetée |

Un mode qui ne surcharge pas `slots` hérite donc de ces valeurs (ou de celles
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
2. Ajouter `historique` et `slots` en reprenant les policies par défaut de la
   section 4 (comportement identique à avant), puis ajuster uniquement si un
   besoin précis a été identifié pour cette vue.
3. Remplacer dans le `.js` les valeurs migrées par `null` (elles héritent du
   JSON), en laissant tout le reste du `.js` inchangé.
4. Ne rien migrer qu'on n'a pas de raison de vouloir ajuster prochainement — un
   hook peut très bien rester 100% `.js` indéfiniment (cf. §3, point 3).

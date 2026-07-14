/**
 * AI Worker — views/formulaireGetDetailsTravaux.js
 * Hook spécifique à la vue "formulaireGetDetailsTravaux" (fiche de travaux / liste de tâches).
 *
 * ── MANIFEST DE SURCHARGE ──────────────────────────────────────────────
 * Remplis les champs ci-dessous pour redéfinir ce que XSpro envoie dans
 * workerConfig. Laisser à `null` = garder la valeur fournie par XSpro.
 *
 *   colonnes         : array | function(workerConfig, data) => array | null
 *   regles           : object | null
 *   systemPrompt     : string | null
 *   promptsSuggeres  : object | null
 *   prompt           : string | null
 *   modele           : array | null
 *   export           : object | null
 *
 * Vue structurellement quasi identique à formulaireGetDetailsFichesTechniques :
 *   - pas de hiérarchie (pas de niveauListe)
 *   - pas de colonne à indice/select choix côté XSpro (clesChampsSelectChoixDevantResterBrut
 *     vide) MAIS on définit nous-mêmes un SELECT_CHOIX pour fait/validation/nonValide
 *     (autrefois dropdown ✓/✘ comme sousTraitance dans detailsDevis). Ces colonnes
 *     sont désormais MASQUÉES à la fois dans l'UI (colonnesUiHidden) et pour le LLM
 *     (colonnesLlmHidden / surcharges { hide: true }) — réservées à la saisie manuelle.
 *   - MODES multi-uniformes (standard / creation / analyse) comme detailsDevis.
 *
 * Voir detailsDevis.js pour la doc complète du lexique des opérateurs
 * (empty/eq/neq/gt/lt/gte/lte) et de la syntaxe des règles déclaratives.
 */

'use strict';

// ── MANIFEST ──────────────────────────────────────────────────────────────────
const MANIFEST = {

   /**
    * Active le contrat d'édition par actions (update/delete/insert via _id) au lieu
    * du contrat historique positionnel. cf. detailsDevis.js et formulaireListeQuestions.js
    * pour le même mécanisme ; llmClient.js (applyRowActions), sessionManager.js (_id).
    */
   editionParActions: true,

   /**
    * Surcharges déclaratives par colonne (pinned, width, hide, readOnly…).
    * repere est l'identifiant métier de la ligne → épinglé à gauche.
    *
    * fait / validation / nonValide : suivi manuel (✔/✘) au cœur du workflow de
    * chantier → MASQUÉS à la fois dans l'UI (colonnesUiHidden) et pour le LLM
    * (colonnesLlmHidden / surcharges { hide: true }) — champs réservés à la
    * saisie manuelle sur le terrain, jamais visibles ni modifiables par l'IA.
    * Le rendu dropdown (SELECT_CHOIX) reste défini plus bas au cas où la vue
    * serait ré-affichée, mais les colonnes sont invisibles par défaut.
    */
   surchargesColonnes: {
     repere:      { width: 100 },
     intitule:    { width: 280 },
     quantite:    { width: 100 },
     commentaire: { width: 220 },
     fait:        { hide: true, placeholder: true, width: 60, minWidth: 60 },
     validation:  { hide: true, placeholder: true, width: 60, minWidth: 60 },
     nonValide:   { hide: true, placeholder: true, width: 60, minWidth: 60 },
   },

   /**
    * Colonnes éditées en multiligne (textarea, Entrée = saut de ligne).
    * Propagé à grid.js via effectiveWorkerConfig pour brancher TextareaCellEditor.
    * Même mécanisme que dans detailsDevis.js, formulaireListeQuestions.js et formulaireGetDetailsFichesTechniques.js.
    */
   champsMultiligne: ['repere', 'intitule', 'commentaire'],

  systemPrompt: `Tu es un assistant spécialisé dans le suivi et la complétion fidèle de fiches de travaux (listes de tâches de chantier).
  Les tâches sont ici généralement déjà définies, au moins dans les grandes lignes (repere, intitule, quantite en partie renseignés) :
  ton rôle est de vérifier, corriger et compléter les champs manquants ou incohérents, SANS reformuler ni restructurer ce qui existe déjà.
  Ne modifie une valeur déjà renseignée que si elle est manifestement erronée ou si la correction est explicitement demandée.
  Les champs fait/validation/nonValide sont réservés à la saisie manuelle sur le terrain et ne t'apparaissent pas — ne cherche jamais à les lire ni à les renseigner.

  Les tâches déjà présentes dans "DONNÉES ACTUELLES" font partie intégrante de la fiche finale, comme
  une liste déjà rédigée que tu complètes. En l'absence d'instruction explicite : conserve-les telles
  quelles, complète uniquement ce qui manque. Tu ne modifies ou supprimes une tâche existante que si
  c'est explicitement demandé ou si elle est manifestement erronée (ex: repere en doublon).`,

  promptsSuggeres: {
    creation: [
      'Complète les tâches manquantes à partir des données déjà présentes dans cette fiche',
      'Vérifie et corrige les repères en doublon sans modifier les autres tâches',
      'Complète les quantités manquantes pour les tâches déjà définies',
    ],
    analyse: [
      'Fais la synthèse de l\'état d\'avancement de cette fiche de travaux',
      'Liste les tâches non réalisées ou non validées',
      'Combien de tâches restent à faire ?',
    ],
  },
  prompt: null,
  modele:          null,
  export:          null,

  // Contrat d'actions (editionParActions actif) — partagé par tous les modes qui ne
  // définissent pas leur propre formatReponse (résolu par viewResolver.js).
  formatReponse: `
== FORMAT DE RÉPONSE ==
Réponds UNIQUEMENT avec un tableau JSON valide d'actions. Chaque élément est l'une de :
  { "_action": "update", "_id": <id>, <champs modifiés uniquement> }
  { "_action": "delete", "_id": <id> }
  { "_action": "insert", "_apres": <id> | null | "fin", <tous les champs de la nouvelle ligne> }
- "_id" référence la colonne _id du CSV "DONNÉES ACTUELLES" — jamais un numéro de ligne.
- "update" : n'inclue que les champs que tu modifies réellement, pas la ligne entière.
- "insert" : "_apres" = _id de la tâche après laquelle insérer ; null = en tête ; "fin" = en dernier.
- Ne renvoie AUCUNE action pour une tâche existante que tu ne modifies pas.
- Retourner UNIQUEMENT les clés de colonnes listées ci-dessus (+ "_action"/"_id"/"_apres").
- Si une valeur est inconnue, utiliser "" (chaîne vide).
- Pas de texte avant ni après. Pas de balises markdown.
`,

  // Règles métier — structure libre, sérialisée en JSON dans le prompt
  regles: {
    champsObligatoires: ['repere'],
    identifiants: {
      champ: 'repere',
      description: 'référence unique de la tâche — ne jamais dupliquer un repere déjà présent dans les données ou le modèle',
    },
    interdictions: [
      'Ne jamais renseigner fait, validation ou nonValide — champs réservés à la saisie manuelle sur le terrain',
      'Ne pas dupliquer un repere déjà existant',
      'Ne pas inventer de quantite précise si elle n\'est pas déductible du contexte — laisser vide plutôt que d\'inventer un chiffre arbitraire',
    ],
    texteLibre: `
    - intitule doit être une désignation claire et actionnable de la tâche (verbe d'action + objet, ex. "Pose luminaires", "Raccordement armoire divisionnaire").
    - quantite est un nombre positif représentant la quantité prévue (unités, mètres, forfait…) — vide si non pertinent pour la tâche, jamais négative.
    - commentaire reste du texte libre, à ne renseigner que si une précision utile existe.
    - Une tâche = une action homogène ; si une demande couvre plusieurs corps de métier ou étapes distinctes, crée une ligne par tâche plutôt qu'une ligne fourre-tout.
    `,
  },

  /**
   * Règles déclaratives pour postProcessDefaults et postProcessMerge.
   * Voir detailsDevis.js pour la syntaxe complète (si/et/set, abs, conditionnel).
   */
  reglesPostProcess: {
    defaults: [],
    merge: [
      // Quantité négative → valeur absolue
      { si: { champ: 'quantite', op: 'lt', valeur: 0 }, set: { quantite: { abs: true } } },
    ],
  },
};

// ── MODES ─────────────────────────────────────────────────────────────────────
/**
 * Lentilles de travail optionnelles, structurées de façon uniforme
 * (toutes les clés listées, null = pas de surcharge) comme detailsDevis.
 *
 * colonnesUiHidden  : colonnes masquées dans l'UI (AG Grid) pour ce mode
 * colonnesLlmHidden : colonnes exclues du prompt LLM pour ce mode
 *                     (transparentes pour le LLM — il ne sait pas qu'elles existent)
 *
 * Les colonnes fait/validation/nonValide sont MASQUÉES dans tous les modes,
 * à la fois dans l'UI (colonnesUiHidden) et pour le LLM (colonnesLlmHidden +
 * surcharge { hide: true }) — champs réservés à la saisie manuelle sur le
 * terrain, jamais visibles ni renseignés par l'IA.
 */
const MODES = {
  standard: {
    label: 'Standard',
    surchargesColonnes: {
      repere:      null,
      intitule:    null,
      quantite:    null,
      commentaire: null,
      // Suivi manuel masqué pour l'UI et pour le LLM (jamais visible, jamais renseigné par l'IA)
      fait:        null,
      validation:  null,
      nonValide:   null,
    },
    colonnesUiHidden:  [],
    colonnesLlmHidden: ['fait', 'validation', 'nonValide'],
    systemPrompt: null,
    regles: null,
    promptsSuggeres: null,
    modele: null,
  },

  creation: {
    label: 'Création',
    surchargesColonnes: {
      repere:      null,
      intitule:    null,
      quantite:    null,
      commentaire: null,
      // Suivi manuel masqué pour le LLM (jamais renseigné par l'IA)
      fait:        { hide: true, placeholder: true, width: 60, minWidth: 60 },
      validation:  { hide: true, placeholder: true, width: 60, minWidth: 60 },
      nonValide:   { hide: true, placeholder: true, width: 60, minWidth: 60 },
    },
    colonnesUiHidden:  ['fait', 'validation', 'nonValide'],
    colonnesLlmHidden: ['fait', 'validation', 'nonValide'],
    systemPrompt: `Tu es un assistant spécialisé dans la création de fiches de travaux à partir de documents (CCTP, descriptif de chantier, plan de récolement...).
    Contrairement au mode standard, les tâches ne sont pas censées être déjà définies : à toi de les déduire des documents fournis
    et de les structurer en une liste complète et actionnable (repere, intitule, quantite, commentaire).
    N'hésite pas à décomposer une intervention complexe en plusieurs tâches distinctes par corps de métier ou par étape.
    Ne renseigne JAMAIS fait, validation ou nonValide — ces champs sont réservés à la saisie manuelle sur le terrain.
    Si une quantité n'est pas déductible du contexte, laisse-la vide plutôt que d'inventer un chiffre arbitraire.

    Si des tâches figurent déjà dans "DONNÉES ACTUELLES", conserve-les telles quelles par défaut et
    insère les nouvelles tâches déduites du document (action "insert", "_apres" au bon endroit) — ne les
    modifie ou remplace que si elles sont explicitement incohérentes (ex: repere en doublon) ou si la
    demande le précise.`,
    regles: null,
    promptsSuggeres: {
      creation: [
        'Décompose ce descriptif de chantier en liste de tâches',
        'Génère une fiche de travaux complète à partir de ce document',
        'Crée un repère unique pour chaque tâche sans doublon',
      ],
    },
    modele: null,
  },
};

// ── SELECT CHOIX ──────────────────────────────────────────────────────────────
/**
 * Colonnes à valeur indicée avec libellé lisible.
 *
 * On définit ici un SELECT_CHOIX pour fait/validation/nonValide. Ces colonnes
 * sont désormais MASQUÉES (UI + LLM) via colonnesUiHidden / colonnesLlmHidden,
 * mais le SELECT_CHOIX reste défini au cas où la vue serait ré-affichée :
 *   - dropdown (✓ / vide pour fait&validation, ✘ / vide pour nonValide)
 *   - le LLM verrait le libellé (sendLabel: true) s'il n'était pas masqué
 *   - le retour est normalisé en valeur BDD (indice entier)
 *
 * Peut être un objet statique ou une fonction (workerConfig, data, xsproPayload) => objet.
 */
function buildSelectChoix(workerConfig, data, xsproPayload) {
  return {
    fait: {
      sendLabel: true,
      choix: [
        { valeur: 0, label: ' '  },
        { valeur: 1, label: '✓' },
      ],
      fallback: {
        siCondition: { champ: 'fait', op: 'empty' },
        alors:  0,
        sinon:  1,
      },
    },
    validation: {
      sendLabel: true,
      choix: [
        { valeur: 0, label: ' '  },
        { valeur: 1, label: '✓' },
      ],
      fallback: {
        siCondition: { champ: 'validation', op: 'empty' },
        alors:  0,
        sinon:  1,
      },
    },
    nonValide: {
      sendLabel: true,
      choix: [
        { valeur: 0, label: ' '  },
        { valeur: 1, label: '✘' },
      ],
      fallback: {
        siCondition: { champ: 'nonValide', op: 'empty' },
        alors:  0,
        sinon:  1,
      },
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── INTERPRÉTEUR DE RÈGLES DÉCLARATIVES ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
//
// Identique à detailsDevis.js / formulaireGetDetailsFichesTechniques.js —
// NE PAS MODIFIER À LA MAIN. Change plutôt le bloc MANIFEST.reglesPostProcess.

function evalCondition(row, cond) {
  if (!cond) return true;
  const { champ, op, valeur } = cond;
  const val = row[champ];
  const isEmpty = val === '' || val === ' ' || val === null || val === undefined || Number(val) === 0;

  switch (op) {
    case 'empty': return isEmpty;
    case 'eq':    return String(val) === String(valeur);
    case 'neq':   return String(val) !== String(valeur);
    case 'gt':    return Number(val) > Number(valeur);
    case 'lt':    return Number(val) < Number(valeur);
    case 'gte':   return Number(val) >= Number(valeur);
    case 'lte':   return Number(val) <= Number(valeur);
    default:      return false;
  }
}

function applyRegle(row, regle) {
  if (!evalCondition(row, regle.si)) return false;
  if (regle.et && !evalCondition(row, regle.et)) return false;

  for (const [champ, valeur] of Object.entries(regle.set)) {
    if (typeof valeur === 'object' && valeur !== null) {
      if (valeur.abs === true) {
        const n = Number(row[champ]);
        row[champ] = isNaN(n) ? '' : Math.abs(n);
      } else if (valeur.si) {
        row[champ] = evalCondition(row, valeur.si) ? valeur.alors : valeur.sinon;
      } else {
        row[champ] = valeur;
      }
    } else {
      row[champ] = valeur;
    }
  }
  return true;
}

function applyRegles(regles, rows) {
  if (!regles || !regles.length) return rows;
  return rows.map(row => {
    const r = { ...row };
    for (const regle of regles) applyRegle(r, regle);
    return r;
  });
}

// ── Construction automatique des hooks depuis reglesPostProcess ────────────
const rpp = MANIFEST.reglesPostProcess || {};

function postProcessDefaults(rows, colonnes, regles) {
  return applyRegles(rpp.defaults, rows);
}

function postProcessMerge(mergedRows, originalRows, colonnes) {
  return applyRegles(rpp.merge, mergedRows);
}

// ── Exports ───────────────────────────────────────────────────────────────────
// SELECT_CHOIX défini ici pour donner à fait/validation/nonValide le même
// rendu dropdown que sousTraitance (detailsDevis).
module.exports = {
  MANIFEST,
  MODES,
  SELECT_CHOIX: buildSelectChoix,
  postProcessDefaults,
  postProcessMerge,
};
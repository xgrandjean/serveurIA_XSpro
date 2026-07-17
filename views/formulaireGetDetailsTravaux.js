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

  // Portés par le JSON pairé (cf. README-prompts.md).
  systemPrompt: null,

  promptsSuggeres: null,
  prompt: null,
  modele:          null,
  export:          null,

  // Portée par le JSON pairé (cf. README-prompts.md).
  formatReponse: null,

  // Portées par le JSON pairé (cf. README-prompts.md).
  regles: null,

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
    description: 'Vue standard de la fiche de travaux',
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
    description: 'Créer une fiche de travaux à partir de documents (CCTP, descriptif…)',
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
    systemPrompt: null,  // hérite du JSON pairé (modes.creation)
    regles: null,
    promptsSuggeres: null,  // hérite du JSON pairé (modes.creation)
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
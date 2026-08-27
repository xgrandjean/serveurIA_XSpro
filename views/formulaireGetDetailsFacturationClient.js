/**
 * AI Worker — views/formulaireGetDetailsFacturationClient.js
 * Hook spécifique à la vue "formulaireGetDetailsFacturationClient" (facturation client / affaire).
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
 * Vue structurellement quasi identique à formulaireGetDetailsAF, à la différence
 * qu'il n'y a pas de statut "livre" (une prestation facturée n'est pas "livrée") :
 *   - pas de hiérarchie (pas de niveauListe)
 *   - pas de colonne à indice/select choix côté XSpro (clesChampsSelectChoixDevantResterBrut
 *     vide) MAIS on définit nous-mêmes un SELECT_CHOIX pour facture/regle/annule
 *     (statuts comptables ✓/✘, même principe que dans formulaireGetDetailsAF).
 *     Ces colonnes sont MASQUÉES pour le LLM (colonnesLlmHidden / surcharges
 *     { hide: true } en mode creation) — réservées à la saisie manuelle côté
 *     suivi comptable.
 *   - MODES multi-uniformes (standard / creation) comme formulaireGetDetailsAF.
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
    * Mode revue par pending (masque le sélecteur Plan/Act au profit d'un mode unique
    * direct) : chaque proposition IA (update/insert/delete) — ou modification manuelle,
    * même traitement — devient un item "en attente" (surlignage + ✓/✗), validable
    * individuellement (par champ), ligne par ligne, ou globalement, au lieu d'écraser
    * directement les données. Généralisation du mécanisme mis en place pour
    * formulaireListeQuestions.js puis detailsDevis.js (cf. viewResolver.js
    * session.reviewMode, llmClient.js applyRowActions, sessionManager.js
    * approveField/rejectField/approveRow/rejectRow/approveRows/rejectRows/
    * proposeInsertRow/proposeDeleteRows/moveRows, public/grid.js colonne "Revue"/barre
    * de revue globale) — moteur déjà générique, ne dépend que de editionParActions
    * (_id) déjà actif ci-dessus.
    */
   revueParPending: true,

   /**
    * Surcharges déclaratives par colonne (pinned, width, hide, readOnly…).
    * reference est l'identifiant métier de la ligne → épinglé à gauche.
    *
    * facture / regle / annule : suivi manuel (✔/✘) du cycle de facturation →
    * MASQUÉS pour le LLM (colonnesLlmHidden / surcharges { hide: true } en
    * mode creation) — champs réservés à la saisie manuelle côté comptabilité,
    * jamais renseignés par l'IA.
    * Le rendu dropdown (SELECT_CHOIX) reste défini plus bas.
    */
surchargesColonnes: {
      reference:   { width: 120 },
      designation: { width: 280 },
      quantite:    { width: 90, type: 'decimal', round: 0 },
      montant:     { width: 100, type: 'decimal', round: 2 },
      commentaire: { width: 220 },
     facture:     { hide: true, placeholder: true, width: 60, minWidth: 60 },
     regle:       { hide: true, placeholder: true, width: 60, minWidth: 60 },
     annule:      { hide: true, placeholder: true, width: 60, minWidth: 60 },
     codeTVA:     { width: 70 },
   },

   /**
    * Colonnes éditées en multiligne (textarea, Entrée = saut de ligne).
    * Propagé à grid.js via effectiveWorkerConfig pour brancher TextareaCellEditor.
    * Même mécanisme que dans detailsDevis.js, formulaireListeQuestions.js et formulaireGetDetailsAF.js.
    */
   champsMultiligne: ['reference', 'designation', 'commentaire'],

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
      // Montant négatif → valeur absolue
      { si: { champ: 'montant', op: 'lt', valeur: 0 }, set: { montant: { abs: true } } },
    ],
  },
};

// ── MODES ─────────────────────────────────────────────────────────────────────
/**
 * Lentilles de travail optionnelles, structurées de façon uniforme
 * (toutes les clés listées, null = pas de surcharge) comme formulaireGetDetailsAF.
 *
 * colonnesUiHidden  : colonnes masquées dans l'UI (AG Grid) pour ce mode
 * colonnesLlmHidden : colonnes exclues du prompt LLM pour ce mode
 *                     (transparentes pour le LLM — il ne sait pas qu'elles existent)
 *
 * Les colonnes facture/regle/annule sont masquées pour le LLM dans tous les
 * modes (colonnesLlmHidden), et en plus masquées dans l'UI en mode creation
 * (surcharge { hide: true }) — champs réservés à la saisie manuelle côté
 * comptabilité, jamais renseignés par l'IA.
 */
const MODES = {
  standard: {
    label: 'Standard',
    description: 'Vue standard de la facturation client',
    // Famille générique (creation/analyse/standard) — cf. viewResolver.js resolvePromptsSuggeresForMode.
    famille: 'standard',
    surchargesColonnes: {
      reference:   null,
      designation: null,
      quantite:    null,
      montant:     null,
      commentaire: null,
      facture:     null,
      regle:       null,
      annule:      null,
      codeTVA:     null,
    },
    colonnesUiHidden:  [],
    colonnesLlmHidden: [],
    systemPrompt: null,
    regles: null,
    promptsSuggeres: null,
    modele: null,
  },

  creation: {
    label: 'Création',
    description: 'Créer des facturations client à partir de documents (devis signé, CCTP…)',
    famille: 'creation',

    // Mode ouvert par défaut à l'arrivée sur la vue (cf. resolveDefaultModeId dans
    // public/grid.js) : la création est l'usage courant de cette vue de saisie.
    parDefaut: true,
    surchargesColonnes: {
      reference:   null,
      designation: null,
      quantite:    null,
      montant:     null,
      commentaire: null,
      // Suivi manuel masqué pour le LLM (jamais renseigné par l'IA)
      facture:     { hide: true, placeholder: true, width: 60, minWidth: 60 },
      regle:       { hide: true, placeholder: true, width: 60, minWidth: 60 },
      annule:      { hide: true, placeholder: true, width: 60, minWidth: 60 },
      codeTVA:     null,
    },
    colonnesUiHidden:  ['facture', 'regle', 'annule','commentaire','codeTVA'],
    colonnesLlmHidden: ['facture', 'regle', 'annule','commentaire','codeTVA'],
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
 * On définit ici un SELECT_CHOIX pour facture/regle/annule. Ces colonnes sont
 * MASQUÉES pour le LLM via colonnesLlmHidden (et dans l'UI en mode creation),
 * mais le SELECT_CHOIX reste défini au cas où la vue serait ré-affichée :
 *   - dropdown (✓ / vide pour facture&regle, ✘ / vide pour annule)
 *   - le LLM verrait le libellé (sendLabel: true) s'il n'était pas masqué
 *   - le retour est normalisé en valeur BDD (indice entier)
 *
 * Peut être un objet statique ou une fonction (workerConfig, data, xsproPayload) => objet.
 */
function buildSelectChoix(workerConfig, data, xsproPayload) {
  return {
    facture: {
      sendLabel: true,
      choix: [
        { valeur: 0, label: ' '  },
        { valeur: 1, label: '✓' },
      ],
      fallback: {
        siCondition: { champ: 'facture', op: 'empty' },
        alors:  0,
        sinon:  1,
      },
    },
    regle: {
      sendLabel: true,
      choix: [
        { valeur: 0, label: ' '  },
        { valeur: 1, label: '✓' },
      ],
      fallback: {
        siCondition: { champ: 'regle', op: 'empty' },
        alors:  0,
        sinon:  1,
      },
    },
    annule: {
      sendLabel: true,
      choix: [
        { valeur: 0, label: ' '  },
        { valeur: 1, label: '✘' },
      ],
      fallback: {
        siCondition: { champ: 'annule', op: 'empty' },
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
// Identique à detailsDevis.js / formulaireGetDetailsAF.js —
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
// SELECT_CHOIX défini ici pour donner à facture/regle/annule le même rendu
// dropdown que livre/facture/regle/annule (formulaireGetDetailsAF).
module.exports = {
  MANIFEST,
  MODES,
  SELECT_CHOIX: buildSelectChoix,
  postProcessDefaults,
  postProcessMerge,
};
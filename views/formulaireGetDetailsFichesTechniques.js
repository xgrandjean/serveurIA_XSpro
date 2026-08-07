/**
 * AI Worker — views/formulaireGetDetailsFichesTechniques.js
 * Hook spécifique à la vue "formulaireGetDetailsFichesTechniques" (carnet de liaisons).
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
 * Contrairement à detailsDevis, cette vue n'a :
 *   - ni hiérarchie (pas de niveauListe)
 *   - ni colonne à indice/select choix côté XSpro (regles.clesChampsSelectChoixDevantResterBrut
 *     est vide) MAIS on définit nous-mêmes un SELECT_CHOIX pour fait/validation/nonValide
 *     afin de leur donner le même comportement visuel que la colonne sousTraitance
 *     de detailsDevis (dropdown ✓/✘ éditable manuellement, masqué à l'IA).
 *   - plusieurs MODES (standard / creation / analyse) structurés de façon
 *     uniforme comme detailsDevis.
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
    * repere est l'identifiant métier de la ligne → épinglé à gauche comme
    * designation dans detailsDevis.
    *
    * fait / validation / nonValide sont des champs de suivi manuel (✔/✘) :
    * au cœur du workflow de suivi de chantier → on les garde VISIBLES
    * (pas de hide), mais toujours readOnly+placeholder pour que l'IA n'y
    * touche jamais. Le rendu dropdown (SELECT_CHOIX) est défini plus bas
    * pour un comportement visuel identique à sousTraitance (detailsDevis).
    */
   surchargesColonnes: {
     repere:                 { width: 100 },
     typeLiaison:            { width: 150 },
     longueurLiaison:        { width: 90 },
     tenant:                 { width: 220 },
     repereTenant:           { width: 110 },
     typeConnectTenant:      { width: 110 },
     aboutissant:            { width: 220 },
     repereAboutissant:      { width: 110 },
     typeConnectAboutissant: { width: 110 },
     commentaire:            { width: 200 },
     fait:                   { hide: true, placeholder: true, width: 60, minWidth: 60 },
     validation:             { hide: true, placeholder: true, width: 60, minWidth: 60 },
     nonValide:              { hide: true, placeholder: true, width: 60, minWidth: 60 },
   },

   /**
    * Colonnes éditées en multiligne (textarea, Entrée = saut de ligne).
    * Propagé à grid.js via effectiveWorkerConfig pour brancher TextareaCellEditor.
    * Même mécanisme que dans detailsDevis.js et formulaireListeQuestions.js.
    */
   champsMultiligne: ['repere', 'typeLiaison', 'tenant', 'repereTenant', 'typeConnectTenant', 'aboutissant', 'repereAboutissant', 'typeConnectAboutissant', 'commentaire'],

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
      // Longueur négative → valeur absolue
      { si: { champ: 'longueurLiaison', op: 'lt', valeur: 0 }, set: { longueurLiaison: { abs: true } } },
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
 * Les colonnes fait/validation/nonValide restent TOUJOURS visibles et
 * éditables manuellement (readOnly+placeholder dans le MANIFEST) ; en mode
 * creation/analyse elles sont simplement retirées du contexte LLM.
 */
const MODES = {
  standard: {
    label: 'Standard',
    description: 'Vue standard du carnet de liaisons',
    surchargesColonnes: {
      repere:                 null,
      typeLiaison:            null,
      longueurLiaison:        null,
      tenant:                 null,
      repereTenant:           null,
      typeConnectTenant:      null,
      aboutissant:            null,
      repereAboutissant:      null,
      typeConnectAboutissant: null,
      commentaire:            null,
      fait:                   null,  // déjà readOnly+placeholder dans le MANIFEST
      validation:             null,
      nonValide:              null,
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
    description: 'Créer un carnet de liaisons à partir de plans, schémas ou CCTP',
    surchargesColonnes: {
      repere:                 null,
      typeLiaison:            null,
      longueurLiaison:        null,
      tenant:                 null,
      repereTenant:           null,
      typeConnectTenant:      null,
      aboutissant:            null,
      repereAboutissant:      null,
      typeConnectAboutissant: null,
      commentaire:            null,
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
 * On définit ici un SELECT_CHOIX pour fait/validation/nonValide afin de leur
 * donner EXACTEMENT le même comportement visuel que la colonne sousTraitance
 * de detailsDevis :
 *   - l'UI affiche un dropdown (✓ / vide pour fait&validation, ✘ / vide pour nonValide)
 *   - le LLM voit le libellé (sendLabel: true)
 *   - le retour est normalisé en valeur BDD (indice entier)
 *   - les colonnes restent readOnly+placeholder (l'IA n'y écrit jamais)
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
// Identique à detailsDevis.js — NE PAS MODIFIER À LA MAIN.
// Change plutôt le bloc MANIFEST.reglesPostProcess ci-dessus.

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
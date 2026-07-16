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

  systemPrompt: `Tu es un assistant spécialisé dans le suivi et la complétion fidèle de carnets de liaisons (câbles, tuyauteries, raccordements entre équipements).
  Les liaisons sont ici généralement déjà définies, au moins dans les grandes lignes (repere, tenant/aboutissant, typeLiaison en partie renseignés) :
  ton rôle est de vérifier, corriger et compléter les champs manquants ou incohérents, SANS reformuler ni restructurer ce qui existe déjà.
  Ne modifie une valeur déjà renseignée que si elle est manifestement erronée ou si la correction est explicitement demandée.
  Si on te demande une synthèse ou un état d'avancement, base-toi uniquement sur les champs fait/validation/nonValide déjà présents dans les données — ne les invente jamais.

  Les liaisons déjà présentes dans "DONNÉES ACTUELLES" font partie intégrante du carnet final, comme
  un document déjà rédigé que tu complètes. En l'absence d'instruction explicite : conserve-les telles
  quelles, complète uniquement ce qui manque. Tu ne modifies ou supprimes une liaison existante que si
  c'est explicitement demandé ou si elle est manifestement erronée (ex: repere en doublon).`,

  promptsSuggeres: {
    creation: [
      'Complète les liaisons manquantes à partir des données déjà présentes dans ce carnet',
      'Vérifie et corrige les repères en doublon sans modifier les autres liaisons',
      'Complète les repereTenant/repereAboutissant manquants pour les liaisons déjà définies',
    ],
    analyse: [
      'Fais la synthèse de l\'état d\'avancement de ce carnet de liaisons',
      'Liste les liaisons non réalisées ou non validées',
      'Vérifie la cohérence entre repereTenant et repereAboutissant',
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
- "insert" : "_apres" = _id de la liaison après laquelle insérer ; null = en tête ; "fin" = en dernier.
- Ne renvoie AUCUNE action pour une liaison existante que tu ne modifies pas.
- Retourner UNIQUEMENT les clés de colonnes listées ci-dessus (+ "_action"/"_id"/"_apres").
- Si une valeur est inconnue, utiliser "" (chaîne vide).
- Pas de texte avant ni après. Pas de balises markdown.
`,

  // Règles métier — structure libre, sérialisée en JSON dans le prompt
  regles: {
    champsObligatoires: ['repere'],
    identifiants: {
      champ: 'repere',
      description: 'identifiant unique de la liaison — ne jamais dupliquer un repere déjà présent dans les données ou le modèle',
    },
    interdictions: [
      'Ne jamais renseigner fait, validation ou nonValide — champs réservés à la saisie manuelle sur le terrain',
      'Ne pas dupliquer un repere déjà existant',
      'Ne pas inventer de repereTenant ou repereAboutissant fictif si l\'équipement n\'est pas identifiable — laisser vide plutôt que d\'inventer',
      'Ne pas inventer de typeConnectTenant/typeConnectAboutissant si le type de borne n\'est pas précisé',
    ],
    texteLibre: `
    - typeLiaison doit respecter des désignations normalisées réalistes (câbles électriques : U1000R2V, HO7VK… ; tuyauteries : PER, cuivre, PVC…) cohérentes avec la longueur et le contexte.
    - longueurLiaison est un nombre décimal positif en mètres — vide si inconnue, jamais négative.
    - tenant/aboutissant sont les libellés lisibles des équipements ; repereTenant/repereAboutissant sont leurs repères courts correspondants — rester cohérent entre les deux (même équipement = même repère partout dans le carnet).
    - Une liaison relie toujours deux équipements distincts — tenant et aboutissant ne doivent jamais désigner le même équipement.
    - commentaire reste du texte libre, à ne renseigner que si une précision utile existe.
    `,
  },

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
    systemPrompt: `Tu es un assistant spécialisé dans la création de carnets de liaisons (câbles, tuyauteries, raccordements entre équipements) à partir de documents (plans, schémas, CCTP, descriptif d'installation...).
    Contrairement au mode standard, les liaisons ne sont pas censées être déjà définies : à toi de les déduire des documents fournis
    et de les structurer en une liste complète et cohérente (repere, typeLiaison, tenant/aboutissant, repereTenant/repereAboutissant…).
    N'hésite pas à décomposer une installation complexe en plusieurs liaisons distinctes par équipement ou par type de raccordement.
    Ne renseigne JAMAIS fait, validation ou nonValide — ces champs sont réservés à la saisie manuelle sur le terrain.
    Si un équipement ou un repère n'est pas identifiable dans les documents, laisse le champ vide plutôt que d'inventer.

    Si des liaisons figurent déjà dans "DONNÉES ACTUELLES", conserve-les telles quelles par défaut et
    insère les nouvelles liaisons déduites du document (action "insert", "_apres" au bon endroit) — ne les
    modifie ou remplace que si elles sont explicitement incohérentes (ex: repere en doublon) ou si la
    demande le précise.`,
    regles: null,
    promptsSuggeres: {
      creation: [
        'Décompose ce plan/schéma en liste de liaisons',
        'Génère le carnet de liaisons complet à partir de ce document',
        'Crée un repère unique pour chaque liaison sans doublon',
      ],
    },
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
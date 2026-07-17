/**
 * AI Worker — views/listeQuestions.js  (contextName : "formulaireListeQuestions")
 * Hook spécifique à la vue "formulaireListeQuestions".
 *
 * ── MANIFEST DE SURCHARGE ──────────────────────────────────────────────────────
 * null sur un champ = garder la valeur fournie par XSpro dans workerConfig.
 *
 * ── CONTRAT D'ÉDITION : PAR ACTIONS (editionParActions: true) ─────────────────
 * Cette vue n'utilise PAS le contrat historique positionnel (tableau plat complet).
 * Le LLM reçoit une colonne _id en tête du CSV "DONNÉES ACTUELLES" et répond avec
 * un tableau JSON d'actions, résolues par applyRowActions() dans llmClient.js :
 *
 *   { "_action": "update", "_id": <id>, <champs modifiés uniquement> }
 *   { "_action": "delete", "_id": <id> }
 *   { "_action": "insert", "_apres": <id> | null | "fin", <tous les champs> }
 *
 * Toute ligne existante non référencée par une action reste inchangée (conservée
 * par défaut). _id est un identifiant interne à la session (sessionManager.js),
 * jamais transmis à XSpro (retiré par snapshotRows avant tout envoi externe).
 *
 * ── CONTRAT DE SORTIE PAR LIGNE (rows → XSpro, une fois les actions résolues) ─
 * Chaque ligne finale (update/insert résolus) a ces clés :
 *
 *   type              string    "qcm" | "courte" | "ouverte" | "selection" | "cours"
 *   contenu           string    Sauts de ligne → <br>
 *   regle             string    "unique" | "multiple" | "texte" | "texte(10)" | "nombre" | ""
 *   correction        string    "auto" | "manuel" | "semi" | ""
 *   points            string    "1" | "2" | "3" | "" (vide pour cours)
 *   choix             array     ["A","B","C","D"] — vide [] pour courte/ouverte/cours
 *   ordre_choix       string    "aleatoire" | "fixe" | ""
 *   choixCorrect      array     qcm/selection → indices [0,2] ; courte → strings ["réponse"] ; ouverte/cours → []
 *   indication        string    "" si inutile
 *   explicationCorrection string "" si inutile
 *   commentaire       string    "" par défaut
 *   consigneIA        string    "" par défaut
 *   ordreQuestion     string    "" par défaut
 *
 * Ces rows passent ensuite dans parse() de promptBuilder_listeQuestions.js côté
 * XSpro (mode 'json') qui gère la normalisation finale (_normaliserLigne,
 * _convertChoixCorrectIndices, _decodeField).
 *
 * ── reglesPostProcess ─────────────────────────────────────────────────────────
 * defaults : appliqué après applyPlaceholderDefaults
 * merge    : appliqué après applyRowActions (résolution des actions en tableau plat)
 *            — corrige les incohérences LLM, opère sur le résultat déjà aplati,
 *            aucune adaptation nécessaire pour le contrat par actions.
 *
 * LEXIQUE DES OPÉRATEURS (op) :
 *   empty  | vide ou 0            | { champ: 'points', op: 'empty' }
 *   eq     | égal à               | { champ: 'type', op: 'eq', valeur: 'cours' }
 *   neq    | différent de         | { champ: 'type', op: 'neq', valeur: 'cours' }
 *   gt/lt  | > / <                | { champ: 'points', op: 'gt', valeur: 3 }
 *   gte/lte| >= / <=              | { champ: 'points', op: 'gte', valeur: 1 }
 *
 * VALEURS DANS set :
 *   Fixe        | set: { points: 1 }
 *   Conditionnel| set: { champ: { si: { champ, op }, alors, sinon } }
 *   abs         | set: { champ: { abs: true } }      (rend positif)
 *
 * ── POLITIQUE DE VALIDATION MANUELLE (validateCellEdit) — DÉCISION VOLONTAIRE ──
 * ⚠️ Ne pas réintroduire de rejet/revert sur la base de règles croisées sans
 * validation préalable (cf. échanges du 2026-07-14). Principe retenu :
 *
 *   TOUTE modification manuelle d'une cellule est acceptée (ok: true), dans
 *   n'importe quel ordre — y compris remplir "correction" avant "choixCorrect",
 *   ou "choix" avant "choixCorrect", ou choisir un "type" sur une ligne dont les
 *   autres champs sont encore vides/incohérents pour ce type.
 *
 *   validateCellEdit ne fait plus que CONSTATER l'état de la ligne après la
 *   modification, via deux fonctions dédiées à l'affichage (rouge) uniquement,
 *   jamais au blocage :
 *     - getInvalidFields(row) : champs remplis mais dont la valeur est
 *       incohérente (avec le type, ou avec d'autres champs — ex: choixCorrect
 *       hors limites, regle "unique" avec 2 réponses correctes...).
 *     - getMissingFields(row) : champs requis pour ce type mais encore vides
 *       (REQUIRED_FIELDS_BY_TYPE) — inclut désormais 'contenu' pour tous les
 *       types, pas seulement 'cours'.
 *
 * Une ancienne version (avant 2026-07-14) bloquait ces cas via des règles
 * croisées dans validateCellEdit (ex: "correction" rejeté tant que
 * "choixCorrect" est vide pour une question "courte"). Cette approche a été
 * abandonnée : elle imposait un ordre de remplissage implicite et non
 * documenté, ce qui rendait la création manuelle de questions pénible voire
 * bloquante dans certains cas. Si un vrai blocage (revert) doit un jour être
 * réintroduit pour un cas précis, il doit être discuté et documenté ici avant
 * implémentation — pas réintroduit silencieusement à l'occasion d'un futur
 * correctif.
 * ──────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// ── Paramétrage prompt (source unique de vérité, cf. README-prompts.md) ───────
// Chargé ici (et pas seulement par viewResolver.js) car MANIFEST.regles est aussi
// lu directement par les fonctions internes de ce fichier (validateCellEdit,
// getInvalidFields, computeChampsRestreints) — elles ne passent pas par la fusion
// effectiveWorkerConfig de viewResolver.js. Éviter d'avoir le contenu dupliqué
// en dur dans MANIFEST *et* dans le JSON : une seule définition, requise ici.
const promptConfig = require('./formulaireListeQuestions.json');

// ── MANIFEST ──────────────────────────────────────────────────────────────────
const MANIFEST = {

  /**
   * Active le contrat d'édition par actions (update/delete/insert via _id) au lieu
   * du contrat historique positionnel. Permet au LLM d'insérer, corriger ou supprimer
   * des lignes individuellement, sans avoir à retranscrire l'intégralité du tableau —
   * cf. llmClient.js (applyRowActions) et sessionManager.js (_id, consumeNextId).
   */
  editionParActions: true,

  /**
   * Surcharges visuelles par colonne (UI Worker).
   * Aucune surcharge structurelle globale ici — chaque MODE définit les siennes.
   */
  surchargesColonnes: {},

  /**
   * Colonnes éditées en multiligne (textarea, Entrée = saut de ligne).
   * Propagé à grid.js via effectiveWorkerConfig pour brancher TextareaCellEditor.
   * Aucun hardcode dans grid.js : la liste est fournie par le hook vue.
   */
  champsMultiligne: ['contenu', 'choix', 'choixCorrect', 'indication', 'explicationCorrection', 'consigneIA', 'commentaire'],

  /**
   * Colonnes de type array (tableaux JavaScript).
   * Propagé à grid.js via effectiveWorkerConfig pour gérer valueFormatter/valueParser.
   * Ces champs contiennent des arrays JSON qui doivent être affichés/convertis.
   */
  champsArray: ['choix', 'choixCorrect'],
  // Déclare que les valeurs de 'choixCorrect' sont des indices numériques référençant
  // le tableau 'choix' de la même ligne (stockage/LLM = indices, affichage/édition =
  // texte résolu côté client — cf. grid.js, purement visuel, aucune donnée modifiée).
  champsIndexRef: { choixCorrect: 'choix' },

  /**
   * Styles de ligne selon le type de question.
   * Appliqué dans public/grid.js via getRowStyle.
   */
  // Indices type (manifest_parcours.js) : 1=qcm, 2=courte, 3=ouverte, 4=selection, 5=cours
  rowStyles: [
    // Cours — fond bleu clair, gras
    { si: { champ: 'type', op: 'eq', valeur: 5 },
      style: { background: '#EEF4FB', fontWeight: 'bold', color: '#1E3A5F' } },
    // qcm et sélection — fond légèrement coloré
    { si: { champ: 'type', op: 'eq', valeur: 1 },
      style: { background: '#F0FAF0' } },
    { si: { champ: 'type', op: 'eq', valeur: 4 },
      style: { background: '#F0FAF0' } },
    // Réponse courte — fond neutre
    { si: { champ: 'type', op: 'eq', valeur: 2 },
      style: { background: '#F9F9F9' } },
    // Ouverte — fond légèrement chaud
    { si: { champ: 'type', op: 'eq', valeur: 3 },
      style: { background: '#FEF9EC' } },
  ],

  // ── Prompt système de base, règles métier, promptsSuggeres et formatReponse ─
  // Source unique : formulaireListeQuestions.json (cf. README-prompts.md). Lu ici
  // (pas juste laissé à null) car des fonctions plus bas dans ce fichier lisent
  // MANIFEST.regles directement — voir commentaire en tête de fichier.
  systemPrompt: promptConfig.systemPrompt,

  promptsSuggeres: null, // surchargé par les MODES
  prompt:          null,
  modele:          null,
  export:          null,

  // ── Configuration d'export : conversion indices → labels ───────────────────────────
  // Utilisé par excelExport.js quand XSpro est absent pour produire un fichier lisible
  // Les libellés correspondent aux valeursPossibles définies ci-dessous
  exportFormat: {
    type: {
      convert: 'label',
      labels: [' ', 'qcm', 'courte', 'ouverte', 'selection', 'cours']
    },
    regle: {
      convert: 'label',
      labels: [' ', 'validation', 'unique', 'multiple', 'texte', 'texte(10)', 'nombre']
    },
    correction: {
      convert: 'label',
      labels: [' ', 'auto', 'manuel', 'semi']
    },
    ordre_choix: {
      convert: 'label',
      labels: [' ', 'aleatoire', 'fixe']
    }
  },

  // ── Règles métier — source unique : formulaireListeQuestions.json ──────────
  // Lu ici (pas juste laissé à null dans un futur MANIFEST minimal) car
  // validateCellEdit/getInvalidFields/computeChampsRestreints lisent
  // MANIFEST.regles directement plus bas dans ce fichier — voir commentaire
  // en tête de fichier.
  regles: promptConfig.regles,

  // ── Règles de post-traitement déclaratives ───────────────────────────────────
  reglesPostProcess: {

    defaults: [
      // points par défaut à 1 pour les non-cours si absent
      // (géré dans postProcessMerge custom — le moteur déclaratif ne supporte
      //  pas facilement la double condition neq + empty sur deux champs différents)
    ],

    // Indices type (manifest_parcours.js) : 1=qcm, 2=courte, 3=ouverte, 4=selection, 5=cours
    merge: [
      // ── type 5 (cours) : effacer ce qui ne s'applique pas, sauf regle="validation" ──
      {
        si:  { champ: 'type', op: 'eq', valeur: 5 },
        et:  { champ: 'regle', op: 'neq', valeur: 1 },
        set: { choix: ' ', choixCorrect: ' ', points: ' ', regle: ' ', correction: ' ', ordre_choix: ' ' },
      },

      // ── type 3 (ouverte) : pas de choix, pas de choixCorrect ────────────────
      {
        si:  { champ: 'type', op: 'eq', valeur: 3 },
        set: { choix: ' ', choixCorrect: ' ', ordre_choix: ' ' },
      },

      // ── type 2 (courte) : pas de propositions à choisir ─────────────────────
      {
        si:  { champ: 'type', op: 'eq', valeur: 2 },
        set: { choix: ' ', ordre_choix: ' ' },
      },

      // ── points hors plage → 1 (pour questions non-cours) ────────────────────
      {
        si:  { champ: 'type', op: 'neq', valeur: 5 },
        et:  { champ: 'points', op: 'gt', valeur: 3 },
        set: { points: 3 },
      },
      {
        si:  { champ: 'type', op: 'neq', valeur: 5 },
        et:  { champ: 'points', op: 'lt', valeur: 1 },
        set: { points: 1 },
      },
    ],
  },
};

// ── MODES ─────────────────────────────────────────────────────────────────────
/**
 * Deux modes de travail.
 *
 * analyse  : l'utilisateur consulte et améliore des questions existantes.
 *            Le LLM voit l'intégralité des données — il modifie, corrige,
 *            complète ou restructure ce qui lui est soumis.
 *
 * creation : l'utilisateur génère de nouvelles questions depuis le contenu
 *            des cours du chapitre ou depuis des documents joints (PDF, ZIP).
 *            Le LLM ne retranscrit pas les lignes existantes — il crée uniquement
 *            le complément demandé.
 */
const MODES = {

  analyse: {
    label: 'Analyse / Modification',
    description: 'Consulter et améliorer des questions existantes — corriger, reformuler, compléter les champs annexes notamment (indication, consigne de correction à donner à l\'IA pour cette ligne)',

    surchargesColonnes: {
      type:                  { width: 90 ,pinned:     'left'},
      contenu:               { width: 380 },
      regle:                 { width: 90 },
      correction:            { width: 90 },
      points:                { width: 75 },
      choix:                 { width: 220 },
      ordre_choix:           { width: 90 },
      choixCorrect:          { width: 180 },
      indication:            null,
      explicationCorrection: null,
      commentaire:           { width: 150 },
      consigneIA:            { width: 150 },
      ordreQuestion:         { width: 70 },
    },

    colonnesUiHidden:  ['ordreQuestion'],
    colonnesLlmHidden: ['ordreQuestion'],

    systemPrompt: promptConfig.modes.analyse.systemPrompt,

    regles: null,  // hérite du MANIFEST

    promptsSuggeres: promptConfig.modes.analyse.promptsSuggeres,

    modele: null,

    formatReponse: promptConfig.modes.analyse.formatReponse,
  },

  creation: {
    label: 'Création',
    description: 'Générer de nouvelles questions depuis le cours ou des documents joints',

    surchargesColonnes: {
      type:                  { width: 90, pinned:     'left'},
      contenu:               { width: 380 },
      regle:                 { width: 90 },
      correction:            { width: 90 },
      points:                { width: 60 },
      choix:                 { width: 220 },
      ordre_choix:           { width: 90 },
      choixCorrect:          { width: 180 },
      // indication:            null,
      // explicationCorrection: null,
      // commentaire:           { width: 150 },
      // consigneIA:            null,
      // ordreQuestion:         { width: 70 },
    },

    colonnesUiHidden:  ['indication',  'explicationCorrection', 'commentaire','consigneIA','ordreQuestion'],
    colonnesLlmHidden: ['indication',  'explicationCorrection', 'commentaire','consigneIA','ordreQuestion'],

    systemPrompt: promptConfig.modes.creation.systemPrompt,

    regles: null,  // hérite du MANIFEST

    promptsSuggeres: promptConfig.modes.creation.promptsSuggeres,

    modele: null,

    formatReponse: promptConfig.modes.creation.formatReponse,
  },
};

// ── SELECT CHOIX ──────────────────────────────────────────────────────────────
/**
 * Pour formulaireListeQuestions, les valeurs de type/regle/correction/ordre_choix
 * sont des STRINGS en base XSpro (pas des entiers).
 *
 * SELECT_CHOIX est donc minimal ici : il sert principalement à l'UI du Worker
 * pour afficher des dropdowns et contrôler les libellés vus par le LLM.
 *
 * Pas de surcharge dynamique depuis le payload (contrairement à detailsDevis
 * qui charge listeTauxHoraires/listeTauxRemise).
 *
 * Note : XSpro normalise le retour LLM via _normaliserLigne() dans parse(),
 * ce qui couvre la correction automatique des valeurs hors plage.
 */
function buildSelectChoix(workerConfig, data, xsproPayload) {
  // Valeurs entières alignées sur l'encodage XSpro (manifest_parcours.js) :
  //   PARCOURS_TYPE        = [' ', 'qcm', 'courte', 'ouverte', 'selection', 'cours']       → 0..5
  //   PARCOURS_REGLE       = [' ', 'validation', 'unique', 'multiple', 'texte', 'texte(10)', 'nombre'] → 0..6
  //   PARCOURS_CORRECTION  = [' ', 'auto', 'manuel', 'semi']                                → 0..3
  //   PARCOURS_ORDRE_CHOIX = [' ', 'aleatoire', 'fixe']                                     → 0..2
  // Le LLM voit le libellé (sendLabel:true) ; le retour est normalisé en indice entier
  // (identique au comportement de niveauListe dans detailsDevis.js).
  return {

    type: {
      sendLabel: true,
      choix: [
        { valeur: 0, label: ' ' },
        { valeur: 1, label: 'qcm' },
        { valeur: 2, label: 'Réponse courte' },
        { valeur: 3, label: 'Texte long' },
        { valeur: 4, label: 'Liste de choix' },
        { valeur: 5, label: 'Cours' },
      ],
      fallback: {
        siCondition: { champ: 'type', op: 'empty' },
        alors: 0,
        sinon: 1,
      },
    },

    regle: {
      sendLabel: true,
      choix: [
        { valeur: 0, label: ' ' },
        { valeur: 1, label: 'validation' },
        { valeur: 2, label: 'unique' },
        { valeur: 3, label: 'multiple' },
        { valeur: 4, label: 'texte' },
        { valeur: 5, label: 'texte(10)' },
        { valeur: 6, label: 'nombre' },
      ],
      fallback: {
        siCondition: { champ: 'regle', op: 'empty' },
        alors: 0,
        // sinon: 0 (et non une valeur "devinée" comme 'unique') — 'unique' n'est pas
        // une valeur autorisée pour courte/ouverte/cours (voir typesEtRegles) ; ce
        // fallback n'a pas connaissance du type de la ligne, donc on reste neutre
        // et on laisse postProcessMerge/validateFieldAgainstType imposer la vraie
        // valeur par type.
        sinon: 0,
      },
    },

    correction: {
      sendLabel: true,
      choix: [
        { valeur: 0, label: ' ' },
        { valeur: 1, label: 'auto' },
        { valeur: 2, label: 'manuel' },
        { valeur: 3, label: 'semi' },
      ],
      fallback: {
        siCondition: { champ: 'correction', op: 'empty' },
        alors: 0,
        // sinon: 0 (et non 'auto') — 'auto' n'est pas autorisé pour "ouverte"
        // (manuel/semi uniquement) ; même raison de neutralité que pour "regle" ci-dessus.
        sinon: 0,
      },
    },

    ordre_choix: {
      sendLabel: true,
      choix: [ 
        { valeur: 0, label: ' ' },
        { valeur: 1, label: 'aleatoire' },
        { valeur: 2, label: 'fixe' },
      ],
      fallback: {
        siCondition: { champ: 'ordre_choix', op: 'empty' },
        alors: 0,
        sinon: 0,
      },
    },

  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── INTERPRÉTEUR DE RÈGLES DÉCLARATIVES ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
// Copie locale — identique à detailsDevis.js.
// Séparer dans un module partagé si d'autres vues en ont besoin.

function evalCondition(row, cond) {
  if (!cond) return true;
  const { champ, op, valeur } = cond;
  const val = row[champ];
  const isEmpty = isEmptyVal(val);

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
        row[champ] = isNaN(n) ? ' ' : Math.abs(n);
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

// ── Construction automatique depuis reglesPostProcess ─────────────────────────
const rpp = MANIFEST.reglesPostProcess || {};

/**
 * Appliqué après applyPlaceholderDefaults.
 * Généré depuis MANIFEST.reglesPostProcess.defaults.
 */
function postProcessDefaults(rows, colonnes, regles) {
  return applyRegles(rpp.defaults, rows);
}

/**
 * Appliqué après parseAndMergeRows.
 * Étend le moteur déclaratif avec la logique non-déclarative spécifique
 * à formulaireListeQuestions :
 *
 *   1. Appliquer les règles déclaratives (nettoyage par type)
 *   2. Valeur par défaut de points (1) pour les lignes non-cours sans points
 *   3. Normalisation de choix/choixCorrect en array si le LLM a retourné des strings
 *
 * Note : _normaliserLigne() et _convertChoixCorrectIndices() côté XSpro (parse())
 * font une seconde passe complète — ce postProcess est surtout utile pour
 * l'affichage cohérent dans l'UI Worker avant validation.
 */
function postProcessMerge(mergedRows, originalRows, colonnes) {
  // 1. Règles déclaratives
  let rows = applyRegles(rpp.merge, mergedRows);

  // 2. Compléments non-déclaratifs
  // Indices type (manifest_parcours.js) : 1=qcm, 2=courte, 3=ouverte, 4=selection, 5=cours
  rows = rows.map(row => {
    const r = { ...row };
    const type = Number(r.type);

    // points par défaut → 1 si absent sur une ligne non-cours (type !== 5)
    if (type !== 5) {
      const pts = Number(r.points);
      if (!r.points || isNaN(pts) || pts < 1) r.points = 1;
    }

    // Normaliser choix en array si string <br>-séparé
    if (typeof r.choix === 'string' && r.choix !== ' ') {
      r.choix = r.choix.split(/<br\s*\/?>|\n/i).map(v => v.trim()).filter(Boolean);
    }
    if (!Array.isArray(r.choix)) r.choix = [];

    // Normaliser choixCorrect :
    //   - qcm(1)/selection(4) → array d'indices numériques (ou strings d'indices)
    //   - courte(2)           → array de strings
    //   - ouverte(3)/cours(5) → array vide (déjà géré déclarativement, sécurité)
    if (type === 3 || type === 5) {
      r.choixCorrect = [];
    } else if (typeof r.choixCorrect === 'string' && r.choixCorrect !== ' ') {
      if (type === 1 || type === 4) {
        // "0,2" → [0, 2]
        r.choixCorrect = r.choixCorrect.split(',')
          .map(v => v.trim())
          .filter(Boolean)
          .map(v => (isNaN(Number(v)) ? v : Number(v)));
      } else {
        // courte : "herbivore<br>végétarien" ou "herbivore,végétarien"
        r.choixCorrect = r.choixCorrect.split(/<br\s*\/?>|,|\n/i)
          .map(v => v.trim())
          .filter(Boolean);
      }
    }
    if (!Array.isArray(r.choixCorrect)) r.choixCorrect = [];

    // Gestion des incohérences spécifiques Réponse courte (2) :
    // correction dépend de choixCorrect (même règle conditionnelle que dans
    // validateFieldAgainstType — appliquée ici aussi pour corriger dès la génération
    // IA et pas seulement lors d'une édition manuelle ultérieure).
    //   choixCorrect vide   → correction forcée à "manuel" (indice 2)
    //   choixCorrect rempli → correction "manuel" invalide → repli sur "semi" (indice 3)
    if (type === 2) {
      const correctionLabel = valueToLabel('correction', r.correction) || r.correction;
      const ccEmpty = r.choixCorrect.length === 0;
      if (ccEmpty && (correctionLabel === 'auto' || correctionLabel === 'semi')) {
        r.correction = 2; // manuel
      } else if (!ccEmpty && correctionLabel === 'manuel') {
        r.correction = 3; // semi (défaut XSpro quand choixCorrect est rempli)
      }
    }

    // Gestion des incohérences spécifiques Texte long (3) :
    // correction dépend de regle (contrainte métier) :
    //   regle = 'texte' (sans paramètre)         → correction forcée à "manuel" (indice 2)
    //   regle = 'texte(N)' (texte avec paramètre) → correction forcée à "semi" (indice 3)
    if (type === 3) {
      const regleLabel = valueToLabel('regle', r.regle) || r.regle;
      const regleStr = String(regleLabel || ' ');
      if (regleStr === 'texte') {
        r.correction = 2; // manuel
      } else if (regleStr.startsWith('texte(')) {
        r.correction = 3; // semi
      }
    }

    // Gestion des incohérences spécifiques qcm (1) et Liste de choix (4)
    if (type === 1 || type === 4) {
      // Normaliser les indices en nombres
      r.choixCorrect = r.choixCorrect.map(v => Number(v)).filter(v => !isNaN(v));

      // Cohérence présence choix/choixCorrect
      if (r.choix.length === 0 && r.choixCorrect.length > 0) {
        // Choix vide mais choixCorrect rempli → vider choixCorrect
        r.choixCorrect = [];
      } else if (r.choix.length > 0 && r.choixCorrect.length === 0) {
        // Choix rempli mais choixCorrect vide → vider choix
        r.choix = [];
        r.choixCorrect = [];
      }

      // Si les deux sont remplis, vérifier la cohérence
      if (r.choix.length > 0 && r.choixCorrect.length > 0) {
        // Filtrer les indices hors limites
        r.choixCorrect = r.choixCorrect.filter(idx => idx >= 0 && idx < r.choix.length);

        // Vérifier la règle
        const currentRegleLabel = valueToLabel('regle', r.regle) || r.regle;
        if (currentRegleLabel === 'unique' && r.choixCorrect.length !== 1) {
          // RÈGLE "unique" : exactement 1 réponse correcte requise
          // Si plus d'une réponse → garder la première (comportement volontaire)
          // Si aucune réponse → vider la ligne (choix et choixCorrect)
          if (r.choixCorrect.length > 1) {
            r.choixCorrect = [r.choixCorrect[0]];
          } else {
            r.choixCorrect = [];
            r.choix = [];
          }
        } else if (currentRegleLabel === 'multiple' && r.choixCorrect.length < 1) {
          // RÈGLE "multiple" : au moins 1 réponse correcte requise
          // COMPORTEMENT ACCEPTÉ : toutes les combinaisons sont valides (1, 2, 3 ou 4 réponses)
          // — aligné sur typesEtRegles.qcm.choixCorrect, validateFieldAgainstType et
          //   validateCellEdit, qui acceptent tous les trois >= 1 réponse pour "multiple".
          // Si 0 réponse → vider la ligne (aucune correction possible)
          r.choixCorrect = [];
          r.choix = [];
        }
      }

      // Pour Liste de choix (selection), forcer regle à "unique"
      if (type === 4) {
        const currentRegleLabel = valueToLabel('regle', r.regle) || r.regle;
        if (currentRegleLabel !== 'unique') {
          r.regle = 2; // 2 = indice pour 'unique'
        }
      }
    }

    return r;
  });

  return rows;
}

// ── Exports ───────────────────────────────────────────────────────────────────
// ── Validation manuelle d'édition (côté serveur) ───────────────────────────
// Appelée par server.js (case 'cell:edit'). Retourne un objet :
//   { ok: true }                  → accepter
//   { ok: false, rowInvalid: true } → garder valeur, mettre ligne en rouge
//   { ok: false, message: '…' }   → revert + message
const TYPE_INT_TO_KEY = { 1:'qcm', 2:'courte', 3:'ouverte', 4:'selection', 5:'cours' };

// Champs requis (non vides) par type — sert uniquement à l'affichage visuel des
// champs "à remplir" (rouge) pendant la saisie progressive, jamais à bloquer une
// modification. Distinct de validateFieldAgainstType, qui lui rejette une VALEUR
// incohérente une fois renseignée.
const REQUIRED_FIELDS_BY_TYPE = {
  qcm:       ['contenu', 'regle', 'correction', 'choix', 'choixCorrect', 'points'],
  selection: ['contenu', 'regle', 'correction', 'choix', 'choixCorrect', 'points'],
  courte:    ['contenu', 'regle', 'correction', 'choixCorrect', 'points'],
  ouverte:   ['contenu', 'regle', 'correction', 'points'],
  cours:     ['contenu'],
};

/**
 * Champs requis pour le type courant de la ligne mais encore vides.
 * Utilisé pour surligner en rouge les champs "à remplir" sans jamais rejeter
 * la modification en cours (contrairement à getInvalidFields/validateCellEdit
 * qui, eux, rejettent une valeur réellement incohérente).
 */
function getMissingFields(row) {
  const typeKey = valueToLabel('type', row.type);
  if (!typeKey) return [];
  const required = REQUIRED_FIELDS_BY_TYPE[typeKey] || [];
  return required.filter(f => isEmptyVal(row[f]));
}

const FIELD_LABELS = { type:'Type', regle:'Règle', correction:'Correction', ordre_choix:'Ordre des choix', points:'Points', choix:'Choix', choixCorrect:'Réponses correctes', designation:'Désignation' };
// Champs qui autorisent toujours l'édition (type + désignation)
const ALWAYS_ALLOWED = new Set(['type', 'designation']);

// Conversion valeur (indice entier ou valeur brute) → label (string) pour validation
// pour que getInvalidFields compare toujours des labels avec les règles.
function valueToLabel(cle, val) {
  // type a sa propre table (indice → string)
  if (cle === 'type') {
    if (TYPE_INT_TO_KEY[val]) return TYPE_INT_TO_KEY[val];
    // déjà un label (string) — on normalise les variantes d'espaces ('  ', '\t'...) en ' '
    if (typeof val === 'string') return val.trim() === '' ? ' ' : val;
    return null;
  }
  // regle / correction / ordre_choix : valeursPossibles alignées sur les indices selectChoix
  const vp = MANIFEST.regles?.valeursPossibles?.[cle];
  if (vp && typeof val === 'number' && vp[val] !== undefined) return vp[val];
  // déjà un label (string) — idem, normaliser les variantes d'espaces
  if (typeof val === 'string') return val.trim() === '' ? ' ' : val;
  return null;
}

function isEmptyVal(v) {
  // Array vide [] → considéré comme vide
  if (Array.isArray(v)) return v.length === 0;
  // Toute chaîne blanche ('', ' ', '  ', '\t'...) est considérée comme vide —
  // XSpro peut envoyer différentes variantes d'espaces pour une valeur "non renseignée".
  if (typeof v === 'string' && v.trim() === '') return true;
  return v === null || v === undefined || Number(v) === 0;
}

function allowedLabels(typeKey, field) {
  const t = MANIFEST.regles?.typesEtRegles?.[typeKey];
  if (!t) return null;
  const v = t[field];
  if (v === undefined) return null;
  if (v === ' ') return [' '];
  return Array.isArray(v) ? v : null;
}

function validateFieldAgainstType(cle, val, typeKey, row) {
  // Normaliser la valeur : si c'est un indice entier → label string
  const label = valueToLabel(cle, val);
  const checkVal = label !== null ? label : val;
  // choix/ordre_choix doivent être vides pour courte/ouverte/cours
  // choixCorrect ne doit être vide que pour ouverte/cours (pour "courte" il est libre,
  // c'est lui qui pilote la règle conditionnelle sur "correction" — cf. plus bas)
    if (cle === 'choix' || cle === 'choixCorrect' || cle === 'ordre_choix') {
      const mustBeEmpty = cle === 'choixCorrect'
        ? ['ouverte', 'cours'].includes(typeKey)
        : ['courte', 'ouverte', 'cours'].includes(typeKey);
      if (mustBeEmpty && !isEmptyVal(checkVal)) {
        return { ok: false, message: `Le champ « ${FIELD_LABELS[cle]||cle} » doit être vide pour le type « ${typeKey} ».` };
      }
      // Vérification de compatibilité type/réponse pour les questions courtes
      if (typeKey === 'courte' && cle === 'choixCorrect' && row && !isEmptyVal(checkVal)) {
        const regle = row.regle;
        const choixCorrectArray = Array.isArray(checkVal) ? checkVal : (typeof checkVal === 'string' ? checkVal.split(/<br\s*\/?>|,|\n/i).map(v => v.trim()).filter(Boolean) : []);

        if (regle === 'nombre' || regle === 6) { // 6 = indice pour 'nombre'
          // Tous les éléments doivent être numériques
          const hasNonNumeric = choixCorrectArray.some(item => {
            return typeof item !== 'number' && (typeof item === 'string' && isNaN(Number(item)));
          });
          if (hasNonNumeric) {
            return { ok: false, message: `Pour « courte » avec règle « nombre », les réponses correctes doivent être numériques.` };
          }
        }
        // Note: Pour règle "texte", nous acceptons tout type de réponse (texte ou nombres)
        // car une réponse texte peut très bien contenir des chiffres (ex: "2023", "Page 42")
      }
      return { ok: true };
    }
  // points : vide pour cours, sinon 1-3
  if (cle === 'points') {
    if (typeKey === 'cours' && !isEmptyVal(checkVal)) return { ok: false, message: 'Le champ « Points » doit être vide pour le type cours.' };
    const n = Number(checkVal);
    if (!isEmptyVal(checkVal) && (isNaN(n) || n < 1 || n > 3)) return { ok: false, message: `Le champ « Points » doit être un entier de 1 à 3 (type « ${typeKey} »).` };
    return { ok: true };
  }
  
  // courte : correction dépend de choixCorrect (règle conditionnelle XSpro)
  if (typeKey === 'courte' && cle === 'correction' && row) {
    const cc = row.choixCorrect;
    const ccEmpty = Array.isArray(cc) ? cc.length === 0 : isEmptyVal(cc);
    if (!ccEmpty && checkVal === 'manuel') {
      return { ok: false, message: `Pour « courte » avec une réponse correcte renseignée, la correction ne peut pas être « manuel » (utilisez auto ou semi).` };
    }
    if (ccEmpty && (checkVal === 'auto' || checkVal === 'semi')) {
      return { ok: false, message: `Pour « courte » sans réponse correcte, la correction doit être « manuel ».` };
    }
  }

  // ouverte : correction dépend de regle (contrainte métier)
  //   regle = 'texte' (sans paramètre)         → correction doit être "manuel"
  //   regle = 'texte(N)' (texte avec paramètre) → correction doit être "semi"
  if (typeKey === 'ouverte' && cle === 'correction' && row) {
    const regleLabel = valueToLabel('regle', row.regle) || row.regle;
    const regleStr = String(regleLabel || ' ');
    if (regleStr === 'texte' && checkVal !== 'manuel') {
      return { ok: false, message: `Pour « ouverte » avec règle « texte », la correction doit être « manuel ».` };
    }
    if (regleStr.startsWith('texte(') && checkVal !== 'semi') {
      return { ok: false, message: `Pour « ouverte » avec règle « ${regleStr} », la correction doit être « semi ».` };
    }
  }
  // regle / correction : valeurs autorisées
  const allowed = allowedLabels(typeKey, cle);
  if (allowed && allowed.length) {
    if (isEmptyVal(checkVal)) {
      if (!allowed.includes(' ') && !allowed.includes('')) return { ok: false, message: `Le champ « ${FIELD_LABELS[cle]||cle} » est requis pour le type « ${typeKey} ».` };
    } else if (!allowed.includes(String(checkVal))) {
      return { ok: false, message: `« ${checkVal} » n'est pas une valeur autorisée pour « ${FIELD_LABELS[cle]||cle} » avec le type « ${typeKey} ».` };
    }
  }

  return { ok: true };
}

/**
 * Vérifications croisées qcm/selection — recalculées ENTIÈREMENT à chaque appel,
 * sur l'état complet de la ligne, indépendamment du champ qui vient d'être édité.
 * Principe demandé : "tout changement dans une ligne refait un check complet de
 * la ligne". Retourne directement la liste des champs à marquer en rouge —
 * jamais de blocage, purement indicatif (cf. politique de validation permissive
 * en tête de fichier).
 *
 * Règles couvertes (qcm ET selection, selection étant qcm à choix unique forcé) :
 *   - choix/choixCorrect doivent être remplis ou vides ENSEMBLE
 *   - choixCorrect ne doit contenir que des indices dans les bornes de choix
 *   - choixCorrect ne doit pas contenir de texte non résolu (aucune correspondance)
 *   - regle "unique"   → exactement 1 choixCorrect
 *   - regle "multiple" → au moins 1 choixCorrect (qcm uniquement)
 *   - selection        → regle forcée à "unique"
 */
function getQcmSelectionInvalidFields(row, typeKey) {
  if (typeKey !== 'qcm' && typeKey !== 'selection') return [];

  const choixArray = Array.isArray(row.choix) ? row.choix : [];
  const choixCorrectArray = Array.isArray(row.choixCorrect) ? row.choixCorrect : [];
  const regleLabel = valueToLabel('regle', row.regle) || row.regle;
  const invalid = new Set();

  // Cohérence de présence : remplis ou vides ENSEMBLE
  if (choixArray.length === 0 && choixCorrectArray.length > 0) {
    invalid.add('choix'); invalid.add('choixCorrect');
  }
  if (choixArray.length > 0 && choixCorrectArray.length === 0) {
    invalid.add('choix'); invalid.add('choixCorrect');
  }

  if (choixCorrectArray.length > 0) {
    // Indices hors bornes
    const numericEntries = choixCorrectArray.filter(v => typeof v === 'number');
    const hasOutOfBounds = numericEntries.some(idx => idx < 0 || idx >= choixArray.length);
    if (hasOutOfBounds) { invalid.add('choix'); invalid.add('choixCorrect'); }

    // Texte non résolu en indice — aucune correspondance dans choix
    const hasUnresolvedText = choixCorrectArray.some(v => typeof v !== 'number');
    if (hasUnresolvedText) { invalid.add('choix'); invalid.add('choixCorrect'); }
  }

  // Règle "unique" : exactement 1 réponse correcte requise
  if (regleLabel === 'unique' && choixCorrectArray.length !== 1) {
    invalid.add('regle'); invalid.add('choix'); invalid.add('choixCorrect');
  }
  // Règle "multiple" : au moins 1 réponse correcte requise (qcm uniquement)
  if (regleLabel === 'multiple' && choixCorrectArray.length < 1) {
    invalid.add('regle'); invalid.add('choix'); invalid.add('choixCorrect');
  }
  // Liste de choix (selection) : la règle doit toujours être "unique"
  if (typeKey === 'selection' && regleLabel !== 'unique') {
    invalid.add('regle');
  }

  return Array.from(invalid);
}

function getInvalidFields(row) {
  const typeKey = valueToLabel('type', row.type);
  // Si le type est vide (0) ou n'a pas de label significatif, ne pas valider les autres champs
  // Cela permet de remplir progressivement une nouvelle ligne sans être bloqué
  if (isEmptyVal(typeKey)) return [];
  const invalid = new Set();
  for (const f of ['regle', 'correction', 'ordre_choix', 'points', 'choix', 'choixCorrect']) {
    const res = validateFieldAgainstType(f, row[f], typeKey, row);
    if (!res.ok) invalid.add(f);
  }
  // Check complet qcm/selection, indépendant du champ édité (cf. principe : tout
  // changement dans une ligne refait un check complet de la ligne).
  for (const f of getQcmSelectionInvalidFields(row, typeKey)) invalid.add(f);
  return Array.from(invalid);
}

/**
 * Réconciliation champsIndexRef (déclaratif, cf. MANIFEST.champsIndexRef) : quand un
 * champ de référence est modifié (ex: 'choix'), recalcule les valeurs de chaque champ
 * qui le référence (ex: 'choixCorrect') pour qu'elles continuent de pointer sur le MÊME
 * TEXTE qu'avant, plutôt que de se retrouver décalées ou hors-bornes après réorganisation.
 *
 * Politique (décision explicite, cf. échanges du 2026-07-15) : une valeur qui correspond
 * à un élément du nouveau tableau de référence devient un INDICE numérique ; une valeur
 * qui ne correspond à rien est conservée telle quelle en TEXTE BRUT — état transitoire
 * normal pendant la construction manuelle d'une question (on tape la bonne réponse avant
 * que les choix ne soient tous saisis, ou on modifie manuellement une réponse). La
 * résolution finale texte → indice, si elle n'est pas encore faite, est prise en charge
 * plus tard par le LLM. Ne PAS abandonner silencieusement une valeur non résolue.
 *
 * Cette logique vivait auparavant, à tort, directement dans grid.js (codée en dur sur
 * 'choix'/'choixCorrect') — déplacée ici pour respecter le principe : rien de spécifique
 * à une vue dans grid.js, qui reste générique.
 *
 * @param {Object} row          — ligne AVANT modification
 * @param {Object} sim          — ligne APRÈS modification (row + { [editedField]: newValue })
 * @param {string} editedField  — champ qui vient d'être édité
 * @returns {Object|null}       — { [champDependant]: nouvellesValeurs, ... } ou null si rien à ajuster
 */
function computeIndexRefSideEffects(row, sim, editedField) {
  const refMap = MANIFEST.champsIndexRef || {};
  let sideEffects = null;

  for (const [dependentField, refField] of Object.entries(refMap)) {
    if (refField !== editedField) continue;

    const oldRef = Array.isArray(row[refField]) ? row[refField] : [];
    const newRef = Array.isArray(sim[refField]) ? sim[refField] : [];
    const currentValues = Array.isArray(row[dependentField]) ? row[dependentField] : [];
    if (!currentValues.length) continue;

    const reconciled = currentValues.map(v => {
      // v est déjà un indice numérique valide dans l'ANCIEN référentiel → résoudre en texte,
      // sinon v est déjà du texte brut (valeur non résolue précédemment) → garder tel quel.
      const text = (typeof v === 'number' && oldRef[v] !== undefined) ? oldRef[v] : v;
      const newIdx = newRef.findIndex(item => String(item).trim() === String(text ?? '').trim());
      return newIdx !== -1 ? newIdx : text; // trouvé → indice numérique ; sinon → texte brut conservé
    });

    const changed = reconciled.length !== currentValues.length
      || reconciled.some((v, i) => v !== currentValues[i]);
    if (changed) {
      sideEffects = sideEffects || {};
      sideEffects[dependentField] = reconciled;
    }
  }
  return sideEffects;
}

function validateCellEdit(row, cle, newValue) {
  const regles = MANIFEST.regles?.typesEtRegles;
  if (!regles) return { ok: true, invalidFields: [] };

  // Ligne simulée avec la nouvelle valeur, pour évaluer l'état complet après cette édition.
  const sim = { ...row, [cle]: newValue };

  // Principe : toute modification manuelle est acceptée, dans n'importe quel ordre —
  // remplir "correction" avant "choixCorrect", ou "choix" avant "choixCorrect", etc. doit
  // rester possible sans jamais être rejeté. On ne fait plus que CONSTATER l'état de la
  // ligne après coup et le signaler visuellement :
  //   - getInvalidFields  : champs remplis mais dont la valeur est incohérente avec le
  //                         type ou avec d'autres champs (ex: choixCorrect hors limites,
  //                         regle "unique" avec 2 réponses correctes...)
  //   - getMissingFields  : champs requis pour ce type mais encore vides (contenu, points...)
  // Les deux sont purement indicatifs (rouge) — aucun des deux ne bloque la saisie.
  const invalidFields = Array.from(new Set([...getInvalidFields(sim), ...getMissingFields(sim)]));

  // sideEffects : ajustements d'AUTRES champs déclenchés par cette édition (ex: réconcilier
  // choixCorrect quand choix change). Générique côté server.js/grid.js — ceux-ci se contentent
  // d'appliquer et de notifier ce que le hook calcule, sans connaître les noms des champs.
  const sideEffects = computeIndexRefSideEffects(row, sim, cle);

  return { ok: true, invalidFields, ...(sideEffects ? { sideEffects } : {}) };
}

/**
 * Calcule, pour chaque champ selectChoix (hors 'type', qui n'est jamais restreint),
 * les valeurs numériques autorisées SELON LE TYPE de la ligne — réutilise la même
 * source de vérité que allowedLabels() (MANIFEST.regles.typesEtRegles), traduite en
 * valeurs numériques via les paires {valeur,label} déjà définies dans selectChoix.
 *
 * Résultat transmis tel quel au client (cf. viewResolver.js, server.js) pour ne
 * proposer, dans chaque dropdown, que les options non interdites pour le type
 * courant de la ligne — sans jamais bloquer une valeur déjà présente en donnée
 * (cf. politique de validation permissive : ceci ne fait que restreindre le MENU,
 * jamais la validation elle-même).
 *
 * @returns {Object} — { [champ]: { [valeurType]: [valeursAutorisees] } }
 */
function computeChampsRestreints(selectChoix) {
  const typesEtRegles = MANIFEST.regles?.typesEtRegles;
  if (!typesEtRegles) return {};
  const restreints = {};

  for (const [field, sc] of Object.entries(selectChoix || {})) {
    if (field === 'type') continue; // type n'est jamais restreint (décision explicite)
    if (!Array.isArray(sc?.choix)) continue;

    const byType = {};
    for (const [typeValeurStr, typeLabel] of Object.entries(TYPE_INT_TO_KEY)) {
      const allowed = typesEtRegles[typeLabel]?.[field];
      if (!Array.isArray(allowed)) continue; // pas de restriction déclarée (description libre, ou absent)
      const valeurs = allowed
        .map(label => sc.choix.find(c => c.label === label)?.valeur)
        .filter(v => v !== undefined);
      if (valeurs.length) byType[Number(typeValeurStr)] = valeurs;
    }
    if (Object.keys(byType).length) restreints[field] = byType;
  }
  return restreints;
}

module.exports = {
  MANIFEST,
  MODES,
  SELECT_CHOIX: buildSelectChoix,
  CHAMPS_RESTREINTS: (workerConfig, data, xsproPayload) =>
    computeChampsRestreints(buildSelectChoix(workerConfig, data, xsproPayload)),
  postProcessDefaults,
  postProcessMerge,
  validateCellEdit,
  getInvalidFields,
  getMissingFields,
};
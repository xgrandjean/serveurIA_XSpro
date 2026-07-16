/**
 * AI Worker — views/formulaireGetDetailsAF.js
 * Hook spécifique à la vue "formulaireGetDetailsAF" (commande fournisseur / affaire).
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
 * Vue structurellement quasi identique à formulaireGetDetailsTravaux :
 *   - pas de hiérarchie (pas de niveauListe)
 *   - pas de colonne à indice/select choix côté XSpro (clesChampsSelectChoixDevantResterBrut
 *     vide) MAIS on définit nous-mêmes un SELECT_CHOIX pour livre/facture/regle/annule
 *     (statuts comptables ✓/✘, même principe que fait/validation/nonValide dans
 *     formulaireGetDetailsTravaux). Ces colonnes sont MASQUÉES pour le LLM
 *     (colonnesLlmHidden / surcharges { hide: true } en mode creation) — réservées
 *     à la saisie manuelle côté suivi comptable.
 *   - MODES multi-uniformes (standard / creation) comme formulaireGetDetailsTravaux.
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
    * reference est l'identifiant métier de la ligne → épinglé à gauche.
    *
    * livre / facture / regle / annule : suivi manuel (✔/✘) du cycle d'achat →
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
      livre:       { hide: true, placeholder: true, width: 60, minWidth: 60 },
      facture:     { hide: true, placeholder: true, width: 60, minWidth: 60 },
      regle:       { hide: true, placeholder: true, width: 60, minWidth: 60 },
      annule:      { hide: true, placeholder: true, width: 60, minWidth: 60 },
      codeTVA:     { width: 70 },
    },

   /**
    * Colonnes éditées en multiligne (textarea, Entrée = saut de ligne).
    * Propagé à grid.js via effectiveWorkerConfig pour brancher TextareaCellEditor.
    * Même mécanisme que dans detailsDevis.js, formulaireListeQuestions.js et formulaireGetDetailsTravaux.js.
    */
   champsMultiligne: ['reference', 'designation', 'commentaire'],

  systemPrompt: `Tu es un assistant spécialisé dans le suivi et la complétion fidèle de commandes fournisseur (listes d'articles à commander).
  Les articles sont ici généralement déjà définis, au moins dans les grandes lignes (reference, designation, quantite en partie renseignés) :
  ton rôle est de vérifier, corriger et compléter les champs manquants ou incohérents, SANS reformuler ni restructurer ce qui existe déjà.
  Ne modifie une valeur déjà renseignée que si elle est manifestement erronée ou si la correction est explicitement demandée.
  Les champs livre/facture/regle/annule sont réservés à la saisie manuelle côté comptabilité et ne t'apparaissent pas — ne cherche jamais à les lire ni à les renseigner.

  Les articles déjà présents dans "DONNÉES ACTUELLES" font partie intégrante de la commande finale, comme
  un document déjà rédigé que tu complètes. En l'absence d'instruction explicite : conserve-les tels
  quels, complète uniquement ce qui manque. Tu ne modifies ou supprimes un article existant que si
  c'est explicitement demandé ou s'il est manifestement erroné (ex: référence en doublon).`,

  promptsSuggeres: {
    creation: [
      'Complète les articles manquants à partir des données déjà présentes dans cette commande',
      'Vérifie et corrige les références en doublon sans modifier les autres articles',
      'Complète les prix unitaires manquants pour les articles déjà définis',
    ],
    analyse: [
      'Fais la synthèse de l\'état d\'avancement de cette commande fournisseur',
      'Liste les articles non livrés ou non facturés',
      'Quel est le montant total restant à régler ?',
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
- "insert" : "_apres" = _id de l'article après lequel insérer ; null = en tête ; "fin" = en dernier.
- Ne renvoie AUCUNE action pour un article existant que tu ne modifies pas.
- Retourner UNIQUEMENT les clés de colonnes listées ci-dessus (+ "_action"/"_id"/"_apres").
- Si une valeur est inconnue, utiliser "" (chaîne vide).
- Pas de texte avant ni après. Pas de balises markdown.
`,

  // Règles métier — structure libre, sérialisée en JSON dans le prompt
  regles: {
    champsObligatoires: ['designation'],
    identifiants: {
      champ: 'reference',
      description: 'référence de l\'article — ne jamais inventer une référence, laisser vide si non fournie',
    },
    interdictions: [
      'SI les colonnes livre, facture, regle ou annule existent, laisser tel quel — champs réservés à la saisie manuelle côté comptabilité',
      'Ne pas inventer de montant précis si il n\'est pas déductible du contexte — laisser vide plutôt que d\'inventer un chiffre arbitraire',
    ],
    texteLibre: `
    - designation doit être une description claire et actionnable de l'article (ex. "Câble U1000R2V 3G2.5", "Disjoncteur différentiel 10A").
    - quantite est un nombre positif représentant la quantité commandée — jamais négative.
    - montant est le prix unitaire HT, un nombre positif — jamais négatif.
    - commentaire reste du texte libre, à ne renseigner que si une précision utile existe.
    - codeTVA reprend le code applicable (1, 2, 3) s'il est déductible du contexte, sinon laisse vide.
    - Un article = une ligne homogène ; si une demande couvre plusieurs types d'articles, crée une ligne par article plutôt qu'une ligne fourre-tout.
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
      // Montant négatif → valeur absolue
      { si: { champ: 'montant', op: 'lt', valeur: 0 }, set: { montant: { abs: true } } },
    ],
  },
};

// ── MODES ─────────────────────────────────────────────────────────────────────
/**
 * Lentilles de travail optionnelles, structurées de façon uniforme
 * (toutes les clés listées, null = pas de surcharge) comme formulaireGetDetailsTravaux.
 *
 * colonnesUiHidden  : colonnes masquées dans l'UI (AG Grid) pour ce mode
 * colonnesLlmHidden : colonnes exclues du prompt LLM pour ce mode
 *                     (transparentes pour le LLM — il ne sait pas qu'elles existent)
 *
 * Les colonnes livre/facture/regle/annule sont masquées pour le LLM dans tous
 * les modes (colonnesLlmHidden), et en plus masquées dans l'UI en mode creation
 * (surcharge { hide: true }) — champs réservés à la saisie manuelle côté
 * comptabilité, jamais renseignés par l'IA.
 */
const MODES = {
  standard: {
    label: 'Standard',
    description: 'Vue standard de la commande fournisseur',
    surchargesColonnes: {
      reference:   null,
      designation: null,
      quantite:    null,
      montant:     null,
      commentaire: null,
      // Suivi manuel masqué pour le LLM (jamais renseigné par l'IA)
      livre:       null,
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
    description: 'Créer des commandes fournisseur à partir de documents (devis, CCTP…)',
    surchargesColonnes: {
      reference:   null,
      designation: null,
      quantite:    null,
      montant:     null,
      commentaire: null,
      // Suivi manuel masqué pour le LLM (jamais renseigné par l'IA)
      livre:       { hide: true, placeholder: true, width: 60, minWidth: 60 },
      facture:     { hide: true, placeholder: true, width: 60, minWidth: 60 },
      regle:       { hide: true, placeholder: true, width: 60, minWidth: 60 },
      annule:      { hide: true, placeholder: true, width: 60, minWidth: 60 },
      codeTVA:     null,
    },
    colonnesUiHidden:  ['livre', 'facture', 'regle', 'annule','codeTVA','commentaire'],
    colonnesLlmHidden: ['livre', 'facture', 'regle', 'annule','codeTVA','commentaire'],
    systemPrompt: `Tu es un assistant spécialisé dans la création de commandes fournisseur à partir de documents (devis fournisseur, CCTP, liste de matériel...).
    Contrairement au mode standard, les articles ne sont pas censés être déjà définis : à toi de les déduire des documents fournis
    et de les structurer en une liste complète et actionnable (reference, designation, quantite, montant).
    N'hésite pas à décomposer une commande complexe en plusieurs lignes distinctes par type d'article.
    Si un montant n'est pas déductible du contexte, laisse-le vide plutôt que d'inventer un chiffre arbitraire.

    Si des articles figurent déjà dans "DONNÉES ACTUELLES", conserve-les tels quels par défaut et
    insère les nouveaux articles déduits du document (action "insert", "_apres" au bon endroit) — ne les
    modifie ou remplace que s'ils sont explicitement incohérents (ex: référence en doublon) ou si la
    demande le précise.`,
    regles: null,
    promptsSuggeres: {
      creation: [
        'Décompose ce devis fournisseur en liste d\'articles à commander',
        'Génère une commande fournisseur complète à partir de ce document',
      ],
    },
    modele: null,
  },
};

// ── SELECT CHOIX ──────────────────────────────────────────────────────────────
/**
 * Colonnes à valeur indicée avec libellé lisible.
 *
 * On définit ici un SELECT_CHOIX pour livre/facture/regle/annule. Ces colonnes
 * sont MASQUÉES pour le LLM via colonnesLlmHidden (et dans l'UI en mode
 * creation), mais le SELECT_CHOIX reste défini au cas où la vue serait
 * ré-affichée :
 *   - dropdown (✓ / vide pour livre&facture&regle, ✘ / vide pour annule)
 *   - le LLM verrait le libellé (sendLabel: true) s'il n'était pas masqué
 *   - le retour est normalisé en valeur BDD (indice entier)
 *
 * Peut être un objet statique ou une fonction (workerConfig, data, xsproPayload) => objet.
 */
function buildSelectChoix(workerConfig, data, xsproPayload) {
  return {
    livre: {
      sendLabel: true,
      choix: [
        { valeur: 0, label: ' '  },
        { valeur: 1, label: '✓' },
      ],
      fallback: {
        siCondition: { champ: 'livre', op: 'empty' },
        alors:  0,
        sinon:  1,
      },
    },
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
// Identique à detailsDevis.js / formulaireGetDetailsTravaux.js —
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
// SELECT_CHOIX défini ici pour donner à livre/facture/regle/annule le même
// rendu dropdown que fait/validation/nonValide (formulaireGetDetailsTravaux).
module.exports = {
  MANIFEST,
  MODES,
  SELECT_CHOIX: buildSelectChoix,
  postProcessDefaults,
  postProcessMerge,
};
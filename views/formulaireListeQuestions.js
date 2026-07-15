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

  // ── Prompt système de base (commun aux deux modes, peut être surchargé par MODE) ─
  systemPrompt: `Tu es un assistant pédagogique expert en création de contenu de formation.
Tu génères ou modifies des questions et cours structurés pour un système e-learning.
Respecte scrupuleusement les règles métier définies et le format de sortie attendu.
Ne produis que des lignes utiles — n'ajoute pas de lignes vides ni de doublons.
Langue : UNIQUEMENT du français correct et technique.`,

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

  // ── Règles métier — sérialisées en JSON dans le prompt par buildSystemPrompt ─
  regles: {

    /**
     * Contrat par type de question.
     * Ces règles sont absolues — toute ligne non conforme sera rejetée côté XSpro.
     */
    typesEtRegles: {
      qcm: {
        description:   'Question à choix multiples',
        regle:         ['unique', 'multiple'],
        correction:    ['auto'],
        choix:         'Requis. 4 propositions par défaut (sauf mention contraire). Array de strings.',
        choixCorrect:  'Requis. Indices 0-based des bonnes réponses. Ex: [1] ou [0,2]. Pour regle="multiple" : au moins 1 indice, toutes les combinaisons acceptées (1, 2, 3 ou 4 réponses possibles).',
        ordre_choix:   '"aleatoire" | "fixe" | ""',
        points:        'Entier 1-3 selon difficulté.',
      },
      selection: {
        description:   'Liste déroulante (un seul choix visible à la fois)',
        regle:         ['unique'],
        correction:    ['auto'],
        choix:         'Requis. 4 propositions par défaut (sauf mention contraire). Array de strings.',
        choixCorrect:  'Requis. Indice 0-based de la bonne réponse. Ex: [1].',
        ordre_choix:   '"aleatoire" | "fixe" | ""',
        points:        'Entier 1-3 selon difficulté.',
      },
      courte: {
        description:   'Réponse courte saisie libre',
        regle:         ['texte', 'nombre'],
        correction:    ['auto', 'semi', 'manuel'],
        choix:         'Vide — laisser [].',
        choixCorrect:  'Array de strings : toutes les réponses acceptables. Ex: ["herbivore", "végétarien"]. Respecte la casse exacte.',
        ordre_choix:   'Vide — non applicable.',
        points:        'Entier 1-3 selon difficulté.',
      },
      ouverte: {
        description:   'Texte long — réponse libre',
        regle:         ['texte', 'texte(10)'],
        correction:    ['manuel', 'semi'],
        choix:         'Vide — laisser [].',
        choixCorrect:  'Vide — laisser [].',
        ordre_choix:   'Vide — non applicable.',
        points:        'Entier 1-3 selon difficulté.',
      },
      cours: {
        description:   'Bloc de contenu pédagogique (pas une question)',
        regle:         [' ', 'validation'],
        correction:    [' ', 'auto'],
        choix:         'Vide — laisser [].',
        choixCorrect:  'Vide — laisser [].',
        ordre_choix:   'Vide — non applicable.',
        points:        'Vide — les cours ne sont pas notés.',
        contenu:       'Markdown enrichi : ## titres, **gras**, *italique*, - listes, | tableaux, ```blocs code```. HTML simple accepté (entités encodés).',
      },
    },

    /**
     * Format des champs communs à tous les types.
     */
    formatChamps: {
      contenu:              'Énoncé de la question ou corps du cours. Sauts de ligne → <br>. Markdown pour les cours, texte simple pour les questions.',
      choix:                'Array de strings. Ex: ["Les félidés", "Les équidés", "Les bovidés", "Les canidés"].',
      choixCorrect:         'Array — format dépend du type (voir typesEtRegles).',
      indication:           'Indice optionnel affiché à la demande de l\'apprenant. "" si inutile.',
      explicationCorrection:'Explication affichée après correction. "" si inutile.',
      commentaire:          '"" par défaut — laisser vide sauf demande explicite.',
      // consigneIA et ordreQuestion ne sont PAS documentés ici : ils sont dans
      // colonnesLlmHidden des DEUX modes (analyse et creation), donc jamais vus par
      // le LLM. Les documenter ici ajouterait des instructions mortes dans le prompt
      // système si buildSystemPrompt sérialise formatChamps sans filtrage par
      // colonnesLlmHidden. Si ces champs doivent un jour être exposés au LLM dans
      // un mode donné, réintroduire l'entrée à ce moment-là.
    },

    /**
     * Valeurs autorisées par champ (pour validation LLM).
     */
    valeursPossibles: {
      type:        ['qcm', 'courte', 'ouverte', 'selection', 'cours'],
      regle:       [' ', 'validation', 'unique', 'multiple', 'texte', 'texte(10)', 'nombre'],
      correction:  [' ', 'auto', 'manuel', 'semi'],
      ordre_choix: [' ', 'aleatoire', 'fixe'],
    },

    /**
     * Consignes de qualité transversales.
     */
    qualite: [
      'Les réponses doivent être 100 % exactes — particulièrement pour les sujets techniques.',
      'Pour les qcm : les distracteurs (mauvaises réponses) doivent être plausibles.',
      'Ne pas créer deux questions identiques ou trop similaires dans la même session.',
      'La difficulté doit être progressive (points 1 → 3).',
      'Aucun charabia, aucun mot étranger non justifié.',
    ],
  },

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
      consigneIA:            null,
      ordreQuestion:         { width: 70 },
    },

    colonnesUiHidden:  ['consigneIA','ordreQuestion'],
    colonnesLlmHidden: ['consigneIA', 'ordreQuestion'],

    systemPrompt: `Tu es un assistant pédagogique expert.
Tu analyses et améliores des questions de formation existantes.
Tu peux : corriger le contenu, améliorer la formulation, ajuster la difficulté,
  compléter les champs manquants, corriger les incohérences type/regle/correction,
  ajouter de nouvelles questions, ou supprimer une question devenue inutile.

Les lignes existantes dans "DONNÉES ACTUELLES" ne sont pas une simple référence :
elles font partie intégrante de la solution finale, comme une base déjà écrite que
tu complètes. Tu dois :
- t'aligner sur leur niveau de difficulté, leur style de formulation et la progression déjà engagée
- éviter toute redondance ou répétition avec les questions déjà présentes
- ne jamais contredire leur contenu pédagogique
- les conserver telles quelles par défaut ; tu ne les modifies ou supprimes que si elles
  sont explicitement incohérentes (type/regle/correction) ou si la demande le précise.`,

    regles: null,  // hérite du MANIFEST

    // Liste plate — chaque MODE expose ses propres suggestions, pas de sous-imbrication
    // par sous-mode (cf. architecture formulairePromptDialog : une liste par mode actif).
    promptsSuggeres: [
      'Vérifie la cohérence de toutes les questions (type, règle, réponses correctes)',
      'Améliore la formulation des questions trop ambiguës',
      'Complète les champs "indication" et "explicationCorrection" manquants',
      'Augmente progressivement la difficulté des questions (points 1 → 3)',
      'Identifie et corrige les erreurs factuelles dans les qcm',
    ],

    modele: null,

    // Contrat d'actions (editionParActions actif au niveau MANIFEST) : le LLM référence
    // les lignes existantes par leur _id (colonne ajoutée en tête du CSV), et ne renvoie
    // que ce qui change — pas besoin de retranscrire les lignes non concernées.
    formatReponse: `
== FORMAT DE RÉPONSE ==
Réponds UNIQUEMENT avec un tableau JSON valide d'actions. Chaque élément est l'une de :
  { "_action": "update", "_id": <id>, <champs modifiés uniquement> }
  { "_action": "delete", "_id": <id> }
  { "_action": "insert", "_apres": <id> | null | "fin", <tous les champs de la nouvelle ligne> }
- "_id" référence la colonne _id du CSV "DONNÉES ACTUELLES" — jamais un numéro de ligne.
- "update" : n'inclue que les champs que tu modifies réellement, pas la ligne entière.
- "insert" : "_apres" = _id de la ligne après laquelle insérer ; null = en tête ; "fin" = en dernier.
- Ne renvoie AUCUNE action pour une ligne existante que tu ne modifies pas.
- Retourner UNIQUEMENT les clés de colonnes listées ci-dessus (+ "_action"/"_id"/"_apres").
- Si une valeur est inconnue, utiliser "" (chaîne vide).
- Pas de texte avant ni après. Pas de balises markdown.

Exemple : corriger la ligne _id=3, supprimer la ligne _id=7, ajouter une question après _id=3 :
[
  { "_action": "update", "_id": 3, "points": 2, "correction": "semi" },
  { "_action": "delete", "_id": 7 },
  { "_action": "insert", "_apres": 3, "type": "qcm", "contenu": "...", "regle": "unique",
    "correction": "auto", "points": "1", "choix": ["A","B","C","D"], "ordre_choix": "aleatoire",
    "choixCorrect": [0], "indication": "", "explicationCorrection": "", "commentaire": "" }
]
`,
  },

  creation: {
    label: 'Création',

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

    systemPrompt: `Tu es un assistant pédagogique expert en ingénierie pédagogique.
Tu crées des questions de formation originales à partir du contenu des cours fournis
et/ou des documents joints (PDF, ZIP, texte).

Règles de création :
- Génère UNIQUEMENT les nouvelles lignes demandées — ne retranscris pas les questions déjà présentes.
  Techniquement, cela signifie : n'utilise que des actions "insert" (jamais "update"/"delete"
  sauf demande explicite de corriger une ligne existante incohérente).
- Base-toi sur le contenu des cours (section "COURS") comme source de vérité thématique.
- Les lignes existantes dans "DONNÉES ACTUELLES" te servent de contexte : thème, niveau de
  langue et de difficulté déjà engagés, à respecter pour que tes nouvelles questions s'insèrent
  naturellement dans la continuité — sans jamais les répéter ou les paraphraser.
- Si un document est joint, extrais-en les notions clés avant de générer les questions.
- Varie les types (qcm, courte, ouverte, selection) selon la nature de la notion à évaluer.
  ("cours" n'est volontairement pas listé ici : ce n'est pas un type de question
  évaluative mais un bloc de contenu pédagogique — à ne générer que sur demande explicite.)
- Respecte une progression de difficulté : points 1 (mémorisation) → 2 (compréhension) → 3 (application).
- Pour les qcm : 4 propositions exactement (sauf mention contraire), distracteurs plausibles.
- Valide techniquement chaque question avant de l'écrire.`,

    regles: null,  // hérite du MANIFEST

    promptsSuggeres: [
      'Génère 10 questions qcm variées à partir du cours',
      'Crée un mix de 5 qcm, 3 réponses courtes et 2 questions ouvertes',
      'Génère des questions de niveau avancé (points 3) sur les notions complexes',
      'Crée des questions avec indication et explication de correction',
      'Extrait les notions clés du document joint et génère une question par notion',
      'Génère uniquement des questions de type "réponse courte" sur les définitions',
      'Analyse le document joint et génère des questions adaptées au niveau',
      'Compare ce document avec le cours existant et complète les notions manquantes',
    ],

    modele: null,

    // Contrat d'actions (editionParActions actif au niveau MANIFEST) : en création,
    // le LLM n'utilise quasiment que "insert" — cohérent avec systemPrompt
    // ("ne retranscris pas les questions déjà présentes").
    formatReponse: `
== FORMAT DE RÉPONSE ==
Réponds UNIQUEMENT avec un tableau JSON valide d'actions "insert" — une par nouvelle question :
  { "_action": "insert", "_apres": <id> | null | "fin", <tous les champs de la nouvelle ligne> }
- "_apres" = _id de la ligne du CSV "DONNÉES ACTUELLES" après laquelle insérer ; "fin" = à la suite
  de toutes les lignes existantes (cas le plus courant en création) ; null = en tête.
- N'utilise "update"/"delete" que si la demande te demande explicitement de corriger ou retirer
  une ligne existante incohérente — sinon ces actions sont hors sujet en mode création.
- Retourner UNIQUEMENT les clés de colonnes listées ci-dessus (+ "_action"/"_apres").
- Si une valeur est inconnue, utiliser "" (chaîne vide).
- Pas de texte avant ni après. Pas de balises markdown.

Exemple : ajouter 2 nouvelles questions à la suite des lignes existantes :
[
  { "_action": "insert", "_apres": "fin", "type": "qcm", "contenu": "...", "regle": "unique",
    "correction": "auto", "points": "1", "choix": ["A","B","C","D"], "ordre_choix": "aleatoire",
    "choixCorrect": [0] },
  { "_action": "insert", "_apres": "fin", "type": "courte", "contenu": "...", "regle": "texte",
    "correction": "auto", "points": "1", "choixCorrect": ["réponse"] }
]
`,
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
  // 1. Règles déclaratives (nettoyage de base par type — déclaré dans reglesPostProcess.merge)
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

    // ═══════════════════════════════════════════════════════════════════════════════
    // ATTENTION — DÉCISION VOLONTAIRE :
    // Aucune correction d'incohérence n'est appliquée ici pour les champs liés
    // (choix/choixCorrect/regle/correction). Les données douteuses sont conservées
    // telles quelles pour QUE :
    //   1. L'utilisateur voie TOUJOURS ce qu'il a saisi (visible, pas effacé)
    //   2. L'utilisateur reçoive un signal visuel rouge via getInvalidFields s'il y a
    //      une incohérence, mais JAMAIS une correction silencieuse de ses données
    //   3. Le LLM puisse interpréter et corriger l'incohérence lui-même s'il le souhaite
    //   4. XSpro côté serveur fasse la validation finale stricte à l'enregistrement
    //
    // Les validations croisées sont UNIQUEMENT dans getInvalidFields (affichage rouge).
    // ═══════════════════════════════════════════════════════════════════════════════

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
  // Règle conservée pour affichage rouge (via getInvalidFields) mais n'empêche PLUS
  // la validation d'édition — toute modification manuelle est acceptée.
  if (typeKey === 'courte' && cle === 'correction' && row) {
    // Vérification purement informative, ne bloque pas l'édition
  }

  // ouverte : correction dépend de regle (contrainte métier)
  // Règle conservée pour affichage rouge (via getInvalidFields) mais n'empêche PLUS
  // la validation d'édition — toute modification manuelle est acceptée.
  if (typeKey === 'ouverte' && cle === 'correction' && row) {
    const regleLabel = valueToLabel('regle', row.regle) || row.regle;
    const regleStr = String(regleLabel || ' ');
    if (regleStr === 'texte' && checkVal !== 'manuel') {
      // okay — accepté, affiché en rouge par getInvalidFields
    }
    if (regleStr.startsWith('texte(') && checkVal !== 'semi') {
      // okay — accepté, affiché en rouge par getInvalidFields
    }
  }
  // Les validations de valeurs autorisées (allowedLabels) et les validations
  // croisées entre champs ne sont PAS traitées ici : elles ne doivent jamais
  // rejeter une édition manuelle. Elles sont déportées dans getInvalidFields()
  // pour le seul affichage rouge (cf. contrat de validation manuelle, lignes 60-88).
  return { ok: true };
}

function getInvalidFields(row) {
  console.log('[DEBUG-getInvalidFields-START] row.type:', row.type, 'typeKey:', TYPE_INT_TO_KEY[row.type], 'choix:', JSON.stringify(row.choix), 'choixCorrect:', JSON.stringify(row.choixCorrect));
  const typeKey = valueToLabel('type', row.type);
  if (!typeKey) { console.log('[DEBUG-getInvalidFields] typeKey null, skip'); return []; }
  const invalid = [];
  for (const f of ['regle', 'correction', 'ordre_choix', 'points', 'choix', 'choixCorrect']) {
    const res = validateFieldAgainstType(f, row[f], typeKey, row);
    if (!res.ok) invalid.push(f);
  }

  // ── Validations des valeurs autorisées par type (affichage rouge uniquement) ─
  // Ces règles étaient dans validateFieldAgainstType mais y ont été retirées car
  // elles ne doivent JAMAIS rejeter une édition manuelle (cf. contrat lignes 60-88).
  for (const f of ['regle', 'correction', 'ordre_choix']) {
    const allowed = allowedLabels(typeKey, f);
    if (allowed && allowed.length) {
      const val = row[f];
      const label = valueToLabel(f, val) || val;
      if (!isEmptyVal(label) && !allowed.includes(String(label))) {
        invalid.push(f);
      }
    }
  }

  // ── Validations croisées (affichage rouge uniquement, jamais de rejet) ──────
  // Ces règles sont volontairement séparées de validateFieldAgainstType :
  // elles ne doivent pas bloquer l'édition manuelle — seulement la signaler.

  // courte : correction dépend de choixCorrect
  if (typeKey === 'courte') {
    const correctionLabel = valueToLabel('correction', row.correction) || row.correction;
    const cc = row.choixCorrect;
    const ccEmpty = Array.isArray(cc) ? cc.length === 0 : isEmptyVal(cc);
    if (!isEmptyVal(correctionLabel)) {
      if (ccEmpty && (correctionLabel === 'auto' || correctionLabel === 'semi')) {
        invalid.push('correction');
      } else if (!ccEmpty && correctionLabel === 'manuel') {
        invalid.push('correction');
      }
    }
  }

  // ouverte : correction dépend de regle
  if (typeKey === 'ouverte') {
    const correctionLabel = valueToLabel('correction', row.correction) || row.correction;
    const regleLabel = valueToLabel('regle', row.regle) || row.regle;
    const regleStr = String(regleLabel || ' ');
    if (!isEmptyVal(correctionLabel) && !isEmptyVal(regleLabel)) {
      if (regleStr === 'texte' && correctionLabel !== 'manuel') {
        invalid.push('correction');
      } else if (regleStr.startsWith('texte(') && correctionLabel !== 'semi') {
        invalid.push('correction');
      }
    }
  }

  // qcm (1) et Liste de choix (4) : cohérence choix/choixCorrect et règle
  if (typeKey === 'qcm' || typeKey === 'selection') {
    console.log('[DEBUG-getInvalidFields-QCM] row.type:', row.type, 'typeKey:', typeKey);
    console.log('[DEBUG-getInvalidFields-QCM] choix raw:', JSON.stringify(row.choix), 'type:', typeof row.choix, 'isArray:', Array.isArray(row.choix));
    console.log('[DEBUG-getInvalidFields-QCM] choixCorrect raw:', JSON.stringify(row.choixCorrect), 'type:', typeof row.choixCorrect, 'isArray:', Array.isArray(row.choixCorrect));

    const choixArray = Array.isArray(row.choix) ? row.choix : [];
    const choixCorrectArray = Array.isArray(row.choixCorrect) ? row.choixCorrect : [];

    console.log('[DEBUG-getInvalidFields-QCM] choixArray:', JSON.stringify(choixArray), 'length:', choixArray.length);
    console.log('[DEBUG-getInvalidFields-QCM] choixCorrectArray:', JSON.stringify(choixCorrectArray), 'length:', choixCorrectArray.length);

    // Cohérence présence
    if (choixArray.length === 0 && choixCorrectArray.length > 0) {
      console.log('[DEBUG-getInvalidFields-QCM] COHERENCE: choix vide, choixCorrect rempli → PUSH invalid');
      invalid.push('choix');
      invalid.push('choixCorrect');
    } else if (choixArray.length > 0 && choixCorrectArray.length === 0) {
      console.log('[DEBUG-getInvalidFields-QCM] COHERENCE: choix rempli, choixCorrect vide → PUSH invalid');
      invalid.push('choix');
      invalid.push('choixCorrect');
    } else {
      console.log('[DEBUG-getInvalidFields-QCM] COHERENCE: OK ou les deux vides, skip');
    }

    // Vérification que tous les éléments de choixCorrect sont des indices numériques valides
    if (choixCorrectArray.length > 0) {
      const numericChoixCorrect = choixCorrectArray.map(v => Number(v));
      // Un élément non numérique (ex: texte libre "SSID" au lieu d'un indice) ou hors limites
      const hasInvalidIndices = numericChoixCorrect.some(v => isNaN(v) || v < 0 || v >= choixArray.length);
      if (hasInvalidIndices) {
        invalid.push('choixCorrect');
      }
    }

    // Règle unique/multiple vs nombre de réponses
    if (choixCorrectArray.length > 0) {
      const regleLabel = valueToLabel('regle', row.regle) || row.regle;
      if (regleLabel === 'unique' && choixCorrectArray.length !== 1) {
        invalid.push('regle');
        invalid.push('choixCorrect');
      } else if (regleLabel === 'multiple' && choixCorrectArray.length < 1) {
        invalid.push('regle');
        invalid.push('choixCorrect');
      }
    }
  }

  return invalid;
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
  return { ok: true, invalidFields };
}

module.exports = {
  MANIFEST,
  MODES,
  SELECT_CHOIX: buildSelectChoix,
  postProcessDefaults,
  postProcessMerge,
  validateCellEdit,
  getInvalidFields,
  getMissingFields,
};
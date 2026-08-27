/**
 * AI Worker — grid.js
 * Layout deux panneaux : conversation à gauche, grille à droite.
 *
 * Sémantique colonnes :
 *   - rien          → libre, IA et user peuvent modifier
 *   - readOnly:true → IA peut écrire, user NE PEUT PAS modifier manuellement
 *   - placeholder:true → valeur imposée par défaut, IA N'Y TOUCHE PAS, user peut modifier
 *
 * ── DÉCISIONS VOLONTAIRES (ne pas défaire sans validation préalable) ──────────
 * 1. `cellDataType: false` est posé GLOBALEMENT sur toutes les colDefs (une seule
 *    fois, juste avant `return def` dans buildColDefs). Ne pas le retirer ni le
 *    réintroduire localement (selectChoix, colonnes numériques...) : on gère
 *    nous-mêmes formatage/parsing partout (valueFormatter/valueParser/cellEditor),
 *    et laisser AG Grid auto-détecter le type cause soit un rejet silencieux de
 *    saisie ("Data type of the new value does not match..."), soit un affichage
 *    d'erreur ("Invalid Number") sur une valeur vide/blanche. Cf. échanges du
 *    2026-07-14.
 * 2. `formatMultilineForDisplay()` insère un symbole visible (⏎) à chaque saut de
 *    ligne réel dans les champs texte multilignes (contenu, indication...), pour
 *    qu'un saut de ligne volontaire soit visuellement distinct d'un simple
 *    retour automatique (word-wrap) dans une cellule limitée à ~2 lignes.
 *    Pour les champs array (choix, choixCorrect) en revanche, le rendu reste
 *    À PLAT sur une seule ligne : les éléments sont séparés par le même symbole
 *    mais SANS saut de ligne réel, avec troncature "..." (CSS) si trop long.
 *    Affichage UNIQUEMENT — la donnée réelle (édition, envoi serveur, export)
 *    n'est jamais modifiée. Le tooltip (title) affiche le texte sans le symbole.
 * 3. `champsIndexRef` (déclaré par la vue dans MANIFEST, ex: { choixCorrect: 'choix' })
 *    signale qu'un champ array contient des INDICES numériques référençant un autre
 *    champ array de la même ligne. Stockage/LLM = indices (inchangé, pour éviter
 *    qu'un LLM ne propose un texte ne correspondant pas exactement à un choix) ;
 *    édition/affichage = texte résolu, purement côté client (TextareaCellEditor +
 *    cellRenderer). Générique : aucun nom de champ en dur ici, piloté par la
 *    déclaration de la vue.
 * 4. `TextareaCellEditor.getValue()` produit directement le type final stocké (tableau
 *    pour les champs `champsArray`, indices pour `champsIndexRef`) — il ne délègue PAS
 *    cette conversion à `colDef.valueParser`. Constaté empiriquement (traces console,
 *    2026-07-15) : AG Grid n'invoque pas `valueParser` de façon fiable avec un
 *    cellEditor personnalisé (l'éditeur de type texte/textarea) — `params.newValue`
 *    dans `onCellValueChanged` restait la string brute de l'éditeur, jamais convertie
 *    en tableau, cassant silencieusement tout ce qui dépend de la structure du champ
 *    (ex: résolution d'indices de choixCorrect). `valueParser` reste défini en filet de
 *    sécurité (il gère déjà le cas où la valeur est déjà un tableau) mais ne doit pas
 *    être le seul mécanisme de conversion pour ces champs.
 * 5. AUCUNE logique croisée entre deux champs métier (ex: réconcilier "choixCorrect"
 *    quand "choix" change) ne doit vivre ici, même codée "juste pour ce cas" — grid.js
 *    ne doit jamais connaître de nom de champ métier. Ce genre de règle est calculée
 *    par le hook vue (validateCellEdit) et exposée via un champ générique `sideEffects`
 *    dans sa réponse ; server.js l'applique et la notifie génériquement (cell:update)
 *    sans connaître les noms de champs non plus. Si un besoin similaire apparaît pour
 *    un autre champ, il se déclare dans le hook (ex: MANIFEST.champsIndexRef), jamais
 *    par un `if (cle === '...')` ici. Un tel code a été introduit puis retiré le
 *    2026-07-15 — ne pas le réintroduire sans passer par ce mécanisme.
 * 6. `labelParType` — surcharge d'AFFICHAGE d'un libellé selectChoix selon le type de la ligne.
 *    Un choix peut déclarer `labelParType: { <indice type>: <libellé> }` (déclaré par la vue dans
 *    buildSelectChoix, ex: la règle 'texte' qui s'affiche "Atelier" sur les questions ouvertes).
 *    Consommé GÉNÉRIQUEMENT ici par `libelleChoixPourType()` dans valueFormatter (cellule) et
 *    getOptionLabel (dropdown). C'est du RENDU uniquement : la valeur stockée, le label contractuel
 *    (sendLabel → LLM), les restrictions (champsRestreints) et l'export restent strictement inchangés.
 *    Purement déclaratif et piloté par la vue — grid.js ne connaît aucun nom de champ métier ici,
 *    dans le même esprit que champsRestreints/champsIndexRef.
 * ──────────────────────────────────────────────────────────────────────────────
 */

'use strict';

   // ── État local ────────────────────────────────────────────────────────────────
 const state = {
   sessionId:     null,
   ws:            null,
   gridApi:       null,
   mode:          'plan',
   status:        'idle',
   workerConfig:  null,
   rows:          [],
   selectChoix:   {},
   champsRestreints: {},       // { [champ]: { [valeurType]: [valeursAutorisees] } } — restreint les dropdowns selon le type de la ligne (jamais 'type' lui-même)
   champsNonApplicables: {},   // { [valeurType]: [champs] } — champs hors sujet pour ce type : grisés ET non éditables (cf. views/formulaireListeQuestions.js CHAMPS_NON_APPLICABLES)
   modes:         {},          // modes de travail (définis par le hook vue)
   activeWorkMode: null,       // ID du mode de travail actif (ex: 'decomposition')
   basePromptsSuggeres: null,  // promptsSuggeres originaux (XSpro ou MANIFEST) pour restauration
   rowStyles:     [],           // styles de ligne définis par le hook vue
   isAiRunning:   false,
   updatedCells:  0,
   totalCells:    0,
   attachedFiles: [],
   userScrolled:  false,
   providerId:     'openai',
   acceptString:   '*/*',
   supportedTypes: [],
   defaultModeApplied: false,   // flag pour appliquer le mode par défaut au premier onGridReady
   colonnesDerivees: {},        // { [modeId]: { [champ]: { libelle } } } — reçu du serveur (sans les fonctions)
   derivedFormulas: {},         // formules du mode actif : { [champ]: formatter } — définies localement
   colonnesDeriveesKeys: null,  // Set des clés des colonnes dérivées du mode actif
   vuePromptDemandee:  null,    // 'envoye' | 'pret' — consultation demandee, en attente du serveur
   vuePromptCourante:  null,    // { libelle, texte } — ce qu'affiche la fenetre, donc ce que copie le bouton
   unEnvoiAEuLieu:     false,   // conditionne l'entree « prompt envoye » du menu (rien a montrer avant)
   lastPromptPreview:  null,    // { system, full } — dernier apercu recu du serveur
   styleOverrides:     {},      // { [rowIndex]: { color?, bgColor?, className? } } — surcharge via cell:rowStyle
   cellStyleOverrides: {},      // { "rowIndex:cle": { ... } } — surcharge cellule via cell:validate
   onCellEdit:         null,    // callback(rowIndex, cle, newValue) définie par la vue
   reviewMode:         false,   // mode revue par pending actif pour cette vue (cf. MANIFEST.revueParPending)
   pendingCount:       0,       // nombre de lignes portant une proposition IA en attente (mode revue)
   reviewFiltrePendingSeul: false, // filtre "en attente seulement" de la barre de revue
 };

// Comparaison de valeur "légère" (pas de deep-equal générique) — traite le cas des champs array
// (choix, choixCorrect) élément par élément plutôt que par référence : un tableau reconstruit par
// le cellEditor avec exactement le même contenu qu'avant n'est JAMAIS === à l'ancien tableau, ce
// qui ferait sinon considérer à tort qu'un simple clic entrer/sortir d'une cellule sans rien
// modifier est une vraie édition. Miroir de la même comparaison côté serveur (sessionManager.js).
function valuesEqual(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

// ── Init ──────────────────────────────────────────────────────────────────────
console.log('[Grisage] grid.js chargé — build avec grisage des champs non applicables (2026-07-30)');

document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  state.sessionId = params.get('sessionId');
  if (!state.sessionId) { addMessage('error', '⚠ sessionId manquant dans l\'URL.'); return; }
  bindUI();
  connectWS();
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS() {
  const wsUrl = `ws://${window.location.host}/ws?sessionId=${state.sessionId}`;
  addMessage('system', 'Connexion au Worker…');
  state.ws = new WebSocket(wsUrl);
  state.ws.onopen    = () => addMessage('system', 'Connecté — chargement des données…');
  state.ws.onmessage = (e) => { try { handleWSMessage(JSON.parse(e.data)); } catch {} };
  state.ws.onclose   = () => { addMessage('system', 'Connexion fermée.'); setStatusBadge('idle', 'Déconnecté'); };
  state.ws.onerror   = () => addMessage('error', '⚠ Erreur WebSocket — rechargez la page.');
}

// ── Dispatcher WS ─────────────────────────────────────────────────────────────
function handleWSMessage(msg) {
  switch (msg.type) {
    case 'init':              onInit(msg);                                    break;
    case 'status':            onStatusChange(msg.status);                    break;
    case 'plan':              onPlanReceived(msg.plan);                      break;
    case 'cell:update':       onCellUpdate(msg.rowIndex, msg.cle, msg.value); break;
    case 'cell:revert':       onCellRevert(msg.rowIndex, msg.cle, msg.value, msg.message); break;
    case 'cell:rowStyle':     onRowStyle(msg.rowIndex, msg.style);           break;
    case 'cell:validate':    onRowValidate(msg);                           break;
    case 'act:done':          onActDone(msg.rows, msg.pendingCount, msg.actionsResume, msg.rapport); break;
    case 'review:sync':      onReviewSync(msg);                            break;
    case 'rows:moved':       onRowsMoved(msg);                             break;
    case 'export:ready':      onExportReady(msg);                            break;
    case 'session:done':      onSessionDone(msg.exportFallback);            break;
    case 'session:cancelled': onSessionCancelled();                         break;
    case 'session:newtask':
      addMessage('system', '↺ Nouvelle tâche — historique effacé. Tu peux continuer à travailler sur les données.');
      setStatusBadge('connected', 'Prêt');
      setStatusMessage('Prêt');
      state.updatedCells = 0;
      state.totalCells = 0;
      // Re-afficher le message d'accueil
      const inner = el('conversation-inner');
      const welcome = document.createElement('div');
      welcome.className = 'conv-welcome';
      welcome.innerHTML = '<div class="conv-welcome-icon">⚡</div><div class="conv-welcome-text">Décris ce que tu veux faire avec les données.<br/>L\'IA remplira la grille en temps réel.</div>';
      inner.insertBefore(welcome, inner.firstChild);
      break;
    case 'prompt:preview':    onPromptPreview(msg);                         break;
    case 'prompt:dernierEnvoi': onPromptDernierEnvoi(msg);                  break;
    case 'error': {
      // Message d'erreur enrichi avec cause, suggestion, httpStatus
      let displayMsg = `⚠ ${msg.message}`;
      if (msg.cause) {
        displayMsg += `\n   Cause : ${msg.cause}`;
      }
      if (msg.suggestion) {
        displayMsg += `\n   Suggestion : ${msg.suggestion}`;
      }
      if (msg.httpStatus) {
        displayMsg += `\n   HTTP ${msg.httpStatus}`;
      }
      if (msg.timeoutMs) {
        displayMsg += `\n   Timeout : ${msg.timeoutMs / 1000}s`;
      }
      addMessage('error', displayMsg);
      onStatusChange('error');
      break;
    }
    default: console.warn('[WS] inconnu :', msg.type);
  }
}

// ── Normalisation des lignes reçues du serveur ────────────────────────────────
// XSpro envoie certains champs à liste de choix en CODE TEXTE ("cours", "qcm"), voire
// en libellé d'affichage ("Cours"), alors que l'UI les manipule en INDICE numérique :
// c'est l'indice que reconnaissent les dropdowns AG Grid, et surtout les tables
// champsNonApplicables / champsRestreints, toutes deux indexées par la valeur numérique
// du type (cf. isFieldNonApplicable).
// À rejouer sur CHAQUE lot de lignes reçu, pas seulement à l'init : le serveur renvoie
// `type` en code texte (il ne le normalise plus, pour ne pas écraser les types non-QCM
// proposés par l'IA), donc sans cette passe le grisage, la restriction des listes
// déroulantes et les rowStyles cessaient de fonctionner dès la première requête IA.
const STR_TO_IDX_PAR_CHAMP = {
  type: {
    'qcm': 1, 'courte': 2, 'ouverte': 3, 'selection': 4, 'cours': 5,
    'QCM': 1, 'Réponse courte': 2, 'Texte long': 3, 'Liste de choix': 4, 'Cours': 5,
    '': 0, ' ': 0
  },
  regle:       { 'validation': 1, 'unique': 2, 'multiple': 3, 'texte': 4, 'texte(10)': 5, 'nombre': 6, '': 0, ' ': 0 },
  correction:  { 'auto': 1, 'manuel': 2, 'semi': 3, '': 0, ' ': 0 },
  ordre_choix: { 'aleatoire': 1, 'fixe': 2, '': 0, ' ': 0 },
};

function normaliserLignesEntrantes(rows) {
  // On MÉMORISE quels champs ont réellement été convertis : cette conversion n'existe
  // que pour l'affichage, et doit être défaite symétriquement avant tout renvoi au
  // serveur — sans quoi XSpro reçoit un indice là où il a envoyé un code texte, et son
  // parse() le rejette (cf. valeurPourServeur/rowsPourServeur plus bas).
  if (!state.champsConvertisEnIndice) state.champsConvertisEnIndice = new Set();
  for (const row of rows || []) {
    for (const [cle, strToIdx] of Object.entries(STR_TO_IDX_PAR_CHAMP)) {
      if (row[cle] !== undefined && typeof row[cle] === 'string' && strToIdx[row[cle]] !== undefined) {
        row[cle] = strToIdx[row[cle]];
        state.champsConvertisEnIndice.add(cle);
      }
    }
  }
  return rows;
}

// ── Résolution d'affichage des champs champsIndexRef (ex: choixCorrect → choix) ──
// Selon la provenance des données (payload XSpro sérialisé au format export, réponse
// LLM avant normalisation complète, état transitoire d'édition), la donnée peut
// arriver sous deux formes dégradées que le rendu doit savoir résoudre SANS jamais
// modifier la donnée stockée ni renvoyée au serveur :
//   1. le champ de référence (choix) lui-même arrive en STRING (<br> ou \n séparé)
//      au lieu d'un array — on le découpe alors pour l'affiche ;
//   2. la valeur (choixCorrect) arrive en STRING d'indice ("0", "2") au lieu du
//      nombre 0, 2 — on la normalise pour résoudre l'indice.
// La correspondance est EXACTE (seuls les espaces avant/après sont ignorés) et ne
// s'applique que si l'indice est un entier valide DANS LES BORNES du tableau de
// référence et pointe vers une entrée non vide — un texte libre (réponse courte
// valant littéralement "2", ou texte non encore résolu en indice) ressort tel quel,
// jamais interprété comme indice ni perdu (la validation rouge getInvalidFields le
// signale ensuite). La donnée réelle n'est jamais modifiée.
function refArrayPourAffichage(refValue) {
  if (Array.isArray(refValue)) return refValue;
  if (typeof refValue === 'string' && refValue.trim() !== '') {
    return refValue.split(/<br\s*\/?>|\r?\n/i).map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function resoudreIndexPourAffichage(valeur, refArray) {
  const arr = Array.isArray(refArray) ? refArray : [];
  const n = typeof valeur === 'number'
    ? valeur
    : (typeof valeur === 'string' && /^-?\d+$/.test(valeur.trim()) ? Number(valeur.trim()) : NaN);
  if (Number.isInteger(n) && n >= 0 && n < arr.length &&
      arr[n] !== null && arr[n] !== undefined && String(arr[n]).trim() !== '') {
    return arr[n];
  }
  return valeur;
}

// ── Init ──────────────────────────────────────────────────────────────────────
function onInit(msg) {
  state.workerConfig = msg.workerConfig;
  state.rows         = msg.rows || [];

  // Mode revue par pending (cf. viewResolver.js MANIFEST.revueParPending) : un seul mode
  // d'exécution direct, sélecteur Plan/Act masqué — les propositions IA arrivent en
  // attente (surlignage + ✓/✗) plutôt que d'écraser directement les données.
  state.reviewMode   = !!msg.reviewMode;
  state.pendingCount = msg.pendingCount || 0;
  if (state.reviewMode) { hide('mode-selector'); state.mode = 'act'; }
  else { show('mode-selector'); }

  console.log('[Payload XSpro]', msg.xsproPayload);

  // Lien "Config IA" (⚙, bandeau) : visible seulement en standalone — sans effet et
  // donc sans intérêt sur une session pilotée par XSpro, qui envoie toujours son
  // propre bloc IA (cf. standalone/ia-config.json, server.js startStandaloneMode).
  const lienConfigIa = el('lien-config-ia');
  if (lienConfigIa) {
    lienConfigIa.classList.toggle('hidden', msg.origin !== 'standalone');
    // Fait suivre l'URL courante (sessionId inclus) pour que le lien "← Retour à la
    // grille" d'ia-config.html puisse revenir à CETTE session, pas à /index.html nu
    // (que grid.js refuse avec "⚠ sessionId manquant dans l'URL.").
    lienConfigIa.href = '/ia-config.html?retour=' + encodeURIComponent(window.location.href);
  }

  document.title                 = `AI Worker — ${msg.contextName}`;
  el('context-name').textContent = msg.contextName;

  const p = msg.infosParent || {};
  if (p.client)  el('info-client').textContent  = `👤 ${p.client}`;
  if (p.affaire) el('info-affaire').textContent = `📁 ${p.affaire}`;
  if (p.client && p.affaire) show('info-sep');

  // Modele LLM annonce par le serveur — sert a nommer l'auteur du traitement dans le
  // bandeau et le fil de conversation, comme le fait XSpro dans son spinner.
  state.modeleIA      = msg.modeleIA      || null;

  // Affiche des l'ouverture le nom du LLM dans un badge permanent de l'en-tete,
  // pas uniquement pendant/reve en cours de requete. onInit etant aussi appele
  // sur session:reset, le badge reste syncronise si le modele change.
  updateModelBadge();

  // Provider et types de fichiers acceptés
  state.providerId    = msg.providerId    || 'openai';
  state.acceptString  = msg.acceptString  || '*/*';
  state.supportedTypes = msg.supportedTypes || [];

  // Modes de travail (définis par le hook vue)
  state.modes = msg.modes || {};

  // Sauvegarder les promptsSuggeres de base (XSpro ou MANIFEST) pour restauration
  state.basePromptsSuggeres = msg.workerConfig?.promptsSuggeres || null;

  // Remplir le sélecteur de mode de travail
  populateWorkModeSelector(state.modes);

  // Remplir les suggestions de prompts (initiales)
  populatePromptSuggestions(state.basePromptsSuggeres);

  // Afficher le prompt XSpro dans la zone de saisie
  if (msg.workerConfig?.prompt) {
    el('prompt-input').value = msg.workerConfig.prompt;
  }
  // Mettre à jour l'état du bouton send (au cas où le prompt est rempli automatiquement)
  updateSendButtonState();

  // SelectChoix pour les dropdowns
  state.selectChoix = msg.selectChoix || {};
  // Restriction des dropdowns selon le type de la ligne (jamais 'type' lui-même)
  state.champsRestreints = msg.champsRestreints || {};
  // Champs hors sujet pour le type de la ligne — grisés ET non éditables (cf. buildColDefs)
  state.champsNonApplicables = msg.champsNonApplicables || {};
  console.log('[Grisage] champsNonApplicables reçu à l\'init :', JSON.stringify(state.champsNonApplicables));

  // Styles de ligne définis par le hook vue
  state.rowStyles = msg.rowStyles || [];

  // Conversion des valeurs string → indice numérique pour les champs avec selectChoix
  // XSpro envoie des strings comme "cours", "qcm" ou aussi les labels français
  // (ex: "Cours" depuis le payload), il faut les convertir en indices numériques
  // pour que AG Grid les reconnaisse dans les dropdowns.
  normaliserLignesEntrantes(state.rows);

  // Colonnes dérivées (formules de calcul)
  state.colonnesDerivees = msg.colonnesDerivees || {};
  // Initialiser les formules du mode actif
  const modeId4 = state.activeWorkMode || 'standard';
  // Convertir les `code` strings en fonctions via new Function('row', 'selectChoix', code)
  const rawModeFormulas = state.colonnesDerivees[modeId4] || {};
  state.derivedFormulas = {};
  for (const [champ, formula] of Object.entries(rawModeFormulas)) {
    if (typeof formula.code === 'string') {
      try {
        state.derivedFormulas[champ] = new Function('row', 'selectChoix', formula.code);
      } catch (e) {
        console.warn(`[Grid] Erreur création fonction dérivée "${champ}":`, e.message);
        state.derivedFormulas[champ] = null;
      }
    }
  }
  state.colonnesDeriveesKeys = new Set(Object.keys(state.derivedFormulas).filter(k => state.derivedFormulas[k]));

  // Appliquer l'accept dynamique au file input
  el('file-input').setAttribute('accept', state.acceptString);

  // Mettre à jour le tooltip du bouton d'attachement
  const typesLabel = state.supportedTypes.length
    ? `Joindre un fichier (${state.supportedTypes.join(', ')})`
    : 'Joindre un fichier';
  el('btn-attach').setAttribute('title', typesLabel);

  updateRowCount();
  el('conversation-inner').innerHTML = '';

  if (state.gridApi) {
    // Grille existante (après reset) : détruire et recréer pour réinitialiser complètement
    state.gridApi.destroy();
    state.gridApi = null;
  }
  // (re)création de la grille
  initGrid(msg.workerConfig.colonnes, state.rows);

  addMessage('system', `Données chargées (${state.rows.length} lignes) — prêt.`);
  setStatusBadge('connected', 'Prêt');
  setStatusMessage('Prêt');
  setAiRunning(false);
  scrollToBottom(true);
  updateReviewToolbar();
}

// ── Évaluation conditions rowStyles ───────────────────────────────────────────
/**
 * Évalue une condition { champ, op, valeur? } sur une row.
 * Même logique que evalCondition dans detailsDevis.js.
 */
function evalRowStyleCondition(row, cond) {
  if (!cond) return true;
   const { champ, op, valeur } = cond;
   const val = row[champ];
   // Toute chaîne blanche ('', ' ', '  ', '\t'...) est considérée comme vide —
   // les valeurs "non renseignées" peuvent arriver avec différentes variantes d'espaces.
   const isEmpty = (typeof val === 'string' && val.trim() === '') || val === null || val === undefined || Number(val) === 0;

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

// ── AG Grid ───────────────────────────────────────────────────────────────────
function initGrid(colonnes, rows) {
  const gridOptions = {
    columnDefs:   buildColDefs(colonnes),
    rowData:      rows,
    // Identité stable par _id (présent sur toute row, cf. sessionManager.createSession) :
    // sans ça, chaque remplacement de rowData (onReviewSync/onActDone/onRowsMoved — le
    // serveur renvoie systématiquement des OBJETS RECRÉÉS via JSON, jamais les mêmes
    // références) fait perdre la sélection et le focus, puisqu'AG Grid ne peut alors
    // matcher les nouvelles lignes aux anciens row nodes que par référence d'objet.
    // Cf. déplacement de lignes (▲/▼/"Déplacer ici") : sans getRowId, la sélection
    // déplacée disparaissait à chaque clic, rendant impossible de suivre un bloc sur
    // plusieurs crans.
    getRowId: (params) => String(params.data._id),
    rowHeight:    40,  // Hauteur fixe pour toutes les lignes (1,5x la hauteur standard)
    headerHeight: 32,
    defaultColDef: {
      resizable: true, sortable: false, filter: false,
      cellStyle: { fontSize: '12px' },
      suppressKeyboardEvent: (params) => {
        const currentRowIndex = params.node?.rowIndex ?? params.api.getFocusedCell()?.rowIndex;
        // Bloquer la touche ArrowUp si on est sur la première ligne
        if (params.event.key === 'ArrowUp' && currentRowIndex === 0) {
          return true;
        }
        // Intercepter Delete/Backspace pour gérer manuellement l'effacement
        // sans déplacement de focus (comme Excel)
        if (params.event.key === 'Delete' || params.event.key === 'Backspace') {
          // Effacer la valeur de la cellule
          const rowIndex = params.node?.rowIndex;
          const colId = params.column?.getColId();
          if (rowIndex !== undefined && colId && state.rows[rowIndex]) {
            // Générique : un champ array se vide en [] et non '', sinon AG Grid re-détecte
            // un type incohérent. Toute conséquence sur d'autres champs (ex: un champ qui
            // référence celui-ci via champsIndexRef) est calculée et notifiée par le serveur
            // (cell:update générique) — grid.js n'a pas à connaître cette relation.
            const champsArray = state.workerConfig?.champsArray || [];
            const emptyValue = champsArray.includes(colId) ? [] : '';
            state.rows[rowIndex][colId] = emptyValue;
            const node = params.node;
            if (node) {
              node.setDataValue(colId, emptyValue);
// Flash manuel sur la bonne colonne (plus de enableCellChangeFlash)
               state.gridApi.flashCells({ rowNodes: [node], columns: [colId], flashDuration: 150, fadeDuration: 400 });
            }
            // Envoyer la modification au serveur
            sendWS({ type: 'cell:edit', rowIndex, cle: colId, value: emptyValue });
          }
          // Bloquer le comportement par défaut (AG Grid déplacerait le focus)
          return true;
        }
        return false;
      },
    },
    rowSelection:            'multiple',
    suppressRowClickSelection: true,
    suppressMovableColumns:  true,
    enableCellTextSelection: true,

    onGridReady: () => {
      // Focus sur la première cellule au chargement de la grille
      if (state.rows.length > 0 && state.workerConfig?.colonnes?.[0]) {
        state.gridApi.setFocusedCell(0, state.workerConfig.colonnes[0].cle);
      }
      // Appliquer le mode par défaut au premier onGridReady
      if (!state.defaultModeApplied) {
        state.defaultModeApplied = true;
        const modes = state.modes || {};
        const defaultModeId = resolveDefaultModeId(modes);
        const defaultMode = defaultModeId ? modes[defaultModeId] : null;

        if (defaultMode) {
          state.activeWorkMode = defaultModeId;
          // Appliquer les surcharges du mode par défaut (colonnes, visibilité, prompts)
          onWorkModeChange(defaultModeId);
        }
      }
    },
    
    // Filtre "en attente seulement" de la barre de revue (mode revueParPending).
    // API de filtre externe d'AG Grid — aucun autre filtre n'est utilisé dans ce
    // projet, donc pas de conflit possible avec un filtre de colonne.
    isExternalFilterPresent: () => state.reviewMode && state.reviewFiltrePendingSeul,
    doesExternalFilterPass: (node) => hasPendingMarkerClient(node.data),

    onCellFocused: (params) => {
      // Rediriger le focus si on arrive sur le header (rowIndex négatif)
      const colId = params.previousColumn?.getColId() || params.column?.getColId() || state.workerConfig?.colonnes?.[0]?.cle;
      if (params.rowIndex < 0 && state.rows.length > 0 && colId) {
        setTimeout(() => {
          state.gridApi.setFocusedCell(0, colId);
        }, 0);
      }
      // Indicateur "Ligne X / N" de la barre d'outils — c'est ici qu'il se met a jour,
      // au clic comme aux fleches du clavier.
      updateRowCount();
      // Compteur positionnel "Ligne X sur Y" du bandeau de revue — doit suivre aussi les
      // clics directs dans la grille, pas seulement les boutons ⏮/⏭.
      if (state.reviewMode) updateReviewToolbar();
    },

    onCellValueChanged: (params) => {
      console.log(`[DEBUG-GRID] onCellValueChanged source="${params.source}" cle="${params.column.getColId()}" newValue="${JSON.stringify(params.newValue)}" oldValue="${JSON.stringify(params.oldValue)}"`);
      // Ne pas traiter les changements émis par node.setDataValue() (source 'api'), ni un
      // "changement" qui n'en est pas un (entrer/sortir d'une cellule sans rien modifier —
      // cf. valuesEqual : comparaison élément-par-élément pour les champs array comme
      // choix/choixCorrect, qui sont reconstruits en un nouvel objet à chaque édition et ne
      // sont donc jamais === à l'ancien même à contenu identique).
      if (params.source !== 'api' && !valuesEqual(params.newValue, params.oldValue)) {
        const rowIndex = params.node.rowIndex;
        const cle      = params.column.getColId();
        if (state.rows[rowIndex]) {
          // Le dropdown produit l'indice d'affichage : le reconvertir en code texte pour
          // le serveur si ce champ avait été converti à l'entrée (cf. valeurPourServeur).
          const valeurServeur = valeurPourServeur(cle, params.newValue);
          console.log(`[DEBUG-GRID] envoie cell:edit rowIndex=${rowIndex} cle="${cle}" value="${JSON.stringify(valeurServeur)}"`);
          sendWS({ type: 'cell:edit', rowIndex, cle, value: valeurServeur });
state.gridApi.flashCells({ rowNodes: [params.node], columns: [cle], flashDuration: 150, fadeDuration: 400 });

          // Plus besoin de recalcul de hauteur - hauteur fixe de 40px pour toutes les lignes
          // Forcer le redessin pour appliquer les modifications
          state.gridApi.redrawRows({ rowNodes: [params.node] });
          // Filet de sécurité : force la ré-exécution du cellRenderer personnalisé
          // (symbole ⏎, troncature array...) avec la valeur à jour, au cas où redrawRows
          // seul ne suffise pas à rafraîchir l'affichage après une resaisie.
          state.gridApi.refreshCells({ rowNodes: [params.node], columns: [cle], force: true });
        }
      } else {
        console.log(`[DEBUG-GRID] source="${params.source}" ou valeur inchangée → cell:edit non envoyé`);
      }
      // Callback défini par la vue (ex: recalcule du style après édition)
      if (state.onCellEdit) state.onCellEdit(params);
      // Recalculer les colonnes dérivées si des formules existent
      if (Object.keys(state.derivedFormulas).length > 0) {
        state.gridApi.redrawRows({ rowNodes: [params.node] });
      }
    },

    onSelectionChanged: () => {
      const selected = state.gridApi.getSelectedRows();
      el('btn-delete-rows').disabled = selected.length === 0 || state.isAiRunning;
      updateMoveButtonsState();
    },

    getRowStyle: (params) => {
      const row = params.data;
      const rowIndex = params.node.rowIndex;
      // Mode revue : teinte de ligne pour une insertion/suppression en attente de
      // validation (manuelle ou IA) — priorité la plus haute (l'info la plus
      // importante). Teintes franches et non pastel : la version précédente
      // (#F0FFF4/#FFF5F5, quasi blanches) ne se voyait pas d'un coup d'œil.
      if (state.reviewMode && row) {
        if (row.__pendingInsert) return { background: '#C6F6D5', borderLeft: '4px solid #276749' };
        if (row.__pendingDelete) return { background: '#FED7D7', borderLeft: '4px solid #9B2335', textDecoration: 'line-through' };
      }
      // Surcharge dynamique via cell:rowStyle (priorité la plus haute)
      const override = state.styleOverrides?.[rowIndex];
      if (override) {
        return override;
      }
      // rowStyles définis par la vue (msg.init → state.rowStyles)
      if (state.rowStyles && state.rowStyles.length > 0) {
        for (const rule of state.rowStyles) {
          if (evalRowStyleCondition(row, rule.si)) {
            return rule.style;
          }
        }
      }
      return null;
    },

    getRowClass: (params) => {
      // Ajout d'une classe pour les niveaux >= 2 (pour CSS fontWeight)
      const row = params.data;
      if (row && Number(row.niveauListe) > 1) {
        return 'row-level-gte-2';
      }
      return null;
    },

  };

  state.gridApi = agGrid.createGrid(el('grid-container'), gridOptions);
}

// ── Éditeur de cellule multiligne (textarea popup) ──────────────────────────────
// Entrée simple = saut de ligne dans la textarea.
// Shift+Entrée / Échap = validation et sortie (laisse AG Grid gérer).
// Hauteur popup : 60px (4 lignes) avec resize vertical possible.
// ── Affichage des retours à la ligne dans les cellules ────────────────────────
// Les champs multilignes stockent leurs sauts de ligne en <br> (contenu, indication...)
// ou en \n brut selon le champ. Dans une cellule limitée à ~2 lignes, un saut de ligne
// volontaire est visuellement indiscernable d'un simple retour automatique (word-wrap).
// On matérialise donc chaque saut de ligne par un symbole visible (⏎) — purement pour
// l'affichage : la donnée réelle (envoyée au serveur, à l'édition, à l'export) n'est
// jamais modifiée, seul le rendu HTML de la cellule en tient compte.
function formatMultilineForDisplay(text) {
  return String(text)
    .replace(/<br\s*\/?>/gi, '\n')   // normaliser <br> → \n
    .split('\n')
    .join(' ⏎<br>');                // symbole visible + vrai saut de ligne pour le rendu
}

function TextareaCellEditor() {}
TextareaCellEditor.prototype.init = function(params) {
  this.textarea = document.createElement('textarea');

  // Champ dont les valeurs sont des indices numériques référençant un autre champ array
  // de la même ligne (ex: choixCorrect → choix, cf. MANIFEST.champsIndexRef côté vue).
  // Édition = texte résolu (lisible) ; stockage/LLM = indices (cf. getValue ci-dessous).
  const cle = params.colDef?.field;
  const refField = state.workerConfig?.champsIndexRef?.[cle];
  this.indexRefArray = refField ? refArrayPourAffichage(params.data?.[refField]) : null;
  // Champ array "simple" (choix...) : AG Grid n'invoque pas colDef.valueParser de façon
  // fiable avec un cellEditor personnalisé (constaté : newValue reste une string brute
  // dans onCellValueChanged). getValue() produit donc directement le tableau final —
  // on ne dépend plus de valueParser pour la conversion.
  this.isArrayField = !refField && !!state.workerConfig?.champsArray?.includes(cle);

  // Gestion spéciale pour les arrays (choix, choixCorrect) : convertir en string avec \n
  let initialValue;
  if (this.indexRefArray) {
    // Résoudre chaque valeur pour l'édition : un indice numérique (OU string d'indice,
    // cf. resoudreIndexPourAffichage) valide se résout en texte via refField ; une
    // valeur déjà en texte brut (non encore résolue — état transitoire normal, cf.
    // computeIndexRefSideEffects) s'affiche telle quelle.
    const values = Array.isArray(params.value) ? params.value : (params.value == null ? [] : [params.value]);
    initialValue = values
      .map(v => String(resoudreIndexPourAffichage(v, this.indexRefArray)))
      .filter(v => v !== undefined && v !== null)
      .join('\n');
  } else if (params.value == null) {
    initialValue = '';
  } else if (Array.isArray(params.value)) {
    initialValue = params.value.join('\n');
  } else {
    initialValue = String(params.value);
  }
  this.textarea.value = initialValue;
  this.textarea.style.width = '300px';
  this.textarea.style.height = '120px';
  this.textarea.style.minHeight = '120px';
  this.textarea.style.maxHeight = '300px';
  this.textarea.style.boxSizing = 'border-box';
  this.textarea.style.fontSize = '12px';
  this.textarea.style.resize = 'both';
  this.textarea.style.border = '1px solid #888';
  this.textarea.style.minWidth = '300px';
  this.textarea.style.maxWidth = '500px';
  this.textarea.style.outline = 'none';
  this.textarea.style.padding = '4px';
  this.textarea.style.overflow = 'auto';
  // Entrée = saut de ligne (pas de sortie)
  // Suppr/Backspace = effacement dans la textarea (pas de sortie de cellule)
  this.textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.stopPropagation();
      e.preventDefault();
      const start = this.textarea.selectionStart, end = this.textarea.selectionEnd;
      const v = this.textarea.value;
      this.textarea.value = v.slice(0, start) + '\n' + v.slice(end);
      this.textarea.selectionStart = this.textarea.selectionEnd = start + 1;
    }
    // Bloquer Suppr/Backspace pour éviter la sortie de cellule
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.stopPropagation();
      // Laisser AG Grid gérer l'effacement dans la textarea
    }
    // Shift+Entrée ou Échap → laisser AG Grid valider/sortir
  });
  // Focus initial sans auto-expansion
  setTimeout(() => { this.textarea.focus(); }, 0);

  // Filet de sécurité : AG Grid ne détecte pas toujours de façon fiable un clic
  // "extérieur" comme devant valider la cellule — notamment quand le clic tombe
  // dans la cellule d'origine (souvent plus large que le textarea popup) plutôt
  // que sur une autre cellule du tableau. On écoute nous-mêmes tout mousedown hors
  // du textarea, où qu'il tombe, pour forcer la validation.
  this.onDocumentMouseDown = (e) => {
    if (!this.textarea || this.textarea.contains(e.target)) return;
    params.api.stopEditing();
  };
  // Enregistré après un court délai pour ne pas intercepter le mousedown qui vient
  // d'ouvrir cet éditeur (même événement, encore en cours de propagation).
  setTimeout(() => {
    document.addEventListener('mousedown', this.onDocumentMouseDown, true);
  }, 0);
};
TextareaCellEditor.prototype.autoGrow = function() {
  // Fonction conservée pour compatibilité mais non utilisée
};
TextareaCellEditor.prototype.getGui = function() { return this.textarea; };
TextareaCellEditor.prototype.getValue = function() {
  if (this.indexRefArray) {
    // Reconvertir chaque ligne de texte saisie en indice correspondant dans refField
    // (recherche exacte, espaces ignorés). Une ligne sans correspondance est conservée
    // en TEXTE BRUT (pas abandonnée) — état transitoire normal pendant la construction
    // manuelle d'une question (ex: taper la bonne réponse avant que tous les choix ne
    // soient saisis) ; l'incohérence est signalée en rouge par getInvalidFields côté vue,
    // et la résolution finale texte → indice peut aussi être prise en charge par le LLM.
    return this.textarea.value
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean)
      .map(text => {
        const idx = this.indexRefArray.findIndex(v => String(v).trim() === text);
        return idx !== -1 ? idx : text;
      });
  }
  if (this.isArrayField) {
    // Un élément par ligne — produit directement le tableau final stocké/envoyé.
    return this.textarea.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  }
  return this.textarea.value;
};
TextareaCellEditor.prototype.isPopup = function() { return true; };
TextareaCellEditor.prototype.focusIn = function() { this.textarea.focus(); };
TextareaCellEditor.prototype.destroy = function() {
  if (this.onDocumentMouseDown) document.removeEventListener('mousedown', this.onDocumentMouseDown, true);
  this.textarea = null;
};

// ── Éditeur personnalisé pour dropdowns dont le libellé dépend du type de ligne ──
// Remplace agSelectCellEditor sur les colonnes selectChoix qui portent au moins une
// surcharge `labelParType` (aujourd'hui la règle 'texte' → 'Atelier' sur les questions
// ouvertes).
//
// Pourquoi un éditeur maison ? Dans AG Grid 31.3.2, agSelectCellEditor construit ses
// options en appelant valueService.formatValue(column, null, value) — node = null :
// sans la ligne de données, la résolution d'un libellé dépendant du type (row.type)
// est impossible (on retomberait systématiquement sur le label de base 'texte'). Un
// éditeur personnalisé, lui, reçoit params.data (la ligne) dans init(), exactement
// comme TextareaCellEditor recevra params.data pour champsIndexRef.
//
// PUR visuel : getValue() renvoie la VALEUR d'origine (l'indice, ex 4), jamais le
// libellé affiché ('Atelier') — le stockage, l'envoi LLM (sendLabel) et l'export
// restent strictement inchangés.
function SelectLibelleCellEditor() {}
SelectLibelleCellEditor.prototype.init = function(params) {
  const cle = params.colDef?.field;
  const sc = (cle && state.selectChoix[cle]) || null;
  const rowType = params.data?.type;
  this.initialValue = params.value;

  this.select = document.createElement('select');
  this.select.className = 'ag-cell-editor ag-select-custom';
  this.select.style.width = '100%';
  this.select.style.boxSizing = 'border-box';
  this.select.style.fontSize = '12px';
  this.select.style.padding = '4px';

  // Valeurs proposées : celles fournies par cellEditorParams (déjà restreintes par le
  // type de la ligne via champsRestreints), sinon la liste complète du dropdown.
  const values = Array.isArray(params.values)
    ? params.values
    : (sc ? sc.choix.map(c => c.valeur) : []);

  this.options = [];
  values.forEach((v) => {
    const entry = sc ? sc.choix.find(c => c.valeur === v) : null;
    let label = entry ? entry.label : String(v);
    if (entry) {
      const surcharge = libelleChoixPourType(entry, rowType);
      if (surcharge !== null) label = surcharge;
    }
    const opt = document.createElement('option');
    opt.value = String(v);
    opt.textContent = label;
    this.options.push({ value: v, label });
    this.select.appendChild(opt);
  });

  // Pré-sélection de la valeur courante (comparaison sur la valeur originale).
  let found = false;
  this.options.forEach((o, i) => {
    if (String(o.value) === String(this.initialValue) && !found) {
      this.select.selectedIndex = i;
      found = true;
    }
  });

  // Choisir une option → committer l'édition (le changement est propagé par
  // onCellValueChanged côté AG Grid).
  this.select.addEventListener('change', () => params.stopEditing());

  // Focus différé (rendu), et tentative d'ouverture du menu si l'édition a démarré au
  // clavier (Entrée) — comme agSelectCellEditor. showPicker() peut ne pas être
  // supporté ou refuser sans geste utilisateur : on reste silencieux si ça échoue,
  // le menu s'ouvrant alors au focus/au clic.
  this.startedByEnter = params.eventKey === 'Enter';
  setTimeout(() => {
    if (!this.select) return;
    this.select.focus();
    if (this.startedByEnter && typeof this.select.showPicker === 'function') {
      try { this.select.showPicker(); } catch (e) { /* ignoré */ }
    }
  }, 0);
};
SelectLibelleCellEditor.prototype.afterGuiAttached = function() {};
SelectLibelleCellEditor.prototype.getGui = function() { return this.select; };
SelectLibelleCellEditor.prototype.getValue = function() {
  const opt = this.options[this.select.selectedIndex];
  return opt ? opt.value : this.initialValue;
};
SelectLibelleCellEditor.prototype.isPopup = function() { return false; };
SelectLibelleCellEditor.prototype.focusIn = function() { if (this.select) this.select.focus(); };

// ── Champs non applicables au type de la ligne (grisage + blocage édition) ───────
// state.champsNonApplicables = { [valeurType]: [champs] }, reçu une fois à l'init
// (cf. views/formulaireListeQuestions.js CHAMPS_NON_APPLICABLES) — ne dépend que du
// champ "type" de la ligne, donc calculable directement ici sans aller-retour serveur.
function isFieldNonApplicable(row, cle) {
  if (!row) return false;
  const list = state.champsNonApplicables?.[row.type];
  return Array.isArray(list) && list.includes(cle);
}

// ── Libellé d'affichage éventuellement surchargé par type de ligne ─────────────
// Un choix selectChoix peut porter une surcharge PUREMENT VISUELLE dépendante du
// type de la ligne via `labelParType: { <indice type>: <libellé> }`, déclarée par
// la vue (ex: la règle 'texte' qui s'affiche "Atelier" sur les questions ouvertes).
// Sert uniquement au RENDU (cellule + dropdown) ; la valeur stockée, le label
// contractuel (sendLabel), les restrictions (champsRestreints) et la validation
// restent inchangés. Générique : grid.js ne connaît aucun nom de champ métier.
// Le type peut arriver en indice numérique (1..5) ou en code/label texte — on
// normalise pour lire la clé numérique.
function libelleChoixPourType(entry, typeValeur) {
  if (!entry || !entry.labelParType) return null;
  const map = entry.labelParType;
  let t = typeValeur;
  if (typeof t === 'string') {
    const typeStrToInt = {
      'qcm': 1, 'courte': 2, 'ouverte': 3, 'selection': 4, 'cours': 5,
      'QCM': 1, 'Réponse courte': 2, 'Texte long': 3, 'Liste de choix': 4, 'Cours': 5,
      '': 0, ' ': 0
    };
    t = typeStrToInt[t] ?? t;
  }
  return (t !== undefined && map[t] !== undefined) ? map[t] : null;
}

// ── Construction des colonDefs ─────────────────────────────────────────────────
function buildColDefs(colonnes) {

  // Colonne de sélection (checkbox) — en mode revue, fusionnée avec la revue par
  // ligne : la cellule ajoute les icônes ✓/✗ à côté de la case si la ligne porte
  // une proposition en attente, et l'en-tête troque le simple "tout sélectionner"
  // natif contre un ReviewHeaderComponent (sélectionner + valider/rejeter la
  // sélection courante). Cf. discussion utilisateur : une seule colonne, 3 commandes.
  const checkboxCol = {
    colId:                   '__select',
    headerCheckboxSelection: !state.reviewMode,
    checkboxSelection:       true,
    headerComponent:         state.reviewMode ? ReviewHeaderComponent : undefined,
    width:    state.reviewMode ? 100 : 40,
    minWidth: state.reviewMode ? 100 : 40,
    maxWidth: state.reviewMode ? 100 : 40,
    resizable:  false,
    sortable:   false,
    pinned:     'left',
    cellRenderer: state.reviewMode ? (params) => {
      const row = params.data;
      const wrap = document.createElement('span');
      wrap.className = 'row-review-actions';
      if (!row) return wrap;
      const hasPending = row.__pendingInsert || row.__pendingDelete
        || (row.__pendingFields && Object.keys(row.__pendingFields).length > 0);
      if (!hasPending) return wrap;

      const approveBtn = document.createElement('button');
      approveBtn.type = 'button';
      approveBtn.className = 'row-review-btn row-review-approve';
      approveBtn.title = row.__pendingInsert ? 'Garder cette ligne'
        : row.__pendingDelete ? 'Confirmer la suppression' : 'Valider toute la ligne';
      approveBtn.textContent = '✓';
      approveBtn.onclick = () => sendWS({ type: 'review:approveRow', id: row._id });

      const rejectBtn = document.createElement('button');
      rejectBtn.type = 'button';
      rejectBtn.className = 'row-review-btn row-review-reject';
      rejectBtn.title = row.__pendingInsert ? 'Annuler cette insertion'
        : row.__pendingDelete ? 'Annuler la suppression' : 'Rejeter toute la ligne';
      rejectBtn.textContent = '✗';
      rejectBtn.onclick = () => sendWS({ type: 'review:rejectRow', id: row._id });

      wrap.appendChild(approveBtn);
      wrap.appendChild(rejectBtn);
      return wrap;
    } : undefined,
  };

const dataCols = colonnes.map(col => {
    // Vérifier si cette colonne a un selectChoix
    const sc = state.selectChoix[col.cle];
    const hasSelectChoix = sc && Array.isArray(sc.choix) && sc.choix.length > 0;
    // Une colonne dropdown dont au moins un choix porte `labelParType` (libellé
    // d'affichage dépendant du type de la ligne) doit utiliser l'éditeur personnalisé
    // SelectLibelleCellEditor : agSelectCellEditor construit ses options sans la ligne
    // (valueService.formatValue(..., node=null)), il ne pourrait pas résoudre la
    // surcharge. Les autres dropdowns (type, correction, ...) gardent agSelectCellEditor.
    const hasLabelParType = hasSelectChoix && sc.choix.some(c => c && !!c.labelParType);

    const def = {
      field:      col.cle,
      headerName: col.cle,
      width:      col.width   || 120,
      minWidth:   col.minWidth ?? (hasSelectChoix ? 100 : 40),
      pinned:     col.pinned  || null,
      hide:       col.hide    || false,

      // readOnly → user ne peut pas modifier | placeholder → user peut modifier
      // selectChoix → utilise le cellEditor agSelectCellEditor (édition via Entrée)
      // Un champ non applicable au type de la ligne (champsNonApplicables) prime sur
      // tout le reste, y compris le "true" inconditionnel de hasSelectChoix : comme
      // dans XSpro, une cellule hors sujet pour ce type n'est jamais éditable.
      editable: (params) => {
        if (isFieldNonApplicable(params.data, col.cle)) return false;
        return hasSelectChoix ? true : !col.readOnly && !state.isAiRunning;
      },

      cellStyle: (params) => {
        const b = { fontSize: '12px' };
        // Champ hors sujet pour le type de la ligne — prioritaire sur tout le reste
        // (y compris le rouge "invalide" : une valeur inconsistante sur un champ qui
        // ne s'applique de toute façon pas à ce type n'a plus d'intérêt à signaler).
        if (isFieldNonApplicable(params.data, col.cle)) {
          // Même hachure que .cellule-interdite dans la vue XSpro de référence
          // (assets/css/typeTableur.css) — repris ici en style inline (AG Grid ne
          // fonctionne pas par classes CSS pour ce genre de surcharge par cellule).
          return {
            ...b,
            background: 'repeating-linear-gradient(135deg, #ffffff, #ffffff 3px, rgba(0,0,0,0.06) 3px, rgba(0,0,0,0.06) 6px)',
            color: '#bbb',
            fontStyle: 'italic',
            cursor: 'not-allowed',
          };
        }
        // Surcharge via cell:validate (invalid cell)
        const override = state.cellStyleOverrides?.[`${params.rowIndex}:${col.cle}`];
        if (override) return override;
        if (col.readOnly && col.placeholder) return { ...b, background: '#FFF3E0', color: '#888', fontStyle: 'italic' }; // figé (readOnly + placeholder)
        if (col.placeholder) return { ...b, background: '#FFF8E8', color: '#666' }; // placeholder éditable
        if (col.readOnly)    return { ...b, background: '#F3F3F3', color: '#888', fontStyle: 'italic' }; // readOnly seul
        if (hasSelectChoix)  return { ...b, background: '#F0F8FF', cursor: 'pointer' }; // selectChoix → fond bleu clair, curseur main
        return { ...b, background: '#fff' }; // normal
      },

      cellRenderer: col.readOnly && col.placeholder ? (params) => {
        const span = document.createElement('span');
        span.title = "Valeur figée — imposée par défaut, ni l'IA ni l'utilisateur ne peuvent la modifier";
        let displayValue = params.value;
        if (params.value && (col.type === 'decimal' || col.type === 'number')) {
          const n = parseFloat(params.value);
          if (!isNaN(n)) {
            displayValue = col.round
              ? n.toLocaleString('fr-FR', { minimumFractionDigits: col.round, maximumFractionDigits: col.round })
              : n.toLocaleString('fr-FR');
          }
        }
        span.innerHTML = displayValue ? `🔒 ${displayValue}` : '🔒';
        return span;
      } : undefined,

       // agSelectCellEditor - ouvre avec Entrée en mode clavier, affiche les labels, stocke les valeurs
       // permet la navigation gauche/droite même hors édition
       // Si la colonne porte des libellés surchargés par type (labelParType), on utilise
       // notre éditeur SelectLibelleCellEditor à la place : agSelectCellEditor construit
       // ses options sans la ligne (node=null, cf. SelectCellEditor.init), il ne pourrait
       // pas résoudre la surcharge par type. Les autres dropdowns sont inchangés.
       ...(hasSelectChoix ? {
         cellEditor: hasLabelParType ? SelectLibelleCellEditor : 'agSelectCellEditor',
         cellEditorParams: (params) => {
           // Restreint les valeurs proposées selon le type de la ligne courante, si le
           // hook a déclaré une restriction pour ce champ (state.champsRestreints) —
           // sinon (ex: colonne 'type' elle-même, jamais restreinte) liste complète.
           // Restriction du MENU affiché uniquement ; la validation reste inchangée.
           const restrictMap = state.champsRestreints?.[col.cle];
           let typeValeur = params.data?.type;
           // Conversion string → integer si nécessaire (ex: "qcm" → 1, "cours" → 5)
           // Le hook vue fournit des restrictions avec clés numériques (1,2,3,4,5)
           // mais les données peuvent contenir des strings ("qcm", "cours", etc.)
           if (typeof typeValeur === 'string') {
             const typeStrToInt = { 'qcm': 1, 'courte': 2, 'ouverte': 3, 'selection': 4, 'cours': 5 };
             typeValeur = typeStrToInt[typeValeur] ?? typeValeur;
           }
           const allowedValeurs = restrictMap?.[typeValeur];
           const values = Array.isArray(allowedValeurs) ? allowedValeurs : sc.choix.map(entry => entry.valeur);
           // NB: on ne fournit QUE les valeurs (restreintes). Les getOptionValue/
           // getOptionLabel n'existent pas dans agSelectCellEditor d'AG Grid 31.3.2
           // (ce ne sont pas des params reconnus) ; le libellé des options d'un dropdown
           // à libellé par type est géré par notre SelectLibelleCellEditor, celui des
           // autres dropdowns par le valueFormatter (comportement historique).
           return { values };
         },
        suppressKeyboardEvent: (params) => {
          const currentRowIndex = params.node?.rowIndex ?? params.api.getFocusedCell()?.rowIndex;
          // Toujours laisser passer ArrowLeft/ArrowRight pour la navigation horizontale
          if (params.event.key === 'ArrowLeft' || params.event.key === 'ArrowRight') {
            return false;
          }
          // Entrée pour ouvrir le dropdown
          if (params.event.key === 'Enter') {
            return false;
          }
          // Bloquer ArrowUp vers le header (sur première ligne)
          if (params.event.key === 'ArrowUp' && currentRowIndex === 0) {
            return true;
          }
          return false;
        },
      } : {}),

      cellClass: (col.type === 'decimal' || col.type === 'number' || col.type === 'integer') ? 'cell-numeric' : '',
    };

    // valueFormatter pour les colonnes avec selectChoix (affiche les labels)
    if (hasSelectChoix) {
      def.valueFormatter = (p) => {
        if (p.value === null || p.value === undefined || p.value === '') return '';
        // Normaliser la valeur : si c'est une string (label XSpro ou type),
        // convertir en indice pour trouver le label correspondant dans selectChoix
        let normalizedVal = p.value;
        if (typeof p.value === 'string') {
          // Pour 'type' : gérer les labels français
          if (col.cle === 'type') {
            const typeStrToIdx = {
              'qcm': 1, 'courte': 2, 'ouverte': 3, 'selection': 4, 'cours': 5,
              'QCM': 1, 'Réponse courte': 2, 'Texte long': 3, 'Liste de choix': 4, 'Cours': 5,
              '': 0, ' ': 0
            };
            normalizedVal = typeStrToIdx[p.value] ?? p.value;
          } else {
            // Autres champs : labels simples
            const otherStrToIdx = {
              'validation': 1, 'unique': 2, 'multiple': 3, 'texte': 4, 'texte(10)': 5, 'nombre': 6,
              'auto': 1, 'manuel': 2, 'semi': 3, 'aleatoire': 1, 'fixe': 2,
              '': 0, ' ': 0
            };
            normalizedVal = otherStrToIdx[p.value] ?? p.value;
          }
        }
        const selected = sc.choix.find(c => c.valeur === normalizedVal);
        if (!selected) return p.value;
        const surcharge = libelleChoixPourType(selected, p.data?.type);
        return (surcharge !== null) ? surcharge : selected.label;
      };
    }

    // valueFormatter pour les colonnes numériques non selectChoix
    if (!hasSelectChoix && (col.type === 'decimal' || col.type === 'number' || col.type === 'integer')) {
      def.valueFormatter = (p) => {
        if (p.value === null || p.value === undefined || String(p.value).trim() === '') return '';
        const n = parseFloat(p.value);
        // Valeur non numérique (ex: reliquat de saisie invalide) → afficher vide plutôt
        // que la valeur brute ou un texte d'erreur type "Invalid Number".
        if (isNaN(n)) return '';
        return col.round
          ? n.toLocaleString('fr-FR', { minimumFractionDigits: col.round, maximumFractionDigits: col.round })
          : n.toLocaleString('fr-FR');
      };
    }

    // cellEditor pour les colonnes numériques
    if (!hasSelectChoix && (col.type === 'decimal' || col.type === 'number' || col.type === 'integer')) {
      def.cellEditor = 'agNumberCellEditor';
    }

    // CellRenderer générique pour les colonnes dérivées
    const champ = col.cle;
    const isDerivee = state.colonnesDeriveesKeys && state.colonnesDeriveesKeys.has(champ);

    // cellEditor pour les colonnes multilignes (textarea)
    // Lecture seule ou dérivée → on n'ajoute pas l'éditeur multiligne
    const hasMultiligne = state.workerConfig?.champsMultiligne?.includes(col.cle);
    if (!hasSelectChoix && !col.readOnly && hasMultiligne && !isDerivee) {
      def.cellEditor = TextareaCellEditor;
    }

    // valueFormatter/valueParser pour les colonnes de type array (choix, choixCorrect)
    // AG Grid doit savoir comment afficher et parser les tableaux JavaScript
    const hasArrayField = state.workerConfig?.champsArray?.includes(col.cle);
    if (hasArrayField && !hasSelectChoix) {
      // valueFormatter : convertit array en string pour l'affichage
      def.valueFormatter = (p) => {
        if (p.value === null || p.value === undefined || p.value === '') return '';
        if (Array.isArray(p.value)) {
          return p.value.join('\n');
        }
        if (typeof p.value === 'string') {
          return p.value;
        }
        return String(p.value);
      };
      
      // valueParser : convertit string en array quand l'utilisateur édite
      def.valueParser = (p) => {
        const newValue = p.newValue;
        if (typeof newValue === 'string') {
          // Un seul élément par ligne (convention de l'éditeur : Entrée = nouvelle ligne).
          // Ne PAS découper sur la virgule : un élément de choix peut légitimement en
          // contenir une (ex: "Chats, chiens et oiseaux") — la découper décalerait les
          // positions du tableau et casserait la résolution d'indices de choixCorrect.
          const lines = newValue.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
          return lines; // Retourne un array
        }
        // Si déjà un array, le garder tel quel
        if (Array.isArray(newValue)) {
          return newValue;
        }
        return newValue ?? '';
      };

      // CellRenderer : sépare chaque élément de l'array par le symbole de saut de ligne,
      // mais à PLAT sur une seule ligne (pas de <br>) — si trop long, on tronque avec des
      // "..." (overflow CSS) plutôt que de passer à la ligne comme les champs texte.
      // Défensif : si un élément contient lui-même des \n bruts (ex: un tableau à 1 seul
      // élément resté "collé" après une édition), on le re-découpe ici avant l'affichage,
      // pour que le symbole apparaisse toujours, indépendamment de la façon dont la donnée
      // a été structurée côté édition/serveur.
      def.cellRenderer = (params) => {
        const span = document.createElement('span');
        const value = params.value;

        // Si ce champ référence un autre champ array de la même ligne (ex: choixCorrect
        // → choix), résoudre chaque valeur pour l'affichage : un indice numérique valide
        // se résout en texte via refArray ; une valeur déjà en texte brut (non encore
        // résolue en indice — état transitoire normal, cf. computeIndexRefSideEffects)
        // s'affiche telle quelle. La donnée réelle (params.value) n'est jamais modifiée.
        const refField = state.workerConfig?.champsIndexRef?.[col.cle];
        let rawItems;
        if (refField) {
          // RefArray tolère array OU string <br>/<br>-séparée (cf. refArrayPourAffichage) ;
          // chaque valeur (indice numérique OU string d'indice) se résout en texte exact.
          const refArray = refArrayPourAffichage(params.data?.[refField]);
          const valeurs = Array.isArray(value)
            ? value
            : (value === null || value === undefined ? [] : [value]);
          rawItems = valeurs
            .map(v => resoudreIndexPourAffichage(v, refArray))
            .filter(v => v !== undefined && v !== null);
        } else {
          rawItems = Array.isArray(value) ? value : (typeof value === 'string' && value ? [value] : []);
        }

        const items = rawItems
          .flatMap(v => String(v).split(/\r?\n/))
          .map(s => s.trim())
          .filter(Boolean);
        if (items.length) {
          span.textContent = items.join(' ⏎ ');
          span.title = items.join('\n');
          span.style.whiteSpace = 'nowrap';
          span.style.overflow = 'hidden';
          span.style.textOverflow = 'ellipsis';
          // display: inline-block est nécessaire pour que maxWidth + text-overflow:ellipsis
          // fonctionnent ici. Effet de bord ASSUMÉ (pas accidentel) : ça empêche le
          // text-decoration:line-through posé par cellStyle sur la cellule parente de se
          // propager à ce span — un champ array "incohérent" (rouge) n'apparaît donc jamais
          // barré, contrairement à un champ "interdit" ailleurs dans la grille. C'est une
          // distinction visuelle voulue entre les deux cas (cf. échanges du 2026-07-15) :
          // ne pas "corriger" en supprimant l'inline-block sans en rediscuter.
          span.style.display = 'inline-block';
          span.style.maxWidth = '100%';
          span.style.verticalAlign = 'middle';
          span.style.cursor = 'pointer';
          // Fixer explicitement la taille de police : sans ça, l'héritage depuis la cellule
          // parente (cellStyle: fontSize 12px) n'est pas garanti selon comment AG Grid
          // empile ses éléments internes — on l'aligne ici pour rester cohérent avec le
          // reste de la grille.
          span.style.fontSize = '12px';
        }
        return span;
      };
    }

    // CellRenderer pour les colonnes multilignes (hauteur dynamique)
    // Adapte la hauteur à 1 ou 2 lignes selon le contenu
    if (hasMultiligne && !isDerivee && !hasArrayField) {
      def.cellRenderer = (params) => {
        const span = document.createElement('span');
        const value = params.value;
        if (value !== null && value !== undefined && value !== '') {
          span.innerHTML = formatMultilineForDisplay(value);
          span.title = String(value).replace(/<br\s*\/?>/gi, '\n'); // tooltip : texte propre, sans le symbole
          span.className = 'ag-cell-multiline';

          // Calculer si le contenu nécessite 1 ou 2 lignes (sur le texte réel, sans le symbole)
          const textContent = String(value).replace(/<br\s*\/?>/gi, '\n');
          const lines = textContent.split('\n');
          const isShort = lines.length === 1 && lines[0].length <= 50;

          if (isShort) {
            span.classList.add('short');
          } else {
            span.classList.add('tall');
          }

          span.style.cursor = 'pointer';
          span.style.whiteSpace = 'pre-line';
        }
        return span;
      };
    }
    if (isDerivee) {
      // valueGetter : recalcule la valeur à chaque rendu (réactif) en appelant le code de la vue
      def.valueGetter = (params) => {
        const row = params.data;
        if (!row) return '';
        try {
          return computeDerivedValue(champ, row, state.selectChoix);
        } catch (e) {
          return '';
        }
      };
      // cellRenderer : affiche la valeur brute retournée par valueGetter
      def.cellRenderer = (params) => {
        const span = document.createElement('span');
        const value = params.value;
        if (value !== null && value !== undefined && value !== '') {
          span.textContent = String(value);
        }
        return span;
      };
      // Lecture seule
      def.editable = () => false;
      // Style neutre pour les colonnes dérivées (fond légèrement coloré pour indiquer le calcul automatique)
      def.cellStyle = (params) => {
        const override = state.cellStyleOverrides?.[`${params.rowIndex}:${champ}`];
        if (override) return override;
        const b = { fontSize: '12px', background: '#E8F5E9', color: '#2E7D32', fontStyle: 'italic' };
        return b;
      };
    }

    // Désactive globalement l'auto-détection AG Grid du type de donnée (cellDataType).
    // On gère nous-mêmes le formatage et le parsing de toutes les colonnes (selectChoix,
    // numériques, arrays...) via valueFormatter/valueParser/cellEditor définis ci-dessus ;
    // laisser AG Grid déduire un type à partir de la 1ère valeur vue (souvent vide/blanche
    // sur une ligne neuve) provoque des rejets silencieux de saisie ou des affichages
    // d'erreur ("Invalid Number", "Data type of the new value does not match...").
    def.cellDataType = false;

    // ── Mode revue (validation "individuellement", par champ) ──────────────────
    // Superpose des icônes ✓/✗ sur toute cellule dont le champ est en attente
    // (row.__pendingFields, posé côté serveur par llmClient.js/applyRowActions),
    // par-dessus le rendu déjà défini plus haut (multiligne, array, dérivée, ou
    // rendu par défaut) — jamais un remplacement. Actif uniquement pour les vues
    // qui ont opté in via MANIFEST.revueParPending (les autres ne sont pas touchées).
    if (state.reviewMode) {
      const baseCellRenderer   = def.cellRenderer   || null;
      const baseValueFormatter = def.valueFormatter || null;
      const baseCellStyle      = def.cellStyle;

      def.cellRenderer = (params) => {
        const row = params.data;
        const isPending = !!(row?.__pendingFields && (col.cle in row.__pendingFields));
        // Une colonne multiligne est déjà à son budget de hauteur (2 lignes, cf.
        // .ag-cell-multiline.tall, dans une rowHeight fixe de 40px) : y ajouter les
        // icônes en flex inline pousserait la 2e ligne sous la bordure basse. On les
        // pose plutôt en overlay absolu (badge), sans toucher à la mise en page du texte.
        const isMultilineCol = state.workerConfig?.champsMultiligne?.includes(col.cle);

        const inner = document.createElement('span');
        inner.className = isMultilineCol ? 'cell-value-wrap-multiline' : 'cell-value-wrap';
        if (baseCellRenderer) {
          const rendered = baseCellRenderer(params);
          if (rendered instanceof Node) inner.appendChild(rendered);
          else if (rendered !== null && rendered !== undefined) inner.textContent = String(rendered);
        } else {
          const display = baseValueFormatter ? baseValueFormatter(params) : params.value;
          inner.textContent = (display === null || display === undefined) ? '' : String(display);
        }
        if (!isPending) return inner;

        // Tooltip "Avant / Après" — la valeur d'origine est conservée dans __pendingFields
        // (posée par applyRowActions pour l'IA, par setCellValue pour une édition manuelle)
        // mais seule sa PRÉSENCE servait jusqu'ici, pour le surlignage ; sa valeur n'était
        // jamais affichée, ce qui obligeait à valider/rejeter sans voir ce qu'on remplace.
        const rowAvant = { ...row, ...row.__pendingFields };
        const avant = formatValeurPourRevue(row.__pendingFields[col.cle], col, params, baseValueFormatter, rowAvant);
        const apres = formatValeurPourRevue(params.value, col, params, baseValueFormatter, row);
        const infobulle = `Avant : ${avant}\n──────────\nAprès : ${apres}`;
        inner.title = infobulle;
        // Les cellRenderer array et multiligne posent leur propre title sur un span ENFANT,
        // qui l'emporterait au survol (le title le plus profond gagne) — on l'aligne.
        inner.querySelectorAll('[title]').forEach(elt => { elt.title = infobulle; });

        const approveBtn = document.createElement('button');
        approveBtn.type = 'button';
        approveBtn.className = 'field-pending-btn field-pending-approve';
        approveBtn.title = 'Valider cette modification';
        approveBtn.textContent = '✓';
        approveBtn.onclick = (e) => { e.stopPropagation(); sendWS({ type: 'review:approveField', id: row._id, cle: col.cle }); };
        const rejectBtn = document.createElement('button');
        rejectBtn.type = 'button';
        rejectBtn.className = 'field-pending-btn field-pending-reject';
        rejectBtn.title = 'Rejeter cette modification';
        rejectBtn.textContent = '✗';
        rejectBtn.onclick = (e) => { e.stopPropagation(); sendWS({ type: 'review:rejectField', id: row._id, cle: col.cle }); };

        const actions = document.createElement('span');
        const wrap = document.createElement('span');
        if (isMultilineCol) {
          wrap.className = 'field-pending-wrap-multiline';
          actions.className = 'field-pending-actions field-pending-actions-overlay';
        } else {
          wrap.className = 'field-pending-wrap';
          actions.className = 'field-pending-actions';
        }
        actions.appendChild(approveBtn);
        actions.appendChild(rejectBtn);
        wrap.appendChild(inner);
        wrap.appendChild(actions);
        return wrap;
      };

      def.cellStyle = (params) => {
        const base = typeof baseCellStyle === 'function' ? (baseCellStyle(params) || {}) : (baseCellStyle || {});
        const row = params.data;
        const isPending = !!(row?.__pendingFields && (col.cle in row.__pendingFields));
        if (!isPending) return base;
        // backgroundColor (propriété longue), pas background (raccourcie) : le raccourci
        // réinitialiserait background-image/-position/-repeat hérités de `base` — effaçant
        // le triangle ⚠ d'une cellule à la fois invalide ET en attente de revue.
        return { ...base, backgroundColor: '#FFF8E1', boxShadow: 'inset 0 0 0 1px #F5A623' };
      };
    }

    return def;
  });

  return [checkboxCol, ...dataCols];
}

// ── Marqueur pending générique (mode revue) — mirroir client de hasPendingMarker
// côté sessionManager.js. Utilisé pour savoir si une ligne mérite les commandes de
// revue (icônes de ligne, icônes d'en-tête, barre globale).
function hasPendingMarkerClient(row) {
  return !!(row && (row.__pendingInsert || row.__pendingDelete
    || (row.__pendingFields && Object.keys(row.__pendingFields).length > 0)));
}

// ── Rendu texte d'une valeur pour le tooltip de revue "Avant / Après" ─────────
// Réutilise le valueFormatter de la colonne quand il existe (selectChoix → libellé,
// numérique → format fr-FR) ; reproduit sinon ce que font les cellRenderer array et
// multiligne, qui ne sont pas réutilisables ici (ils produisent des noeuds DOM).
// `rowPourRefs` sert à résoudre les colonnes d'indices (champsIndexRef, ex.
// choixCorrect → choix) : on lui passe la ligne AVANT pour l'ancienne valeur et la
// ligne courante pour la nouvelle, sans quoi d'anciens indices seraient résolus
// contre une liste de choix déjà remplacée — et afficheraient de faux libellés.
const TOOLTIP_REVUE_MAX = 300;
function formatValeurPourRevue(value, col, params, baseValueFormatter, rowPourRefs) {
  const tronquer = (s) => (s.length > TOOLTIP_REVUE_MAX ? s.slice(0, TOOLTIP_REVUE_MAX) + '…' : s);
  if (value === null || value === undefined || value === '') return '(vide)';

  const refField = state.workerConfig?.champsIndexRef?.[col.cle];
  if (refField) {
    // Même tolérance qu'au rendu : refArray peut être array ou string <br>/<br>-séparée,
    // et chaque valeur un indice numérique OU une string d'indice (cf. helpers ci-dessus).
    const refArray = refArrayPourAffichage(rowPourRefs?.[refField]);
    const valeurs = Array.isArray(value) ? value : (value === null || value === undefined ? [] : [value]);
    const items = valeurs
      .map(v => resoudreIndexPourAffichage(v, refArray))
      .filter(v => v !== undefined && v !== null);
    return items.length ? tronquer(items.join(' ⏎ ')) : '(vide)';
  }

  if (Array.isArray(value)) {
    const items = value.flatMap(v => String(v).split(/\r?\n/)).map(s => s.trim()).filter(Boolean);
    return items.length ? tronquer(items.join(' ⏎ ')) : '(vide)';
  }

  if (baseValueFormatter) {
    const formate = baseValueFormatter({ ...params, value });
    if (formate === null || formate === undefined || formate === '') return '(vide)';
    return tronquer(String(formate));
  }

  return tronquer(String(value).replace(/<br\s*\/?>/gi, '\n'));
}

// ── En-tête fusionné sélection + revue (mode revueParPending) ─────────────────
// Remplace le simple headerCheckboxSelection natif : garde la case "tout sélectionner"
// (implémentée nous-mêmes pour pouvoir lui adjoindre les icônes) + deux icônes ✓/✗ qui
// valident/rejettent TOUTES les lignes actuellement cochées (pas automatiquement toutes
// les lignes en attente — l'utilisateur coche "tout" lui-même s'il le souhaite). Les
// icônes restent masquées tant que la sélection ne contient aucune ligne en attente —
// rien à valider/rejeter sinon.
function ReviewHeaderComponent() {}
ReviewHeaderComponent.prototype.init = function(params) {
  this.params = params;

  this.eGui = document.createElement('span');
  this.eGui.className = 'review-header';

  this.checkbox = document.createElement('input');
  this.checkbox.type = 'checkbox';
  this.checkbox.className = 'review-header-checkbox';
  this.checkbox.title = 'Tout sélectionner';
  this.checkbox.addEventListener('click', () => {
    const checked = this.checkbox.checked;
    params.api.forEachNodeAfterFilterAndSort(node => node.setSelected(checked));
  });

  this.approveBtn = document.createElement('button');
  this.approveBtn.type = 'button';
  this.approveBtn.className = 'row-review-btn row-review-approve';
  this.approveBtn.title = 'Valider les lignes sélectionnées';
  this.approveBtn.textContent = '✓';
  this.approveBtn.onclick = () => this.bulkAction('review:approveRows');

  this.rejectBtn = document.createElement('button');
  this.rejectBtn.type = 'button';
  this.rejectBtn.className = 'row-review-btn row-review-reject';
  this.rejectBtn.title = 'Rejeter les lignes sélectionnées';
  this.rejectBtn.textContent = '✗';
  this.rejectBtn.onclick = () => this.bulkAction('review:rejectRows');

  this.eGui.appendChild(this.checkbox);
  this.eGui.appendChild(this.approveBtn);
  this.eGui.appendChild(this.rejectBtn);

  // Reflète l'état de la sélection courante sur la case "tout sélectionner"
  // (cochée/indéterminée/vide), comme le ferait le headerCheckboxSelection natif, et
  // masque les icônes ✓/✗ tant que rien de sélectionné n'a de proposition en attente.
  this.onSelectionChanged = () => {
    const total    = params.api.getDisplayedRowCount();
    const selectedNodes = params.api.getSelectedNodes();
    this.checkbox.checked      = total > 0 && selectedNodes.length === total;
    this.checkbox.indeterminate = selectedNodes.length > 0 && selectedNodes.length < total;
    const hasPendingSelected = selectedNodes.some(n => hasPendingMarkerClient(n.data));
    this.approveBtn.style.display = hasPendingSelected ? '' : 'none';
    this.rejectBtn.style.display  = hasPendingSelected ? '' : 'none';
  };
  params.api.addEventListener('selectionChanged', this.onSelectionChanged);
  this.onSelectionChanged(); // état initial : rien sélectionné → icônes masquées
};
ReviewHeaderComponent.prototype.bulkAction = function(type) {
  const ids = this.params.api.getSelectedRows().map(r => r._id).filter(id => id !== undefined);
  if (!ids.length) return;
  sendWS({ type, ids });
};
ReviewHeaderComponent.prototype.getGui = function() { return this.eGui; };
ReviewHeaderComponent.prototype.destroy = function() {
  this.params.api.removeEventListener('selectionChanged', this.onSelectionChanged);
};

// ── Déplacement manuel de lignes/blocs (boutons ▲/▼/"Déplacer ici") ───────────
// Corrige une ligne (ou un bloc de lignes) mal placée sans changer son contenu — ex:
// un chapitre entier inséré au mauvais endroit par l'IA. Ciblage par _id (jamais par
// rowIndex) pour rester valide côté serveur quel que soit l'ordre affiché au moment
// de l'envoi. Fonctionne en mode direct ET en mode revue (cf. sessionManager.moveRows,
// aucun marqueur __pending posé — un déplacement n'est pas un contenu à valider).

/**
 * Lit la sélection courante (checkboxes AG Grid), triée par position affichée.
 * @returns {{ids:Array<number>, firstIndex:number, lastIndex:number}|null}
 */
function getMoveSelection() {
  if (!state.gridApi) return null;
  const nodes = state.gridApi.getSelectedNodes();
  if (!nodes.length) return null;
  const sorted = nodes.slice().sort((a, b) => a.rowIndex - b.rowIndex);
  return {
    ids:        sorted.map(n => n.data._id),
    firstIndex: sorted[0].rowIndex,
    lastIndex:  sorted[sorted.length - 1].rowIndex,
  };
}

function moveSelectionUp() {
  const sel = getMoveSelection();
  if (!sel || sel.firstIndex <= 0) return;
  const apres = sel.firstIndex >= 2 ? state.rows[sel.firstIndex - 2]._id : null;
  sendWS({ type: 'rows:move', ids: sel.ids, apres });
}

function moveSelectionDown() {
  const sel = getMoveSelection();
  if (!sel || sel.lastIndex >= state.rows.length - 1) return;
  sendWS({ type: 'rows:move', ids: sel.ids, apres: state.rows[sel.lastIndex + 1]._id });
}

function moveSelectionAfterFocused() {
  const sel = getMoveSelection();
  if (!sel) return;
  const focused = state.gridApi.getFocusedCell();
  if (!focused || focused.rowIndex < 0) {
    addMessage('error', '⚠ Clique d\'abord sur la ligne cible, puis "Déplacer ici".');
    return;
  }
  const targetId = state.gridApi.getDisplayedRowAtIndex(focused.rowIndex)?.data?._id;
  if (targetId === undefined || sel.ids.includes(targetId)) {
    addMessage('error', '⚠ La ligne ciblée doit être hors de la sélection.');
    return;
  }
  sendWS({ type: 'rows:move', ids: sel.ids, apres: targetId });
}

/**
 * Active/désactive les 3 boutons selon la sélection courante, les bornes du tableau,
 * et l'état isAiRunning — appelée après tout événement qui change la sélection ou
 * l'ensemble des rows (onSelectionChanged, setAiRunning, onReviewSync, onActDone,
 * onRowsMoved).
 */
function updateMoveButtonsState() {
  const sel = getMoveSelection();
  const running = state.isAiRunning;
  el('btn-move-up').disabled    = !sel || sel.firstIndex === 0 || running;
  el('btn-move-down').disabled  = !sel || sel.lastIndex === state.rows.length - 1 || running;
  el('btn-move-after').disabled = !sel || running;
}

/**
 * Réception de la confirmation serveur après un déplacement ('rows:moved').
 * Reset impératif de styleOverrides/cellStyleOverrides AVANT tout redraw : ces caches
 * sont indexés par rowIndex POSITIONNEL (cf. state déclaré plus haut) et n'ont plus de
 * sens après un réordonnancement — sans ce reset, une surcharge de style resterait
 * accrochée à l'ancien numéro de position et s'appliquerait à la MAUVAISE ligne. Les
 * cell:validate envoyés dans la foulée par le serveur (revalidateAllRows) repeuplent
 * cellStyleOverrides proprement à la bonne position via onRowValidate.
 */
function onRowsMoved(msg) {
  state.rows = normaliserLignesEntrantes(msg.rows || []);
  state.styleOverrides     = {};
  state.cellStyleOverrides = {};
  if (typeof msg.pendingCount === 'number') state.pendingCount = msg.pendingCount;
  if (state.gridApi) {
    state.gridApi.setGridOption('rowData', [...state.rows]);
    state.gridApi.redrawRows();
    state.gridApi.refreshCells({ force: true });
    if (state.reviewMode) state.gridApi.refreshHeader();
  }
  updateRowCount();
  updateReviewToolbar();
  updateMoveButtonsState();
  addMessage('system', '↕ Ordre des lignes mis à jour.');
}

// ── Ajout de lignes ───────────────────────────────────────────────────────────
function addRowAfterSelected() {
  const colonnes  = state.workerConfig?.colonnes || [];
  const selected  = state.gridApi.getSelectedNodes();
  
  let insertIndex;
  if (selected.length > 0) {
    // Avec sélection : insérer APRÈS la dernière sélection
    insertIndex = Math.max(...selected.map(n => n.rowIndex)) + 1;
  } else {
    // Sans sélection : utiliser le focus pour insérer AVANT la ligne courante
    const focusedCell = state.gridApi.getFocusedCell();
    if (focusedCell && focusedCell.rowIndex >= 0) {
      insertIndex = focusedCell.rowIndex;
    } else {
      insertIndex = state.rows.length;
    }
  }

  // Ligne vide basée sur les colonnes disponibles
  const champsArray = state.workerConfig?.champsArray || [];
  const newRow = {};
  for (const col of colonnes) {
    if (col.placeholder) {
      const def = state.workerConfig?.regles?.valeursParDefaut?.[col.cle];
      newRow[col.cle] = (def !== undefined && typeof def !== 'string') ? def : '';
    } else if (champsArray.includes(col.cle)) {
      // Les champs array (choix, choixCorrect) doivent être initialisés avec []
      newRow[col.cle] = [];
    } else {
      // Utiliser la valeur de fallback si selectChoix en définit une
      const sc = state.selectChoix[col.cle];
      if (sc && sc.fallback && sc.fallback.alors !== undefined) {
        newRow[col.cle] = sc.fallback.alors;
      } else {
        newRow[col.cle] = '';
      }
    }
  }

  // Mode revue : proposer l'insertion au serveur (statut __pendingInsert, mêmes
  // commandes ✓/✗ qu'une insertion IA — décision du 2026-07-30) plutôt que d'insérer
  // directement. Pas d'insertion optimiste locale : la ligne apparaîtra teintée verte
  // au prochain review:sync renvoyé par le serveur.
  if (state.reviewMode) {
    const apres = insertIndex > 0 ? (state.rows[insertIndex - 1]?._id ?? null) : null;
    sendWS({ type: 'review:proposeInsert', apres, fields: newRow });
    addMessage('system', '↓ Ligne proposée — à valider');
    return;
  }

  // Insertion dans state.rows
  state.rows.splice(insertIndex, 0, newRow);

  // Rafraîchissement de la grille
  state.gridApi.setGridOption('rowData', [...state.rows]);
  updateRowCount();

  // Sélectionner la nouvelle ligne et scroller dessus
  setTimeout(() => {
    const node = state.gridApi.getDisplayedRowAtIndex(insertIndex);
    if (node) {
      state.gridApi.ensureIndexVisible(insertIndex);
      state.gridApi.setFocusedCell(insertIndex, colonnes.find(c => !c.readOnly)?.cle || colonnes[0]?.cle);
    }
  }, 50);

  // Sync serveur
  syncRowsToServer();
  addMessage('system', `↓ Ligne ajoutée (position ${insertIndex + 1})`);
}

// ── Suppression de lignes ─────────────────────────────────────────────────────

function deleteSelectedRows() {
  const selected = state.gridApi.getSelectedNodes();
  if (!selected.length) return;

  // Mode revue : proposer la suppression au serveur (statut __pendingDelete, mêmes
  // commandes ✓/✗ qu'une suppression IA — décision du 2026-07-30) plutôt que de
  // supprimer directement. Le rejet via la colonne Revue fait déjà office d'"annuler",
  // pas besoin du toast "Annuler" ci-dessous dans ce mode.
  if (state.reviewMode) {
    const ids = selected.map(n => n.data?._id).filter(id => id !== undefined);
    if (!ids.length) return;
    sendWS({ type: 'review:proposeDelete', ids });
    addMessage('system', `✂ ${ids.length} ligne${ids.length > 1 ? 's' : ''} proposée${ids.length > 1 ? 's' : ''} à la suppression — à valider`);
    return;
  }

  // Sauvegarder les lignes supprimées pour l'undo
  const deletedRows = selected.map(n => ({ ...n.data, rowIndex: n.rowIndex }));
  const deletedIndexes = selected.map(n => n.rowIndex).sort((a, b) => b - a);

  const count = selected.length;

  // Indexes à supprimer (tri décroissant pour ne pas décaler les indexes)
  for (const idx of deletedIndexes) {
    state.rows.splice(idx, 1);
  }

  state.gridApi.setGridOption('rowData', [...state.rows]);
  el('btn-delete-rows').disabled = true;
  updateRowCount();
  syncRowsToServer();
  
  // Afficher le message avec bouton "Annuler"
  showUndoDeleteMessage(count, deletedRows);
}

// Affiche un message avec bouton Annuler pour la suppression
function showUndoDeleteMessage(count, deletedRows) {
  const inner = el('conversation-inner');
  
  // Supprimer les messages undo existants
  inner.querySelectorAll('.undo-message').forEach(el => el.remove());
  
  const wrap = document.createElement('div');
  wrap.className = 'conv-msg conv-msg-system undo-message';
  
  const bubble = document.createElement('div');
  bubble.className = 'conv-bubble';
  bubble.innerHTML = `🗑 ${count} ligne${count > 1 ? 's' : ''} supprimée${count > 1 ? 's' : ''} &nbsp;<button class="btn-undo" id="btn-undo-delete">↺ Annuler</button>`;
  
  wrap.appendChild(bubble);
  inner.appendChild(wrap);
  scrollToBottom();
  
  const btnUndo = wrap.querySelector('#btn-undo-delete');
  
  // Gestion du clic sur Annuler
  btnUndo.addEventListener('click', () => {
    if (btnUndo.disabled) return;
    restoreDeletedRows(deletedRows);
    wrap.remove();
  });
}

// Restaure les lignes supprimées
function restoreDeletedRows(deletedRows) {
  // Tri des lignes par rowIndex croissant pour réinsérer dans l'ordre
  deletedRows.sort((a, b) => a.rowIndex - b.rowIndex);
  
  // Réinsertion des lignes
  for (const row of deletedRows) {
    const { rowIndex, ...rowData } = row;
    state.rows.splice(rowIndex, 0, rowData);
  }
  
  state.gridApi.setGridOption('rowData', [...state.rows]);
  updateRowCount();
  syncRowsToServer();
  
  addMessage('system', `↺ Ligne${deletedRows.length > 1 ? 's' : ''} restaurée${deletedRows.length > 1 ? 's' : ''}`);
}

// ── Frontière de sortie : indice d'affichage → code texte ────────────────────
// Inverse exact de la conversion faite à l'init (cf. onInit, allStrToIdx). XSpro envoie
// certains champs selectChoix en CODE TEXTE (`type` = "cours") et les attend sous cette
// même forme au retour : son _normaliserLigne() les valide contre typesValides
// (['cours','qcm','courte','ouverte','selection']) et ne connaît pas les indices. Pire,
// un indice y est rattrapé par un rapprochement de Levenshtein — "1" est à distance 3 de
// "qcm", dans le seuil — donc TOUTE ligne renvoyée avec un type numérique redevenait
// silencieusement un QCM. La conversion en indice sert uniquement aux dropdowns AG Grid :
// elle ne doit jamais franchir cette frontière.
// Seuls les champs RÉELLEMENT convertis à l'entrée sont réinversés (champsConvertisEnIndice) :
// regle/correction/ordre_choix arrivent déjà en indices depuis XSpro et doivent le rester.
const CODES_PAR_INDICE = {
  type:        ['', 'qcm', 'courte', 'ouverte', 'selection', 'cours'],
  regle:       ['', 'validation', 'unique', 'multiple', 'texte', 'texte(10)', 'nombre'],
  correction:  ['', 'auto', 'manuel', 'semi'],
  ordre_choix: ['', 'aleatoire', 'fixe'],
};

function valeurPourServeur(cle, valeur) {
  if (!state.champsConvertisEnIndice?.has(cle)) return valeur;
  const codes = CODES_PAR_INDICE[cle];
  // typeof number : une valeur déjà en texte (ex. restaurée par un rejet de proposition,
  // qui renvoie la valeur d'origine telle quelle) passe inchangée.
  if (!codes || typeof valeur !== 'number') return valeur;
  return codes[valeur] ?? valeur;
}

function rowsPourServeur(rows) {
  if (!state.champsConvertisEnIndice?.size) return rows;
  return rows.map(row => {
    const copie = { ...row };
    for (const cle of state.champsConvertisEnIndice) copie[cle] = valeurPourServeur(cle, copie[cle]);
    return copie;
  });
}

// ── Sync rows → serveur ───────────────────────────────────────────────────────
function syncRowsToServer() {
  sendWS({ type: 'rows:sync', rows: rowsPourServeur(state.rows) });
}

// ── Helper : conversion valeur selon le type de colonne (fallback sécurité) ───────────
function coerceValueForGrid(value, col) {
  if (value === '' || value === null || value === undefined) return value;
  
  const colType = col?.type;
  
  // Conversion numérique
  if (colType === 'decimal' || colType === 'number' || colType === 'integer') {
    const n = parseFloat(value);
    if (!isNaN(n)) {
      return colType === 'integer' ? parseInt(value, 10) : n;
    }
  }
  
  return value;
}

// ── Mises à jour cellule par l'IA ────────────────────────────────────────────
function onCellUpdate(rowIndex, cle, value) {
  if (!state.gridApi) return;

  // Fallback : conversion selon le type si défini
  const colDef = state.workerConfig?.colonnes?.find(c => c.cle === cle);
  if (colDef && (colDef.type === 'decimal' || colDef.type === 'number' || colDef.type === 'integer')) {
    value = coerceValueForGrid(value, colDef);
  }

  if (state.rows[rowIndex]) state.rows[rowIndex][cle] = value;
  const node = state.gridApi.getDisplayedRowAtIndex(rowIndex);
  if (node) {
    node.setDataValue(cle, value);
    state.gridApi.redrawRows({ rowNodes: [node] });
state.gridApi.flashCells({ rowNodes: [node], columns: [cle], flashDuration: 150, fadeDuration: 400 });
    state.gridApi.refreshCells({ rowNodes: [node], columns: [cle], force: true });
  }
  state.updatedCells++;
  updateProgress();
}

// ── Restauration de cellule (édition manuelle rejetée par le serveur) ─────────
function onCellRevert(rowIndex, cle, value, message) {
  if (!state.gridApi) return;
  if (state.rows[rowIndex]) state.rows[rowIndex][cle] = value;
  const node = state.gridApi.getDisplayedRowAtIndex(rowIndex);
  if (node) {
    node.setDataValue(cle, value); // source 'api' → pas de nouveau onCellValueChanged
state.gridApi.flashCells({ rowNodes: [node], columns: [cle], flashDuration: 150, fadeDuration: 400 });
  }
  if (message) addMessage('error', `⚠ ${message}`);
}

// ── Application style dynamique d'une ligne (mise en rouge, etc.) ─────────────
function onRowStyle(rowIndex, style) {
  if (!state.gridApi) return;
  if (style) {
    state.styleOverrides[rowIndex] = style;
  } else {
    delete state.styleOverrides[rowIndex];
  }
  const node = state.gridApi.getDisplayedRowAtIndex(rowIndex);
  if (node) state.gridApi.redrawRows({ rowNodes: [node] });
}

// ── Validation ligne : mise en évidence des cellules fautives ────────────────
function onRowValidate(msg) {
  const { rowIndex, invalidFields = [], pendingFields, pendingCount, message } = msg;
  const keyPrefix = `${rowIndex}:`;
  // Supprimer toutes les overrides de cellules pour cette ligne
  Object.keys(state.cellStyleOverrides).forEach(k => {
    if (k.startsWith(keyPrefix)) delete state.cellStyleOverrides[k];
  });
  if (invalidFields.length > 0) {
// Style rouge pour chaque champ invalide, plus un repère triangle ⚠ en coin (superposé via
// background-image, indépendant de backgroundColor) — la couleur seule peut passer inaperçue
// (daltonisme, cellule déjà colorée pour une autre raison), le repère reste sans équivoque.
    const invalidStyle = {
      backgroundColor: '#FFEBEE',
      color: '#B71C1C',
      textDecoration: 'line-through',
      backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' width='11' height='11'><path fill='%23e67e22' d='M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z'/></svg>\")",
      backgroundRepeat: 'no-repeat',
      backgroundPosition: 'top 2px right 2px',
    };
    invalidFields.forEach(cle => {
      state.cellStyleOverrides[`${rowIndex}:${cle}`] = invalidStyle;
    });
  }
  // Mode revue : synchronise row.__pendingFields avec l'état serveur — c'est ce que
  // lit directement le wrapper cellRenderer/cellStyle du mode revue (cf. buildColDefs)
  // pour surligner ✓/✗ un champ en attente, que le changement vienne de l'IA ou d'une
  // édition manuelle (décision du 2026-07-30 : même traitement quelle que soit l'origine).
  // Objet { champ: valeurOrigine } recopié tel quel : les valeurs d'origine alimentent le
  // tooltip "Avant" et doivent survivre à une édition manuelle sur une ligne déjà
  // retouchée par l'IA (cf. server.js, message cell:validate).
  const aPendingFields = pendingFields && typeof pendingFields === 'object';
  if (aPendingFields) {
    const row = state.rows[rowIndex];
    if (row) {
      if (Object.keys(pendingFields).length > 0) row.__pendingFields = { ...pendingFields };
      else delete row.__pendingFields;
    }
  }
  // Édition manuelle en mode revue : met à jour le compteur (pas de review:sync ici,
  // seul le champ édité change, pas tout le tableau) — pilote la visibilité de
  // "Valider et exporter".
  if (typeof pendingCount === 'number') {
    state.pendingCount = pendingCount;
    updateReviewToolbar();
  }
  // Redraw seulement si la grille existe déjà (sinon les overrides sont stockés pour onGridReady)
  if (state.gridApi) {
    const node = state.gridApi.getDisplayedRowAtIndex(rowIndex);
    if (node) {
      state.gridApi.redrawRows({ rowNodes: [node] });
      // Filet de sécurité (cf. onActDone/onReviewSync) : redrawRows seul ne réexécute pas
      // toujours cellStyle/cellRenderer de façon fiable dans cette version d'AG Grid.
      state.gridApi.refreshCells({ rowNodes: [node], force: true });
      // Une édition manuelle peut faire passer cette ligne en pending sans changer la
      // sélection — recalcule la visibilité des icônes d'en-tête.
      if (aPendingFields) state.gridApi.refreshHeader();
    }
  }
  if (message) addMessage('error', `⚠ ${message}`);
}

// ── Plan reçu ─────────────────────────────────────────────────────────────────
function onPlanReceived(planText) {
  setAiRunning(false);
  setStatusBadge('planning', 'Plan reçu');
  setStatusMessage('Plan reçu — valide ou rejette');

  const msgEl  = addMessage('plan', planText);
  const actions = document.createElement('div');
  actions.className = 'conv-plan-actions';
  actions.innerHTML = `
    <button class="btn-secondary btn-sm" id="btn-plan-reject">✕ Rejeter</button>
    <button class="btn-primary btn-sm"   id="btn-plan-validate">✓ Valider et exécuter</button>
  `;
  msgEl.querySelector('.conv-bubble').appendChild(actions);

  actions.querySelector('#btn-plan-validate').addEventListener('click', () => {
    actions.remove();
    initProgress();
    sendWS({ type: 'plan:validate' });
    addMessage('system', 'Plan validé — exécution…');
    setStatusBadge('acting', libelleTraitement());
    setAiRunning(true);
  });

  actions.querySelector('#btn-plan-reject').addEventListener('click', () => {
    actions.remove();
    addMessage('system', 'Plan rejeté.');
    setStatusBadge('connected', 'Prêt');
  });
}

// ── Act terminé ───────────────────────────────────────────────────────────────
// actionsResume { inserted, updated, deleted } : uniquement fourni en editionParActions
// (cf. llmClient.js applyRowActions) — le rendu cellule par cellule (state.updatedCells)
// est désactivé pour ce contrat (insert/delete décaleraient les index), donc sans ce
// résumé le message de fin affichait toujours "0 cellule(s) mise(s) à jour" même après
// de vraies insertions/suppressions.
function buildActionsResumeText(resume) {
  const parts = [];
  if (resume.inserted) parts.push(`${resume.inserted} ligne${resume.inserted > 1 ? 's' : ''} ajoutée${resume.inserted > 1 ? 's' : ''}`);
  if (resume.updated)  parts.push(`${resume.updated} ligne${resume.updated > 1 ? 's' : ''} modifiée${resume.updated > 1 ? 's' : ''}`);
  if (resume.deleted)  parts.push(`${resume.deleted} ligne${resume.deleted > 1 ? 's' : ''} supprimée${resume.deleted > 1 ? 's' : ''}`);
  return parts.length ? parts.join(', ') : 'aucune modification';
}

// ── Trace de diagnostic du mode revue ─────────────────────────────────────────
// Le chemin "retour d'IA" n'avait aucune trace, ce qui rendait impossible de dire, face
// à un marquage absent, si les marqueurs manquaient a l'arrivee ou si seul le rendu
// echouait. On mesure les deux : ce que portent les donnees, et ce qui est reellement
// peint dans le DOM. La mesure DOM est differee d'un tick, les cellules n'etant pas
// encore rendues au retour de refreshCells().
function tracerEtatRevue(origine, pendingCount, actionsResume) {
  if (!state.reviewMode) return;
  const rows = state.rows || [];
  // Les trois marqueurs comptent pour countPendingRows cote serveur : ne regarder que
  // __pendingFields donnait un "0 en attente" trompeur face a un pendingCount non nul,
  // alors qu'une ligne inseree ou proposee a la suppression se marque au niveau LIGNE.
  const champsEnAttente = rows.filter(r => r.__pendingFields && Object.keys(r.__pendingFields).length);
  const inseres   = rows.filter(r => r.__pendingInsert).length;
  const supprimes = rows.filter(r => r.__pendingDelete).length;
  const champs = [...new Set(champsEnAttente.flatMap(r => Object.keys(r.__pendingFields)))];
  const typesNonNumeriques = rows.filter(r => r.type !== undefined && typeof r.type !== 'number').length;
  const resume = actionsResume
    ? `+${actionsResume.inserted || 0}/~${actionsResume.updated || 0}/-${actionsResume.deleted || 0}`
    : 'n/a';
  setTimeout(() => {
    const affichees = state.gridApi ? state.gridApi.getAllDisplayedColumns().map(c => c.getColId()) : [];
    // AG Grid VIRTUALISE les colonnes : celles hors du champ de vision horizontal ne sont
    // pas dans le DOM. Compter les seules cellules peintes laissait croire a une absence
    // de marquage alors que les colonnes concernees etaient simplement a droite de l'ecran.
    const rendues = [...new Set(Array.from(document.querySelectorAll('.ag-cell')).map(c => c.getAttribute('col-id')))];
    const ambre = Array.from(document.querySelectorAll('.ag-cell'))
      .filter(c => getComputedStyle(c).backgroundColor === 'rgb(255, 248, 225)').length;
    const lignesMarquees = new Set(
      Array.from(document.querySelectorAll('.ag-row')).filter(l => {
        const bg = getComputedStyle(l).backgroundColor;
        return bg === 'rgb(198, 246, 213)' || bg === 'rgb(254, 215, 215)';
      }).map(l => l.getAttribute('row-index'))
    ).size;
    const champsVisibles  = champs.filter(c => rendues.includes(c));
    const champsHorsEcran = champs.filter(c => affichees.includes(c) && !rendues.includes(c));
    const champsMasques   = champs.filter(c => !affichees.includes(c));
    console.log(`[Revue] ${origine} — ${rows.length} ligne(s) | actions IA (ins/maj/suppr): ${resume} `
      + `| marqueurs: champs=${champsEnAttente.length} inseres=${inseres} supprimes=${supprimes} `
      + `| pendingCount=${pendingCount} | champs marques: ${champs.join(', ') || '(aucun)'} `
      + `| cellules ambre rendues: ${ambre} | lignes colorees: ${lignesMarquees}`);
    if (champsHorsEcran.length || champsMasques.length) {
      console.info(`[Revue] Colonnes marquees non visibles — defiler horizontalement pour les voir : `
        + `hors ecran: ${champsHorsEcran.join(', ') || 'aucune'}`
        + (champsMasques.length ? ` | masquees dans ce mode: ${champsMasques.join(', ')}` : ''));
    }
    // Ecart entre ce que le modele annonce et ce qui est reellement marque : signale ici en
    // plus du message affiche dans le fil, pour en garder une trace dans la console meme
    // apres que l'utilisateur a valide ou ferme la session.
    if (actionsResume) {
      const ecarts = [['inserted', inseres], ['updated', champsEnAttente.length], ['deleted', supprimes]]
        .filter(([cle, reel]) => (actionsResume[cle] || 0) !== reel)
        .map(([cle, reel]) => `${cle}: annonce ${actionsResume[cle] || 0} / marque ${reel}`);
      if (ecarts.length) {
        console.warn(`[Revue] Ecart annonce/marquage — ${ecarts.join(' | ')}`);
      }
    }
    if (pendingCount > 0 && champsEnAttente.length + inseres + supprimes === 0) {
      console.warn("[Revue] Le serveur annonce des propositions en attente mais AUCUN marqueur n'est arrive — copier ce log.");
    } else if (champsVisibles.length > 0 && ambre === 0) {
      console.warn("[Revue] Des colonnes marquees sont a l'ecran mais AUCUNE cellule n'est peinte — copier ce log.");
    }
    if (typesNonNumeriques > 0) {
      console.warn(`[Revue] ${typesNonNumeriques} ligne(s) avec un type non numerique — grisage et listes restreintes inoperants.`);
    }
  }, 0);
}

// Décompte construit a partir des marqueurs presents dans state.rows — donc de ce qui sera
// effectivement peint. Sert de source de verite pour le message "✓ Terminé", a la place du
// resume declaratif du LLM.
function _resumeDepuisMarqueurs() {
  const rows = state.rows || [];
  return {
    inserted: rows.filter(r => r.__pendingInsert).length,
    deleted:  rows.filter(r => r.__pendingDelete).length,
    updated:  rows.filter(r => !r.__pendingInsert && !r.__pendingDelete
                            && r.__pendingFields && Object.keys(r.__pendingFields).length).length,
  };
}

function onActDone(updatedRows, pendingCount, actionsResume, rapport) {
  state.rows = normaliserLignesEntrantes(updatedRows);
  if (typeof pendingCount === 'number') state.pendingCount = pendingCount;
  if (state.gridApi) {
    state.gridApi.setGridOption('rowData', [...updatedRows]);
    // Rafraîchir les styles de ligne après mise à jour par l'IA
    state.gridApi.redrawRows();
    // Filet de sécurité (cf. onCellValueChanged) : redrawRows seul ne réexécute pas
    // toujours les cellRenderer personnalisés (ex: colonne "Revue" sans field/valueGetter).
    if (state.reviewMode) {
      state.gridApi.refreshCells({ force: true });
      // Le contenu a changé sans forcément que la sélection change (ex: une ligne
      // sélectionnée vient d'être validée) — recalcule la visibilité des icônes d'en-tête.
      state.gridApi.refreshHeader();
    }
  }
  updateRowCount();
  // Synthese redigee par le LLM, avant le decompte : c'est la reponse a une demande du
  // type "fais un rapport de ce que tu as vu", que le contrat d'actions seul ne permettait
  // pas d'exprimer (le modele la logeait alors dans une colonne de donnees).
  if (rapport) addMessage('ai', rapport);
  // Le décompte annoncé est DÉRIVÉ des marqueurs réellement reçus, pas de ce que le LLM
  // déclare avoir fait : c'est la seule façon de garantir qu'il corresponde toujours à ce
  // qui est marqué à l'écran, puisque ce sont exactement les mêmes données qui pilotent le
  // rendu. Annoncer "30 lignes modifiées" sans rien de visible n'est alors plus possible.
  const resumeText = state.reviewMode
    ? buildActionsResumeText(_resumeDepuisMarqueurs())
    : (actionsResume ? buildActionsResumeText(actionsResume) : `${state.updatedCells} cellule(s) mise(s) à jour`);
  addMessage('system', `✓ Terminé — ${resumeText}.`);
  // Écart entre l'annonce du LLM et l'état réellement reçu : ne pas le masquer.
  if (state.reviewMode && actionsResume) {
    const reel = _resumeDepuisMarqueurs();
    const ecarts = ['inserted', 'updated', 'deleted']
      .filter(k => (actionsResume[k] || 0) !== (reel[k] || 0))
      .map(k => `${k} annoncé ${actionsResume[k] || 0} / retenu ${reel[k] || 0}`);
    if (ecarts.length) {
      addMessage('system', `ℹ️ L'assistant annonçait : ${buildActionsResumeText(actionsResume)} — `
        + `écart avec ce qui est marqué (${ecarts.join(', ')}). `
        + `Les propositions sans effet réel ne sont pas retenues.`);
    }
  }
  setStatusBadge('paused', 'Terminé');
  setStatusMessage(state.reviewMode ? 'Vérifie et valide les propositions IA ci-dessous.' : 'Vérifie et valide ou continue.');
  setAiRunning(false);
  hideProgress();
  updateReviewToolbar();
  tracerEtatRevue('act:done', pendingCount, actionsResume);
}

// ── Revue par pending — synchronisation après approve/reject (mode revueParPending) ──
function onReviewSync(msg) {
  state.rows        = normaliserLignesEntrantes(msg.rows || []);
  state.pendingCount = msg.pendingCount || 0;
  if (state.gridApi) {
    state.gridApi.setGridOption('rowData', [...state.rows]);
    state.gridApi.redrawRows();
    // Filet de sécurité (cf. onCellValueChanged / onActDone) : redrawRows seul ne
    // réexécute pas toujours les cellRenderer personnalisés sans field/valueGetter.
    state.gridApi.refreshCells({ force: true });
    // Le contenu a changé sans forcément que la sélection change — recalcule la
    // visibilité des icônes d'en-tête.
    state.gridApi.refreshHeader();
  }
  updateRowCount();
  updateReviewToolbar();
  updateMoveButtonsState();
}

// ── Barre de revue globale + bouton "Valider et exporter" (mode revue) ────────
// "Valider et exporter" masqué tant qu'il reste des propositions en attente — la
// validation/rejet se fait ligne par ligne, par champ, par sélection multiple via
// l'en-tête fusionné sélection+revue (ReviewHeaderComponent, agit sur la sélection),
// ou via la barre globale ci-dessous (agit sur TOUT le pending, sans rien cocher).
// Index AFFICHÉS (et non index dans state.rows) des lignes portant une proposition en
// attente, dans l'ordre de la grille. La distinction est essentielle : dès que le filtre
// "en attente seulement" est actif, les deux numérotations divergent, et c'est l'index
// affiché qu'attendent ensuite ensureIndexVisible/setFocusedCell/getFocusedCell.
function indexLignesEnAttente() {
  if (!state.gridApi) {
    const out = [];
    state.rows.forEach((row, i) => { if (hasPendingMarkerClient(row)) out.push(i); });
    return out;
  }
  const out = [];
  state.gridApi.forEachNodeAfterFilterAndSort((node) => {
    if (node.rowIndex !== null && node.rowIndex !== undefined && hasPendingMarkerClient(node.data)) {
      out.push(node.rowIndex);
    }
  });
  return out;
}

// Première colonne AFFICHÉE portant une proposition sur cette ligne (à défaut, la
// première colonne de données) — viser directement le champ modifié évite d'atterrir
// sur une cellule intacte, et place le curseur là où sont les ✓/✗ et le tooltip.
function colonneCiblePourLigne(rowIndexAffiche) {
  if (!state.gridApi) return null;
  const affichees = state.gridApi.getAllDisplayedColumns()
    .map(c => c.getColId())
    .filter(id => id !== '__select');
  const node = state.gridApi.getDisplayedRowAtIndex(rowIndexAffiche);
  const enAttente = node?.data?.__pendingFields ? Object.keys(node.data.__pendingFields) : [];
  return affichees.find(id => enAttente.includes(id)) || affichees[0] || null;
}

// Déplace le focus vers la proposition en attente suivante (sens > 0) ou précédente,
// en bouclant en fin de liste. Le compteur se met à jour via onCellFocused.
function allerLigneEnAttente(sens) {
  const indices = indexLignesEnAttente();
  if (!indices.length || !state.gridApi) return;
  const courant = state.gridApi.getFocusedCell()?.rowIndex ?? -1;
  const cible = sens > 0
    ? (indices.find(i => i > courant) ?? indices[0])
    : ([...indices].reverse().find(i => i < courant) ?? indices[indices.length - 1]);
  const cle = colonneCiblePourLigne(cible);
  state.gridApi.ensureIndexVisible(cible);
  if (cle) state.gridApi.setFocusedCell(cible, cle);
  // Rafraîchir explicitement : onCellFocused ne se déclenche pas de façon synchrone
  // sur un setFocusedCell programmatique (vérifié), le compteur resterait donc sur la
  // position précédente jusqu'au prochain clic de l'utilisateur dans la grille.
  updateReviewToolbar();
}

function updateReviewToolbar() {
  if (!state.reviewMode) return;
  const count = state.pendingCount || 0;
  if (count > 0) {
    hide('btn-validate');
    show('review-bar');
    const counter = el('review-counter');
    if (counter) {
      // X et Y sont dérivés de la MÊME liste, pour qu'ils ne puissent pas se contredire
      // le temps qu'un review:sync rafraîchisse state.pendingCount (repli sur ce dernier
      // si la grille n'est pas encore prête).
      const indices = indexLignesEnAttente();
      const total   = indices.length || count;
      const focus   = state.gridApi?.getFocusedCell?.()?.rowIndex ?? -1;
      const rang    = indices.indexOf(focus) + 1; // 0 si le focus n'est pas sur une ligne en attente
      counter.textContent = rang > 0
        ? `Ligne ${rang} sur ${total} en attente`
        : `${total} ligne${total > 1 ? 's' : ''} en attente`;
    }
  } else {
    show('btn-validate');
    hide('review-bar');
    // Plus rien en attente : désarmer le filtre, sinon la grille resterait vide et
    // l'utilisateur n'aurait plus la barre de revue pour décocher la case.
    if (state.reviewFiltrePendingSeul) {
      state.reviewFiltrePendingSeul = false;
      const chk = el('chk-review-filter');
      if (chk) chk.checked = false;
      state.gridApi?.onFilterChanged();
    }
  }
}

// ── Export prêt ───────────────────────────────────────────────────────────────
function onExportReady(msg) {
  el('download-message').textContent = msg.message || 'Fichier prêt.';
  el('download-link').href           = msg.downloadUrl;
  el('download-link').download       = msg.fileName;
  show('download-bar');
  addMessage('system', `📊 Export prêt : ${msg.fileName}`);
}

// ── Session cancelled ─────────────────────────────────────────────────────────
function onSessionCancelled() {
  setStatusBadge('cancelled', 'Annulé');
  setStatusMessage('Session annulée.');
  addMessage('system', 'Session annulée. Fermeture…');
  setAiRunning(false);
  disableAllControls();
  setTimeout(() => window.close(), 800);
}

// ── Session done ──────────────────────────────────────────────────────────────
function onSessionDone(exportFallback = false) {
  setStatusBadge('done', 'Terminé');
  if (exportFallback) {
    setStatusMessage('Export Excel généré — téléchargement en cours…');
    addMessage('system', '📥 Téléchargement du fichier Excel…');
    // Déclencher le téléchargement automatique → va dans Téléchargements via le navigateur
    setTimeout(async () => {
      const link = el('download-link');
      if (link && link.href) {
        try {
          const response = await fetch(link.href, { method: 'HEAD' });
          if (response.ok) {
            link.click();                    // Un seul clic → téléchargement dans Téléchargements
            hide('download-bar');            // Succès → on cache la barre
          }
        } catch {
          // Échec → on laisse la barre visible, l'utilisateur peut cliquer manuellement
        }
      }
    }, 300);
    setTimeout(() => {
      addMessage('system', '✓ Traitement terminé. Vous pouvez fermer cette fenêtre.');
    }, 3000);
  } else {
    setStatusMessage('Résultat envoyé.');
    addMessage('system', '✓ Résultat envoyé à XSpro. Tu peux fermer cette fenêtre.');
  }
  setAiRunning(false);
  disableAllControls();
  if (!exportFallback) {
    setTimeout(() => window.close(), 800);
  }
}

// ── Changement de statut ──────────────────────────────────────────────────────
function onStatusChange(status) {
  state.status = status;
  const map = {
    idle:       ['idle',      'En attente'],
    connected:  ['connected', 'Connecté'],
    planning:   ['planning',  'Planification…'],
    acting:     ['acting',    libelleTraitement()],
    paused:     ['paused',    'En pause'],
    delivering: ['delivering','Envoi…'],
    done:       ['done',      'Terminé'],
    cancelled:  ['cancelled', 'Annulé'],
    error:      ['error',     'Erreur'],
  };
  const [cls, label] = map[status] || ['idle', status];
  setStatusBadge(cls, label);
  setAiRunning(['planning', 'acting', 'delivering'].includes(status));
  if (['planning', 'acting'].includes(status)) initProgress();
}

// ── Bind UI ───────────────────────────────────────────────────────────────────
function bindUI() {
  // Mode Plan / Act
  document.querySelectorAll('.btn-mode').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-mode').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.mode = btn.dataset.mode;
    });
  });

  // Suggestion → textarea
  el('prompt-suggestions').addEventListener('change', (e) => {
    if (e.target.value) {
      el('prompt-input').value = e.target.value;
      e.target.value = '';
      el('prompt-input').focus();
      // Affectation directe de .value → ne déclenche pas l'event 'input' dont dépend
      // updateSendButtonState (cf. écouteur plus bas) : sans cet appel explicite, le
      // bouton d'envoi restait grisé après le choix d'une suggestion tant que le champ
      // était vide auparavant, jusqu'à une frappe manuelle supplémentaire.
      updateSendButtonState();
    }
  });

// Envoi prompt
  el('btn-send').addEventListener('click', sendPrompt);
  el('prompt-input').addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'Enter') sendPrompt(); });
  el('prompt-input').addEventListener('input', updateSendButtonState);

  // Mode de travail (work mode) — changement
  el('work-mode-selector').addEventListener('change', (e) => {
    onWorkModeChange(e.target.value || null);
    // Mettre à jour le tooltip avec la description du mode sélectionné
    const sel = e.target;
    const modeId = sel.value;
    const mode = state.modes[modeId];
    sel.title = mode?.description || mode?.label || modeId || 'Mode de travail';
  });

  // Actions session
  el('btn-validate').addEventListener('click', () => {
    if (!confirm('Valider et envoyer le résultat ?')) return;
    sendWS({ type: 'session:validate' });
    addMessage('system', 'Envoi du résultat…');
  });

  el('btn-reset').addEventListener('click', () => {
    if (!confirm('Réinitialiser toutes les données ?')) return;
    sendWS({ type: 'session:reset' });
    // Le serveur remet dernierEnvoi a null (resetRows) : l'entree du menu doit se
    // refermer en meme temps, sinon elle promettrait un contenu disparu.
    state.unEnvoiAEuLieu = false;
    addMessage('system', '↺ Données réinitialisées.');
  });

  el('btn-cancel').addEventListener('click', () => {
    if (!confirm('Annuler la session ?')) return;
    sendWS({ type: 'session:cancel' });
    setTimeout(() => window.close(), 800);
  });

  // Barre de revue globale (mode revueParPending) — agit sur TOUT le pending, pas
  // seulement la sélection courante (complément de l'en-tête ReviewHeaderComponent).
  const btnReviewApproveAll = el('btn-review-approve-all');
  if (btnReviewApproveAll) btnReviewApproveAll.addEventListener('click', () => {
    const ids = state.rows.filter(hasPendingMarkerClient).map(r => r._id).filter(id => id !== undefined);
    if (!ids.length) return;
    sendWS({ type: 'review:approveRows', ids });
  });
  const btnReviewRejectAll = el('btn-review-reject-all');
  if (btnReviewRejectAll) btnReviewRejectAll.addEventListener('click', () => {
    const ids = state.rows.filter(hasPendingMarkerClient).map(r => r._id).filter(id => id !== undefined);
    if (!ids.length) return;
    if (!confirm('Rejeter toutes les modifications en attente ?')) return;
    sendWS({ type: 'review:rejectRows', ids });
  });

  // Navigation d'une proposition à l'autre + filtre "en attente seulement" — pensés
  // pour un lot volumineux (dérouler 30 propositions sans les chercher à la souris).
  const btnReviewPrev = el('btn-review-prev');
  if (btnReviewPrev) btnReviewPrev.addEventListener('click', () => allerLigneEnAttente(-1));
  const btnReviewNext = el('btn-review-next');
  if (btnReviewNext) btnReviewNext.addEventListener('click', () => allerLigneEnAttente(1));

  const chkReviewFilter = el('chk-review-filter');
  if (chkReviewFilter) chkReviewFilter.addEventListener('change', () => {
    state.reviewFiltrePendingSeul = chkReviewFilter.checked;
    state.gridApi?.onFilterChanged();
    updateReviewToolbar(); // les index affichés changent → le rang "X sur Y" aussi
    updateRowCount();      // ...et le dénominateur de "Ligne X / N" 
  });

  // Actions grille
  el('btn-add-row').addEventListener('click', () => addRowAfterSelected());
  el('btn-delete-rows').addEventListener('click', () => deleteSelectedRows());
  el('btn-move-up').addEventListener('click', () => moveSelectionUp());
  el('btn-move-down').addEventListener('click', () => moveSelectionDown());
  el('btn-move-after').addEventListener('click', () => moveSelectionAfterFocused());

  // Download bar
  el('btn-download-close').addEventListener('click', () => hide('download-bar'));

  // Nouvelle tâche
  el('btn-newtask').addEventListener('click', () => {
    if (!confirm('Nouvelle tâche ? Les données modifiées seront conservées mais l\'historique sera effacé.')) return;
    sendWS({ type: 'session:newtask' });
  });

  // Pièces jointes
  el('btn-attach').addEventListener('click', () => el('file-input').click());
  el('file-input').addEventListener('change', async (e) => {
    for (const file of Array.from(e.target.files)) {
      try {
        const f = await readFileAsBase64(file);
        if (!state.attachedFiles.find(x => x.name === f.name)) state.attachedFiles.push(f);
      } catch { addMessage('error', `⚠ Impossible de lire ${file.name}`); }
    }
    renderChips();
    e.target.value = '';
  });

  // Splitter
  initSplitter();

  // Copier la requête dans le presse-papier (clic simple = bloc A, double-clic = complet)
  bindCopyPromptButton();

  // Scroll conversation
  bindConversationScroll();
}

// ── Consultation du prompt et de la réponse ────────────────────────────────────
/**
 * Le bouton 📋 ouvre un menu à deux entrées :
 *   - « Prompt envoyé et réponse » : ce qui a RÉELLEMENT été transmis au dernier appel,
 *     réponse comprise, restitué par le serveur (session.dernierEnvoi) sans recalcul ;
 *   - « Prompt prêt à être envoyé » : l'aperçu de ce qui partirait maintenant, avec la
 *     saisie et les fichiers en cours (buildPromptPreview).
 *
 * Remplace la distinction clic simple / double-clic (« prompt système » / « requête
 * complète ») : elle n'était pas devinable, le prompt système seul n'avait pas d'usage
 * propre, et elle copiait sans jamais rien montrer. Ici on affiche d'abord ; la copie
 * devient un geste explicite, confirmé par un toast qui nomme ce qui a été copié.
 */
function bindCopyPromptButton() {
  const btn = el('btn-copy-prompt');
  if (!btn) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    basculerMenuPrompt(btn);
  });

  el('prompt-menu').querySelectorAll('.popover-item').forEach(item => {
    item.addEventListener('click', () => {
      fermerMenuPrompt();
      demanderVuePrompt(item.dataset.vue);
    });
  });

  // Fermetures : clic ailleurs et Échap — sans quoi le menu resterait ouvert
  // par-dessus la grille.
  document.addEventListener('click', (e) => {
    if (!el('prompt-menu').contains(e.target)) fermerMenuPrompt();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    fermerMenuPrompt();
    if (!el('prompt-viewer').classList.contains('hidden')) fermerVuePrompt();
  });

  el('btn-prompt-close').addEventListener('click', fermerVuePrompt);
  el('prompt-viewer').addEventListener('click', (e) => {
    if (e.target === el('prompt-viewer')) fermerVuePrompt();   // clic sur le fond
  });
  el('btn-prompt-copy').addEventListener('click', () => {
    const v = state.vuePromptCourante;
    if (!v) return;
    copierAvecToast(v.texte, v.libelle);
  });
}

function basculerMenuPrompt(btn) {
  const menu = el('prompt-menu');
  if (!menu.classList.contains('hidden')) { fermerMenuPrompt(); return; }

  menu.classList.remove('hidden');

  // L'entrée « prompt envoyé » n'a de sens qu'après un appel : on la désactive plutôt
  // que de la masquer, pour que son existence reste visible.
  const envoye = menu.querySelector('[data-vue="envoye"]');
  envoye.disabled = !state.unEnvoiAEuLieu;
  envoye.title    = state.unEnvoiAEuLieu ? '' : "Aucune requête envoyée pour l'instant";

  // Positionné AU-DESSUS du bouton : la barre de saisie est en bas de la fenêtre, un
  // menu déroulant vers le bas sortirait du cadre. La hauteur n'est mesurable qu'une
  // fois le menu affiché, d'où l'ordre : retirer .hidden, puis positionner.
  const r = btn.getBoundingClientRect();
  const h = menu.offsetHeight;
  menu.style.left = Math.max(8, r.left) + 'px';
  menu.style.top  = Math.max(8, r.top - h - 6) + 'px';
}

function fermerMenuPrompt() { el('prompt-menu').classList.add('hidden'); }

function demanderVuePrompt(vue) {
  state.vuePromptDemandee = vue;
  if (vue === 'envoye') {
    sendWS({ type: 'prompt:dernierEnvoi' });
  } else {
    sendWS({
      type:       'prompt:preview',
      prompt:     el('prompt-input').value,
      mode:       state.mode,
      files:      [...state.attachedFiles],
      activeMode: state.activeWorkMode,
    });
  }
}

// Réception de l'aperçu « prêt à être envoyé »
function onPromptPreview(msg) {
  state.lastPromptPreview = { system: msg.system, full: msg.full };
  afficherVuePrompt({
    libelle: 'Prompt prêt à être envoyé',
    meta:    state.modeleIA ? 'destination : ' + state.modeleIA : '',
    texte:   formatFullPromptForDisplay(msg.full),
  });
}

// Réception de l'échange réellement transmis
function onPromptDernierEnvoi(msg) {
  if (!msg.present) {
    afficherToast("Aucune requête n'a encore été envoyée", true);
    return;
  }
  const heure = new Date(msg.horodatage).toLocaleTimeString();
  const corps = formatFullPromptForDisplay(msg.messages)
    + '\n\n=== RÉPONSE DU MODÈLE ===\n' + (msg.reponse || '(vide)');
  afficherVuePrompt({
    libelle: 'Prompt envoyé et réponse',
    meta:    (msg.modele || 'modèle inconnu') + ' · mode ' + (msg.mode || '?') + ' · ' + heure,
    texte:   corps,
  });
}

function afficherVuePrompt({ libelle, meta, texte }) {
  state.vuePromptCourante = { libelle, texte };
  el('prompt-viewer-title').textContent = libelle;
  el('prompt-viewer-meta').textContent  = meta || '';
  el('prompt-viewer-body').textContent  = texte;
  el('prompt-viewer').classList.remove('hidden');
}

function fermerVuePrompt() {
  el('prompt-viewer').classList.add('hidden');
  state.vuePromptCourante = null;
}

// Formate un tableau de messages OpenAI au format lisible pour humain
function formatFullPromptForDisplay(messages) {
  if (!Array.isArray(messages)) return String(messages);

  return messages.map((m) => {
    const roleHeader = {
      system: '=== SYSTEM PROMPT ===',
      user: '=== USER MESSAGE ===',
      assistant: '=== ASSISTANT RESPONSE ==='
    }[m.role] || ('=== ' + (m.role ? m.role.toUpperCase() : 'MESSAGE') + ' ===');

    // Le contenu peut être multi-part (texte + fichiers routés) : le rendre lisible
    // plutôt que d'afficher "[object Object]". Le cas se présente dès qu'un fichier
    // est joint, et c'est précisément là qu'on veut relire ce qui est parti.
    let content = m.content || '';
    if (Array.isArray(content)) {
      content = content.map(part => {
        if (typeof part === 'string')  return part;
        if (part && part.type === 'text')      return part.text || '';
        if (part && part.type === 'image_url') return '[image jointe]';
        return '[' + ((part && part.type) || 'partie') + ' jointe]';
      }).join('\n');
    } else if (typeof content !== 'string') {
      content = JSON.stringify(content, null, 2);
    }

    if (m.role === 'user' && Array.isArray(m.files) && m.files.length > 0) {
      const filesInfo = m.files.map(f => f.name + ' (' + f.mimeType + ')').join('\n');
      return roleHeader + '\n' + content + '\n\n📎 Fichiers joints :\n' + filesInfo;
    }

    return roleHeader + '\n' + content;
  }).join('\n\n');
}

// ── Toasts ─────────────────────────────────────────────────────────────────────
// Confirmation éphémère, là où se fait l'action. Elle partait auparavant dans le fil
// de conversation, mêlée aux messages de l'IA.
function afficherToast(message, estErreur = false) {
  const zone = el('toasts');
  if (!zone) return;
  const t = document.createElement('div');
  t.className = 'toast' + (estErreur ? ' toast-error' : '');
  t.textContent = message;
  zone.appendChild(t);
  // Lecture forcee du layout plutot que requestAnimationFrame : celui-ci ne se declenche
  // PAS tant que la page est masquee (onglet en arriere-plan). Le toast restait alors a
  // opacite 0 puis etait retire par son setTimeout, qui lui continue de tourner — donc
  // rien de visible au retour de l'utilisateur. Le reflow suffit a faire partir la
  // transition depuis l'etat initial.
  void t.offsetHeight;
  t.classList.add('visible');
  setTimeout(() => {
    t.classList.remove('visible');
    setTimeout(() => t.remove(), 240);
  }, 2600);
}

// Copie un texte dans le presse-papier et nomme ce qui a été copié
async function copierAvecToast(texte, quoi) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(texte);
    } else {
      // Repli (navigateur ancien, ou contexte non sécurisé)
      const ta = document.createElement('textarea');
      ta.value = texte;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    afficherToast('✓ ' + quoi + ' copié — ' + texte.length.toLocaleString('fr-FR') + ' caractères');
  } catch (e) {
    afficherToast('⚠ Copie impossible : ' + e.message, true);
  }
}

// ── Envoi du prompt ───────────────────────────────────────────────────────────
function sendPrompt() {
  const prompt   = el('prompt-input').value.trim();
  const hasFiles = state.attachedFiles.length > 0;
  if (!prompt && !hasFiles) { el('prompt-input').focus(); return; }
  if (state.isAiRunning) return;

  const msgEl = addMessage('user', prompt || '(fichiers joints)');
  if (hasFiles) {
    const div = document.createElement('div');
    div.className = 'conv-files';
    state.attachedFiles.forEach(f => {
      const tag = document.createElement('span');
      tag.className   = 'conv-file-tag';
      tag.textContent = `${getFileIcon(f.mimeType)} ${f.name}`;
      div.appendChild(tag);
    });
    msgEl.querySelector('.conv-bubble').appendChild(div);
  }

  state.userScrolled = false;
  initProgress();
  sendWS({ type: 'prompt:send', prompt, mode: state.mode, files: [...state.attachedFiles], activeMode: state.activeWorkMode });
  // Ouvre l'entree « prompt envoye » du menu. Le serveur reste seul juge : si l'appel
  // echoue, dernierEnvoi restera null et onPromptDernierEnvoi le dira par un toast.
  state.unEnvoiAEuLieu = true;
  el('prompt-input').value = '';
  state.attachedFiles = [];
  renderChips();
  setAiRunning(true);
  addMessage('system', state.reviewMode
    ? libelleTraitement()
    : libelleTraitement(`Traitement en mode ${state.mode === 'plan' ? 'Plan' : 'Act'}`));
}

// ── Modes de travail ────────────────────────────────────────────────────────────
/**
 * Remplit le sélecteur de mode de travail à partir des modes reçus du serveur.
 * Si un seul mode ou moins : le sélecteur reste caché (pas besoin de choisir).
 * Si plusieurs modes : le sélecteur apparaît.
 */
/**
 * Mode de travail sélectionné à l'ouverture de la session.
 *
 * Ordre : un mode déclarant `parDefaut: true` dans MODES (views/<vue>.js) l'emporte ;
 * sinon "standard" s'il existe ; sinon le premier mode déclaré. Le drapeau permet à une
 * vue d'ouvrir sur son mode d'usage courant sans imposer d'ordre particulier dans MODES.
 *
 * Fonction unique : la règle était écrite deux fois (sélecteur + premier onGridReady) et
 * devait donc être modifiée aux deux endroits sous peine de voir la liste afficher un mode
 * et la grille en appliquer un autre.
 */
function resolveDefaultModeId(modes) {
  const keys = Object.keys(modes || {});
  if (!keys.length) return null;
  return keys.find(k => modes[k]?.parDefaut) || (keys.includes('standard') ? 'standard' : keys[0]);
}

function populateWorkModeSelector(modes) {
  const sel = el('work-mode-selector');
  if (!sel) return;
  const keys = Object.keys(modes);
  // Un seul mode ou moins → pas de sélecteur
  if (keys.length <= 1) {
    sel.style.display = 'none';
    state.activeWorkMode = keys.length === 1 ? keys[0] : null;
    return;
  }
  // Plusieurs modes → afficher le sélecteur
  while (sel.options.length > 0) sel.remove(0);
  keys.forEach(id => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = modes[id].label || id;
    sel.appendChild(opt);
  });
  sel.style.display = 'inline-block';
  const defaultMode = resolveDefaultModeId(modes);
  sel.value = defaultMode;
  state.activeWorkMode = defaultMode;
  // Tooltip du <select> : description du mode actif (le title sur <option> n'est pas supporté par les navigateurs)
  sel.title = modes[defaultMode]?.description || modes[defaultMode]?.label || defaultMode;
}

/**
 * Repeuple le sélecteur de prompts suggérés avec les prompts
 * correspondant au mode de travail actif (ou aux prompts de base).
 */
function populatePromptSuggestions(promptsSuggeres) {
  const sel = el('prompt-suggestions');
  if (!sel) return;
  // Purger tous les groupes/options précédents (optgroups compris), en préservant
  // uniquement la première option placeholder "— Suggestions —".
  // Retrait par la FIN (et non par le début) : sel.firstChild est toujours le
  // placeholder lui-même, donc un test "suis-je le placeholder ?" AVANT retrait
  // s'arrêtait dès la 1ère itération sans jamais rien supprimer — c'était le bug
  // (les <optgroup> des modes précédents s'empilaient à chaque changement de mode).
  const placeholder = sel.options[0] && sel.options[0].value === '' ? sel.options[0] : null;
  while (sel.lastChild && sel.lastChild !== placeholder) {
    sel.removeChild(sel.lastChild);
  }
  if (!promptsSuggeres) return;

  // Un tableau plat (héritage mode dans une vue) → un unique groupe "Suggestion".
  if (Array.isArray(promptsSuggeres)) promptsSuggeres = { suggestion: promptsSuggeres };

  // Agrégation : ne garde que les catégories portant un tableau NON vide (jamais de groupe vide).
  const labelParCle = { creation: 'Création', synthese: 'Synthèse', analyse: 'Analyse', suggestion: 'Suggestion' };
  const groupes = [];
  for (const cle of Object.keys(promptsSuggeres)) {
    const list = promptsSuggeres[cle];
    if (!Array.isArray(list) || !list.length) continue;
    groupes.push({ cle, list });
  }

  // Les prompts rédigés côté XSpro (promptsParDefautAi.json) portent leurs propres
  // intertitres sous la forme « -- Titre -- » au milieu de la liste. Ce ne sont pas des
  // prompts : envoyés au LLM ils ne veulent rien dire. On les promeut donc en sous-groupes
  // réels (<optgroup> imbriqué visuellement), ce qui les rend non sélectionnables et
  // préserve le découpage voulu par l'auteur des prompts.
  const SEPARATEUR = /^\s*-{2,}\s*(.+?)\s*-{2,}\s*$/;

  for (const { cle, list } of groupes) {
    const libelleGroupe = labelParCle[cle] || cle;
    let cible = null;

    const nouveauGroupe = (label) => {
      const g = document.createElement('optgroup');
      g.label = label;
      sel.appendChild(g);
      return g;
    };

    for (const s of list) {
      const sep = SEPARATEUR.exec(s);
      if (sep) {
        // Intertitre → ouvre un sous-groupe « Groupe · Section », sans option sélectionnable.
        cible = nouveauGroupe(`${libelleGroupe} · ${sep[1]}`);
        continue;
      }
      // Prompts précédant tout intertitre → groupe principal, créé à la demande pour ne
      // jamais laisser un <optgroup> vide si la liste débute par une section.
      if (!cible) cible = nouveauGroupe(libelleGroupe);
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s.length > 46 ? s.slice(0, 43) + '…' : s;
      // Le libellé est tronqué à 46 caractères (certains prompts font plusieurs lignes) :
      // l'infobulle porte le texte intégral, consultable au survol dans la liste déroulée.
      // Posée sur l'<option> et non sur le <select> : après un choix, le select est
      // réinitialisé sur son placeholder (cf. écouteur 'change'), une infobulle sur lui
      // ne montrerait donc jamais le prompt retenu.
      opt.title = s;
      cible.appendChild(opt);
    }

    // Une section déclarée mais sans aucun prompt derrière laisserait un groupe vide.
    for (const g of Array.from(sel.querySelectorAll('optgroup'))) {
      if (!g.children.length) g.remove();
    }
  }
}

/**
 * Changement de mode de travail : met à jour l'affichage des colonnes,
 * les prompts suggérés, et envoie le nouveau mode actif au serveur.
 */
function onWorkModeChange(modeId) {
  
  state.activeWorkMode = modeId;
  const mode = state.modes[modeId];
  if (!mode) {
    // Aucun mode → tout afficher + restaurer les prompts de base
    state.gridApi.setColumnsVisible(
      state.workerConfig.colonnes.map(c => c.cle),
      true
    );
    populatePromptSuggestions(state.basePromptsSuggeres);
    return;
  }
  
  // Mettre à jour les formules dérivées pour ce mode (convertir les `code` strings en fonctions)
  const rawModeFormulas2 = state.colonnesDerivees[modeId] || {};
  state.derivedFormulas = {};
  for (const [champ, formula] of Object.entries(rawModeFormulas2)) {
    if (typeof formula.code === 'string') {
      try {
        state.derivedFormulas[champ] = new Function('row', 'selectChoix', formula.code);
      } catch (e) {
        console.warn(`[Grid] Erreur création fonction dérivée "${champ}":`, e.message);
        state.derivedFormulas[champ] = null;
      }
    }
  }
  state.colonnesDeriveesKeys = new Set(Object.keys(state.derivedFormulas).filter(k => state.derivedFormulas[k]));

  // Appliquer les surchargesColonnes du mode (fusion avec effectiveWorkerConfig)
  const effectiveCols = state.workerConfig.colonnes || [];
  
  const mergedCols = effectiveCols.map(col => {
    const modeOverride = mode.surchargesColonnes?.[col.cle];
    // null = pas de surcharge pour cette colonne
    if (modeOverride === null || modeOverride === undefined) return col;
    return { ...col, ...modeOverride };
  });

  // Ajouter les colonnes dérivées manquantes (non présentes dans workerConfig.colonnes)
  const existingKeys = new Set(mergedCols.map(c => c.cle));
  const derivedFormulas = state.colonnesDerivees[modeId] || {};
  for (const [champ, formula] of Object.entries(derivedFormulas)) {
    if (!existingKeys.has(champ)) {
      const modeOverride = mode.surchargesColonnes?.[champ] || {};
      mergedCols.push({
        champ,
        cle: champ,
        libelle: formula.libelle || champ,
        type: 'decimal',
        round: 2,
        ...modeOverride,
      });
    }
  }
  
  state.gridApi.setGridOption('columnDefs', buildColDefs(mergedCols));

  // Masquer les colonnes définies dans colonnesUiHidden (après rebuild des columnDefs)
  const hiddenKeys = new Set(mode.colonnesUiHidden || []);
  for (const col of state.workerConfig.colonnes) {
    state.gridApi.setColumnsVisible([col.cle], !hiddenKeys.has(col.cle));
  }

  // Mettre à jour les prompts suggérés avec ceux du mode
  if (mode.promptsSuggeres) {
    populatePromptSuggestions(mode.promptsSuggeres);
  } else {
    // Si le mode n'a pas de promptsSuggeres, garder ceux de base
    populatePromptSuggestions(state.basePromptsSuggeres);
  }
}

// ── Conversation ──────────────────────────────────────────────────────────────
function addMessage(role, text) {
  const inner = el('conversation-inner');

  const wrap   = document.createElement('div');
  wrap.className = `conv-msg conv-msg-${role === 'user' ? 'user' : role === 'system' ? 'system' : 'ai'}`;
  if (role === 'plan')  wrap.classList.add('conv-plan');
  if (role === 'error') wrap.classList.add('conv-msg-error');

  const bubble = document.createElement('div');
  bubble.className = 'conv-bubble';

  if ((role === 'ai' || role === 'plan') && typeof marked !== 'undefined') {
    bubble.innerHTML = marked.parse(text, { breaks: true, gfm: true });
  } else {
    bubble.textContent = text;
  }

  wrap.appendChild(bubble);
  inner.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

function bindConversationScroll() {
  const conv = el('conversation');
  conv.addEventListener('scroll', () => {
    state.userScrolled = (conv.scrollHeight - conv.scrollTop - conv.clientHeight) > 40;
  });
}

function scrollToBottom(force = false) {
  const conv = el('conversation');
  if (force || !state.userScrolled) {
    requestAnimationFrame(() => { conv.scrollTop = conv.scrollHeight; });
  }
}

// ── Fichiers ──────────────────────────────────────────────────────────────────
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => {
      const [header, data] = r.result.split(',');
      const mimeType = header.match(/:(.*?);/)?.[1] || 'application/octet-stream';
      resolve({ name: file.name, mimeType, data, size: file.size, sizeLabel: fmtSize(file.size) });
    };
    r.onerror = () => reject(new Error('Erreur lecture'));
    r.readAsDataURL(file);
  });
}

function renderChips() {
  const c = el('attachments-chips');
  c.innerHTML = '';
  if (!state.attachedFiles.length) { hide('attachments-bar'); return; }
  show('attachments-bar');
  state.attachedFiles.forEach((f, i) => {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    // Avertissement si le type n'est pas supporté par le provider courant
    const unsupported = state.supportedTypes.length > 0 && !isFileSupported(f);
    if (unsupported) chip.classList.add('chip-unsupported');
    const warn = unsupported ? ' ⚠' : '';
    chip.innerHTML = `<span class="chip-icon">${getFileIcon(f.mimeType)}</span><span class="chip-name" title="${f.name}${unsupported ? ' — type non supporté par ce provider' : ''}">${trunc(f.name, 20)}${warn}</span><span class="chip-size">${f.sizeLabel}</span><button class="chip-remove" data-i="${i}">✕</button>`;
    c.appendChild(chip);
  });
  c.querySelectorAll('.chip-remove').forEach(b => b.addEventListener('click', e => {
    state.attachedFiles.splice(+e.target.dataset.i, 1); renderChips();
  }));
}

// Vérifie si le fichier est supporté par le provider courant
function isFileSupported(file) {
  if (!state.supportedTypes.length) return true;
  const ext = '.' + file.name.split('.').pop().toLowerCase();
  // Correspondance simple extension → type
  const typeMap = {
    pdf: ['.pdf'],
    image: ['.jpg','.jpeg','.png','.gif','.webp','.svg'],
    text: ['.txt','.csv','.json','.md','.yaml','.yml','.log','.sql','.xml','.js','.ts','.py'],
    xlsx: ['.xlsx','.xls'],
    docx: ['.docx','.doc'],
  };
  return state.supportedTypes.some(typeId => typeMap[typeId]?.includes(ext));
}

function getFileIcon(m) {
  if (m.startsWith('image/'))  return '🖼';
  if (m === 'application/pdf') return '📄';
  if (m.includes('sheet') || m.includes('excel') || m.includes('csv')) return '📊';
  if (m.includes('word') || m.includes('document')) return '📝';
  if (m.startsWith('text/'))   return '📃';
  return '📎';
}

// ── Splitter horizontal (panneaux gauche / droite) ──────────────────────────
function initSplitter() {
  const splitter  = el('splitter');
  const panelLeft = el('panel-left');
  if (!splitter || !panelLeft) return;

  let dragging = false, startX = 0, startWidth = 0;
  const MIN = 220, MAX = 600;

  splitter.addEventListener('mousedown', (e) => {
    dragging    = true;
    startX      = e.clientX;
    startWidth  = panelLeft.getBoundingClientRect().width;
    splitter.classList.add('dragging');
    document.body.style.cursor     = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = Math.min(MAX, Math.max(MIN, startWidth + e.clientX - startX));
    panelLeft.style.width = `${w}px`;
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove('dragging');
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
    if (state.gridApi) state.gridApi.sizeColumnsToFit();
  });

  // ── Splitter vertical (conversation / saisie) ─────────────────────────
  initSplitterVertical();
}

function initSplitterVertical() {
  const splitterV = el('splitter-v');
  const promptInput = el('prompt-input');
  const panelLeft = el('panel-left');
  if (!splitterV || !promptInput) return;

  let dragging = false, startY = 0, startHeight = 0, maxHeight = 0;
  const MIN_INPUT = 60;

  splitterV.addEventListener('mousedown', (e) => {
    dragging    = true;
    startY      = e.clientY;
    startHeight = promptInput.getBoundingClientRect().height;
    // La textarea ne peut pas dépasser la moitié du panneau gauche
    // pour que la réponse IA reste toujours visible
    maxHeight = Math.max(MIN_INPUT, panelLeft.clientHeight * 0.5);
    splitterV.classList.add('dragging'); promptInput.classList.add('splitter-active');
    document.body.style.cursor     = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    // Tirer le splitter vers le BAS → agrandir la textarea
    const h = Math.min(maxHeight, Math.max(MIN_INPUT, startHeight - (e.clientY - startY)));
    promptInput.style.height = `${h}px`;
    promptInput.style.minHeight = '0';
    promptInput.style.resize = 'none';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    splitterV.classList.remove('dragging'); promptInput.classList.remove('splitter-active');
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
  });

  // Double-clic : réinitialiser la hauteur de la textarea
  splitterV.addEventListener('dblclick', () => {
    promptInput.style.height = '';
    promptInput.style.minHeight = '';
    promptInput.style.resize = '';
  });
}

// ── Progression ───────────────────────────────────────────────────────────────
function initProgress() {
  state.updatedCells = 0;
  const colsLLM  = (state.workerConfig?.colonnes || []).filter(c => !c.placeholder);
  state.totalCells = state.rows.length * colsLLM.length;
  show('status-progress');
  updateProgress();
}

function updateProgress() {
  if (!state.totalCells) return;
  const pct = Math.min(100, Math.round(state.updatedCells / state.totalCells * 100));
  el('progress-fill').style.width  = `${pct}%`;
  el('progress-label').textContent = `${state.updatedCells}/${state.totalCells}`;
}

function hideProgress() { hide('status-progress'); state.updatedCells = 0; }

// ── Fonction de calcul des valeurs dérivées ─────────────────────────────────────
// Les formules sont définies dans la vue (detailsDevis.js) sous forme de `code` string
// et sont converties en fonctions ici via new Function().
// Chaque fonction reçoit (row, selectChoix) et doit retourner une valeur.
function computeDerivedValue(champ, row, selectChoix) {
  if (!row) return '';
  const fn = state.derivedFormulas[champ];
  if (!fn || typeof fn !== 'function') return '';
  try {
    return fn(row, selectChoix || {});
  } catch (e) {
    return '';
  }
}

// ── Helpers UI ────────────────────────────────────────────────────────────────
// Indicateur de position dans la barre d'outils : "N lignes" tant qu'aucune cellule n'a
// le focus, puis "Ligne X / N" des qu'on clique une cellule (ou qu'on navigue au clavier).
// Distinct du compteur du bandeau de revue, qui situe la proposition courante dans le lot
// en attente : l'un repond a "ou suis-je dans la grille", l'autre a "quelle proposition
// je regarde". Les deux coexistent volontairement.
function updateRowCount() {
  const cible = el('status-rows');
  if (!cible) return;
  const total = state.rows.length;
  const focus = state.gridApi?.getFocusedCell?.();
  // getFocusedCell renvoie un index AFFICHE : avec le filtre "en attente seulement",
  // numerateur et denominateur parlent donc du meme ensemble, celui que l'utilisateur a
  // sous les yeux. La mention "filtrees" signale que ce n'est pas la numerotation complete.
  const affichees = state.gridApi?.getDisplayedRowCount?.() ?? total;
  // La borne haute est indispensable : en activant le filtre, la ligne focalisee peut
  // sortir de l'ensemble affiche et l'on afficherait un "Ligne 4 / 2" absurde.
  if (focus && focus.rowIndex >= 0 && focus.rowIndex < affichees) {
    cible.textContent = `Ligne ${focus.rowIndex + 1} / ${affichees}${affichees !== total ? ' filtrées' : ''}`;
  } else if (affichees !== total) {
    cible.textContent = `${affichees} ligne${affichees > 1 ? 's' : ''} sur ${total}`;
  } else {
    cible.textContent = `${total} ligne${total > 1 ? 's' : ''}`;
  }
}

function setStatusBadge(cls, label) {
  const b = el('status-badge');
  b.className   = `badge-status status-${cls}`;
  b.textContent = label;
  // Le badge est etroit : si le nom du modele deborde, il reste lisible au survol.
  b.title       = state.modeleIA ? `Modele : ${state.modeleIA}` : '';
}

// Affiche le nom du LLM dans le badge permanent de l'en-tete, des l'ouverture
// (appele par onInit), et non uniquement en cours de requete. Sans modele connu
// on cache le badge plutot que d'afficher "🤖 null" — meme repli que
// libelleTraitement ci-dessous.
function updateModelBadge() {
  const b = el('model-badge');
  if (!b) return;
  if (state.modeleIA) {
    b.textContent = `🤖 ${state.modeleIA}`;
    b.title       = `Modèle IA : ${state.modeleIA}`;
    b.classList.remove('hidden');
  } else {
    b.textContent = '';
    b.title       = '';
    b.classList.add('hidden');
  }
}

// Nomme le modele qui travaille, quand le serveur l'a annonce. Repli sur le libelle
// generique : une session ouverte avant l'ajout de `modeleIA` ne doit pas afficher
// "Traitement par null".
function libelleTraitement(prefixe = 'Traitement') {
  return state.modeleIA ? `${prefixe} par ${state.modeleIA}…` : `${prefixe} IA…`;
}

function setStatusMessage(msg) { el('status-message').textContent = msg; }

// Met à jour l'état visuel du bouton send selon la présence d'un prompt
function updateSendButtonState() {
  const prompt = el('prompt-input').value.trim();
  const hasPrompt = prompt.length > 0 || state.attachedFiles.length > 0;
  const btnSend = el('btn-send');
  if (btnSend) {
    btnSend.classList.toggle('has-prompt', hasPrompt);
  }
}

function setAiRunning(running) {
  state.isAiRunning = running;
  if (state.gridApi) state.gridApi.refreshCells({ force: true });
  ['btn-send','btn-validate','btn-reset','btn-attach','btn-mode-plan','btn-mode-act','btn-add-row'].forEach(id => {
    const e = el(id); if (e) e.disabled = running;
  });
  // Supprimer désactivé pendant IA ET si rien de sélectionné
  el('btn-delete-rows').disabled = running || (state.gridApi?.getSelectedRows().length === 0);
  el('prompt-input').disabled     = running;
el('btn-send-label').innerHTML = running ? '…' : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6 Q5 12 4 18"/><path d="M20 12 L4 6"/><path d="M20 12 L4 18"/><line x1="4" y1="12" x2="14" y2="12"/></svg>';
  el('btn-send-spinner').classList.toggle('hidden', !running);
  // Boutons de déplacement : NE PAS les ajouter au forEach générique ci-dessus — il les
  // réactiverait aveuglément (running=false) sans revérifier les bornes de sélection.
  updateMoveButtonsState();
}

function disableAllControls() {
  // Désactive tous les contrôles SANS toucher au flag isAiRunning (spinner)
  el('btn-cancel').disabled   = true;
  el('btn-validate').disabled = true;
  el('btn-send').disabled     = true;
  el('btn-reset').disabled    = true;
  el('btn-attach').disabled   = true;
  el('prompt-input').disabled = true;
  el('btn-add-row').disabled  = true;
  el('btn-delete-rows').disabled = true;
  el('btn-move-up').disabled    = true;
  el('btn-move-down').disabled  = true;
  el('btn-move-after').disabled = true;
}

function sendWS(data) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(data));
  else addMessage('error', '⚠ WebSocket non connecté');
}

// ── Utilitaires ───────────────────────────────────────────────────────────────
function el(id)   { return document.getElementById(id); }
function show(id) { el(id)?.classList.remove('hidden'); }
function hide(id) { el(id)?.classList.add('hidden'); }
function trunc(s, n) { return s.length <= n ? s : s.slice(0, n - 1) + '…'; }
function fmtSize(b) {
  if (!b) return '';
  if (b < 1024) return `${b}o`;
  if (b < 1048576) return `${(b / 1024).toFixed(0)}Ko`;
  return `${(b / 1048576).toFixed(1)}Mo`;
}
/**
 * AI Worker — grid.js
 * Layout deux panneaux : conversation à gauche, grille à droite.
 *
 * Sémantique colonnes :
 *   - rien          → libre, IA et user peuvent modifier
 *   - readOnly:true → IA peut écrire, user NE PEUT PAS modifier manuellement
 *   - placeholder:true → valeur imposée par défaut, IA N'Y TOUCHE PAS, user peut modifier
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
   pendingCopy:        null,    // 'system' | 'full' — type de copie en attente de l'aperçu serveur
   lastPromptPreview:  null,    // { system, full } — dernier aperçu reçu du serveur
   styleOverrides:     {},      // { [rowIndex]: { color?, bgColor?, className? } } — surcharge via cell:rowStyle
   cellStyleOverrides: {},      // { "rowIndex:cle": { ... } } — surcharge cellule via cell:validate
   onCellEdit:         null,    // callback(rowIndex, cle, newValue) définie par la vue
 };

// ── Init ──────────────────────────────────────────────────────────────────────
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
    case 'act:done':          onActDone(msg.rows);                           break;
    case 'export:ready':      onExportReady(msg);                            break;
    case 'session:done':      onSessionDone(msg.exportFallback);            break;
    case 'session:cancelled': onSessionCancelled();                         break;
    case 'prompt:preview':    onPromptPreview(msg);                         break;
    case 'error':             addMessage('error', `⚠ ${msg.message}`); onStatusChange('error'); break;
    default: console.warn('[WS] inconnu :', msg.type);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
function onInit(msg) {
  state.workerConfig = msg.workerConfig;
  state.rows         = msg.rows || [];

  console.log('[Payload XSpro]', msg.xsproPayload);

  document.title                 = `AI Worker — ${msg.contextName}`;
  el('context-name').textContent = msg.contextName;

  const p = msg.infosParent || {};
  if (p.client)  el('info-client').textContent  = `👤 ${p.client}`;
  if (p.affaire) el('info-affaire').textContent = `📁 ${p.affaire}`;
  if (p.client && p.affaire) show('info-sep');

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

  // SelectChoix pour les dropdowns
  state.selectChoix = msg.selectChoix || {};

  // Styles de ligne définis par le hook vue
  state.rowStyles = msg.rowStyles || [];

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

// ── AG Grid ───────────────────────────────────────────────────────────────────
function initGrid(colonnes, rows) {
  const gridOptions = {
    columnDefs:   buildColDefs(colonnes),
    rowData:      rows,
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
            state.rows[rowIndex][colId] = '';
            const node = params.node;
            if (node) {
              node.setDataValue(colId, '');
// Flash manuel sur la bonne colonne (plus de enableCellChangeFlash)
               state.gridApi.flashCells({ rowNodes: [node], columns: [colId], flashDuration: 150, fadeDuration: 400 });
            }
            // Envoyer la modification au serveur
            sendWS({ type: 'cell:edit', rowIndex, cle: colId, value: '' });
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
        // Déterminer le mode par défaut : "standard" s'il existe, sinon le premier mode disponible
        const modes = state.modes || {};
        const modeKeys = Object.keys(modes);
        const defaultModeId = modeKeys.includes('standard') ? 'standard' : (modeKeys.length > 0 ? modeKeys[0] : null);
        const defaultMode = modes[defaultModeId];

        if (defaultMode) {
          state.activeWorkMode = defaultModeId;
          // Appliquer les surcharges du mode par défaut (colonnes, visibilité, prompts)
          onWorkModeChange(defaultModeId);
        }
      }
    },
    
    onCellFocused: (params) => {
      // Rediriger le focus si on arrive sur le header (rowIndex négatif)
      const colId = params.previousColumn?.getColId() || params.column?.getColId() || state.workerConfig?.colonnes?.[0]?.cle;
      if (params.rowIndex < 0 && state.rows.length > 0 && colId) {
        setTimeout(() => {
          state.gridApi.setFocusedCell(0, colId);
        }, 0);
      }
    },

    onCellValueChanged: (params) => {
      console.log(`[DEBUG-GRID] onCellValueChanged source="${params.source}" cle="${params.column.getColId()}" newValue="${JSON.stringify(params.newValue)}" oldValue="${JSON.stringify(params.oldValue)}"`);
      // Ne pas traiter les changements émis par node.setDataValue() (source 'api')
      if (params.source !== 'api') {
        const rowIndex = params.node.rowIndex;
        const cle      = params.column.getColId();
        if (state.rows[rowIndex]) {
          console.log(`[DEBUG-GRID] envoie cell:edit rowIndex=${rowIndex} cle="${cle}" value="${JSON.stringify(params.newValue)}"`);
          sendWS({ type: 'cell:edit', rowIndex, cle, value: params.newValue });
state.gridApi.flashCells({ rowNodes: [params.node], columns: [cle], flashDuration: 150, fadeDuration: 400 });

          // Plus besoin de recalcul de hauteur - hauteur fixe de 40px pour toutes les lignes
          // Forcer le redessin pour appliquer les modifications
          state.gridApi.redrawRows({ rowNodes: [params.node] });
        }
      } else {
        console.log(`[DEBUG-GRID] source="api" ignoré (programmatique)`);
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
    },

    getRowStyle: (params) => {
      const row = params.data;
      const rowIndex = params.node.rowIndex;
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
function TextareaCellEditor() {}
TextareaCellEditor.prototype.init = function(params) {
  this.textarea = document.createElement('textarea');
  // Gestion spéciale pour les arrays (choix, choixCorrect) : convertir en string avec \n
  let initialValue;
  if (params.value == null) {
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
};
TextareaCellEditor.prototype.autoGrow = function() {
  // Fonction conservée pour compatibilité mais non utilisée
};
TextareaCellEditor.prototype.getGui = function() { return this.textarea; };
TextareaCellEditor.prototype.getValue = function() { return this.textarea.value; };
TextareaCellEditor.prototype.isPopup = function() { return true; };
TextareaCellEditor.prototype.focusIn = function() { this.textarea.focus(); };
TextareaCellEditor.prototype.destroy = function() { this.textarea = null; };

// ── Construction des colonDefs ─────────────────────────────────────────────────
function buildColDefs(colonnes) {

  // Colonne de sélection (checkbox)
  const checkboxCol = {
    headerCheckboxSelection: true,
    checkboxSelection:       true,
    width:    40,
    minWidth: 40,
    maxWidth: 40,
    resizable:  false,
    sortable:   false,
    pinned:     'left',
  };

const dataCols = colonnes.map(col => {
    // Vérifier si cette colonne a un selectChoix
    const sc = state.selectChoix[col.cle];
    const hasSelectChoix = sc && Array.isArray(sc.choix) && sc.choix.length > 0;

    const def = {
      field:      col.cle,
      headerName: col.cle,
      width:      col.width   || 120,
      minWidth:   col.minWidth ?? (hasSelectChoix ? 100 : 40),
      pinned:     col.pinned  || null,
      hide:       col.hide    || false,

      // readOnly → user ne peut pas modifier | placeholder → user peut modifier
      // selectChoix → utilise le cellEditor agSelectCellEditor (édition via Entrée)
      editable: () => hasSelectChoix ? true : !col.readOnly && !state.isAiRunning,

      cellStyle: (params) => {
        const b = { fontSize: '12px' };
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
      ...(hasSelectChoix ? {
        cellEditor: 'agSelectCellEditor',
        cellEditorParams: {
          values: sc.choix.map(entry => entry.valeur),
          getOptionValue: (value) => value,
          getOptionLabel: (value) => {
            const entry = sc.choix.find(c => c.valeur === value);
            return entry ? entry.label : value;
          }
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
        const selected = sc.choix.find(c => c.valeur === p.value);
        return selected ? selected.label : p.value;
      };
    }

    // valueFormatter pour les colonnes numériques non selectChoix
    if (!hasSelectChoix && (col.type === 'decimal' || col.type === 'number')) {
      def.valueFormatter = (p) => {
        if (p.value === null || p.value === undefined || p.value === '') return '';
        const n = parseFloat(p.value);
        if (isNaN(n)) return p.value;
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
          const lines = newValue.split(/\n|,/).map(s => s.trim()).filter(Boolean);
          return lines; // Retourne un array
        }
        // Si déjà un array, le garder tel quel
        if (Array.isArray(newValue)) {
          return newValue;
        }
        return newValue ?? '';
      };
    }

    // CellRenderer pour les colonnes multilignes (hauteur dynamique)
    // Adapte la hauteur à 1 ou 2 lignes selon le contenu
    if (hasMultiligne && !isDerivee && !hasArrayField) {
      def.cellRenderer = (params) => {
        const span = document.createElement('span');
        const value = params.value;
        if (value !== null && value !== undefined && value !== '') {
          span.innerHTML = String(value).replace(/\n/g, '<br>');
          span.title = String(value);
          span.className = 'ag-cell-multiline';

          // Calculer si le contenu nécessite 1 ou 2 lignes
          const textContent = String(value).replace(/<br>/g, '\n');
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

    return def;
  });

  return [checkboxCol, ...dataCols];
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
      newRow[col.cle] = '';
    }
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

// ── Sync rows → serveur ───────────────────────────────────────────────────────
function syncRowsToServer() {
  sendWS({ type: 'rows:sync', rows: state.rows });
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
  const { rowIndex, invalidFields = [], message } = msg;
  const keyPrefix = `${rowIndex}:`;
  // Supprimer toutes les overrides de cellules pour cette ligne
  Object.keys(state.cellStyleOverrides).forEach(k => {
    if (k.startsWith(keyPrefix)) delete state.cellStyleOverrides[k];
  });
  if (invalidFields.length > 0) {
// Style rouge pour chaque champ invalide
    const invalidStyle = { background: '#FFEBEE', color: '#B71C1C', textDecoration: 'line-through' };
    invalidFields.forEach(cle => {
      state.cellStyleOverrides[`${rowIndex}:${cle}`] = invalidStyle;
    });
  }
  // Redraw seulement si la grille existe déjà (sinon les overrides sont stockés pour onGridReady)
  if (state.gridApi) {
    const node = state.gridApi.getDisplayedRowAtIndex(rowIndex);
    if (node) state.gridApi.redrawRows({ rowNodes: [node] });
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
    setStatusBadge('acting', 'Traitement IA…');
    setAiRunning(true);
  });

  actions.querySelector('#btn-plan-reject').addEventListener('click', () => {
    actions.remove();
    addMessage('system', 'Plan rejeté.');
    setStatusBadge('connected', 'Prêt');
  });
}

// ── Act terminé ───────────────────────────────────────────────────────────────
function onActDone(updatedRows) {
  state.rows = updatedRows;
  if (state.gridApi) {
    state.gridApi.setGridOption('rowData', [...updatedRows]);
    // Rafraîchir les styles de ligne après mise à jour par l'IA
    state.gridApi.redrawRows();
  }
  updateRowCount();
  addMessage('system', `✓ Terminé — ${state.updatedCells} cellule(s) mise(s) à jour.`);
  setStatusBadge('paused', 'Terminé');
  setStatusMessage('Vérifie et valide ou continue.');
  setAiRunning(false);
  hideProgress();
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
    acting:     ['acting',    'Traitement IA…'],
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
    }
  });

  // Envoi prompt
  el('btn-send').addEventListener('click', sendPrompt);
  el('prompt-input').addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'Enter') sendPrompt(); });

  // Mode de travail (work mode) — changement
  el('work-mode-selector').addEventListener('change', (e) => {
    onWorkModeChange(e.target.value || null);
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
    addMessage('system', '↺ Données réinitialisées.');
  });

  el('btn-cancel').addEventListener('click', () => {
    if (!confirm('Annuler la session ?')) return;
    sendWS({ type: 'session:cancel' });
    setTimeout(() => window.close(), 800);
  });

  // Actions grille
  el('btn-add-row').addEventListener('click', () => addRowAfterSelected());
  el('btn-delete-rows').addEventListener('click', () => deleteSelectedRows());

  // Download bar
  el('btn-download-close').addEventListener('click', () => hide('download-bar'));

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

// ── Copier la requête envoyée au LLM ───────────────────────────────────────────
/**
 * Clic simple  → copie le system prompt (bloc A) seul
 * Double-clic  → copie l'intégralité des messages qui seraient envoyés
 * Le prompt réel est reconstruit côté serveur (buildPromptPreview) pour être
 * identique à ce qui serait réellement transmis au LLM.
 */
function bindCopyPromptButton() {
  const btn = el('btn-copy-prompt');
  if (!btn) return;

  let clickTimer = null;

  btn.addEventListener('click', () => {
    if (clickTimer) return; // un double-clic est déjà en cours
    clickTimer = setTimeout(() => {
      clickTimer = null;
      requestPromptPreview('system');
    }, 220);
  });

  btn.addEventListener('dblclick', () => {
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    requestPromptPreview('full');
  });
}

// Demande au serveur l'aperçu du prompt réellement envoyé
function requestPromptPreview(kind) {
  state.pendingCopy = kind;
  sendWS({
    type:       'prompt:preview',
    prompt:     el('prompt-input').value,
    mode:       state.mode,
    files:      [...state.attachedFiles],
    activeMode: state.activeWorkMode,
  });
}

// Réception de l'aperçu depuis le serveur → déclenche la copie
function onPromptPreview(msg) {
  state.lastPromptPreview = { system: msg.system, full: msg.full };
  const kind = state.pendingCopy || 'system';
  state.pendingCopy = null;

  // Pour 'system' : texte seul ; pour 'full' : affichage lisible du tableau de messages
  const textToCopy = kind === 'system'
    ? msg.system
    : formatFullPromptForDisplay(msg.full);

  copyToClipboard(textToCopy, kind === 'system'
    ? '✓ Prompt (system) copié dans le presse-papier'
    : '✓ Requête complète copiée dans le presse-papier');
}

// Formate un tableau de messages OpenAI au format lisible pour humain
function formatFullPromptForDisplay(messages) {
  if (!Array.isArray(messages)) return String(messages);
  
  return messages.map((m, idx) => {
    const roleHeader = {
      system: '=== SYSTEM PROMPT ===',
      user: '=== USER MESSAGE ===',
      assistant: '=== ASSISTANT RESPONSE ==='
    }[m.role] || `=== ${m.role?.toUpperCase() || 'MESSAGE'} ===`;
    
    let content = m.content || '';
    
    // Formater les fichiers joints avec leurs noms et types
    if (m.role === 'user' && Array.isArray(m.files) && m.files.length > 0) {
      const filesInfo = m.files.map(f => `${f.name} (${f.mimeType})`).join('\n');
      return `${roleHeader}\n${content}\n\n📎 Fichiers joints :\n${filesInfo}`;
    }
    
    return `${roleHeader}\n${content}`;
  }).join('\n\n');
}

// Copie un texte dans le presse-papier puis affiche une confirmation en conversation
async function copyToClipboard(text, confirmMsg) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      // Fallback (anciens navigateurs / contexte non sécurisé)
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    addMessage('system', confirmMsg);
  } catch (e) {
    addMessage('error', `⚠ Copie impossible : ${e.message}`);
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
  el('prompt-input').value = '';
  state.attachedFiles = [];
  renderChips();
  setAiRunning(true);
  addMessage('system', `Traitement en mode ${state.mode === 'plan' ? 'Plan' : 'Act'}…`);
}

// ── Modes de travail ────────────────────────────────────────────────────────────
/**
 * Remplit le sélecteur de mode de travail à partir des modes reçus du serveur.
 * Si un seul mode ou moins : le sélecteur reste caché (pas besoin de choisir).
 * Si plusieurs modes : le sélecteur apparaît.
 */
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
  // Sélectionner "standard" si disponible, sinon le premier mode par défaut
  const defaultMode = keys.includes('standard') ? 'standard' : keys[0];
  sel.value = defaultMode;
  state.activeWorkMode = defaultMode;
}

/**
 * Repeuple le sélecteur de prompts suggérés avec les prompts
 * correspondant au mode de travail actif (ou aux prompts de base).
 */
function populatePromptSuggestions(promptsSuggeres) {
  const sel = el('prompt-suggestions');
  if (!sel) return;
  // Vider toutes les options (sauf la première "— Suggestions —")
  while (sel.options.length > 1) sel.remove(1);
  // Déterminer les prompts à afficher
  const isExport = state.workerConfig?.exportExcel === true;
  const prompts = isExport
    ? (promptsSuggeres?.creation || [])
    : (promptsSuggeres?.synthese || []);
  prompts.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s.length > 46 ? s.slice(0, 43) + '…' : s;
    sel.appendChild(opt);
  });
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
function updateRowCount() {
  el('status-rows').textContent = `${state.rows.length} ligne${state.rows.length > 1 ? 's' : ''}`;
}

function setStatusBadge(cls, label) {
  const b = el('status-badge');
  b.className   = `badge-status status-${cls}`;
  b.textContent = label;
}

function setStatusMessage(msg) { el('status-message').textContent = msg; }

function setAiRunning(running) {
  state.isAiRunning = running;
  if (state.gridApi) state.gridApi.refreshCells({ force: true });
  ['btn-send','btn-validate','btn-reset','btn-attach','btn-mode-plan','btn-mode-act','btn-add-row'].forEach(id => {
    const e = el(id); if (e) e.disabled = running;
  });
  // Supprimer désactivé pendant IA ET si rien de sélectionné
  el('btn-delete-rows').disabled = running || (state.gridApi?.getSelectedRows().length === 0);
  el('prompt-input').disabled     = running;
  el('btn-send-label').textContent = running ? '…' : '↑';
  el('btn-send-spinner').classList.toggle('hidden', !running);
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
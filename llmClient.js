/**
 * AI Worker — llmClient.js
 * Orchestre l'appel au LLM et le traitement de la réponse.
 *
 * Routing fichiers :
 *   ia.provider → providers.js → getHandler(typeId)
 *   file.mimeType → fileTypes.js → resolveFileType(typeId)
 *   handlerName → fileHandlers.js → runHandler(handlerName, file, providerId)
 *
 * La fusion MANIFEST / workerConfig est désormais gérée par viewResolver.js.
 * Ce module consomme session.effectiveWorkerConfig et session.viewHook,
 * calculés une seule fois à la création de la session.
 */

'use strict';

const SM                               = require('./sessionManager');
const { resolveProvider, getHandler }  = require('./providers');
const { FILE_TYPES, resolveFileType }  = require('./fileTypes');
const { runHandler }                   = require('./fileHandlers');

// ── Point d'entrée principal ──────────────────────────────────────────────────
/**
 * @param {Object}       session     — session courante
 * @param {string|null}  userPrompt  — texte utilisateur
 * @param {'plan'|'act'} mode
 * @param {Object}       callbacks   — { onPlan, onCellUpdate, onDone }
 * @param {Array}        files       — [{ name, mimeType, data (base64), size }]
 */
async function run(session, userPrompt, mode, callbacks, files = []) {
  const { ia, data } = session;
  const { onPlan, onCellUpdate, onDone } = callbacks;

  // ── 1. Résolution du provider ───────────────────────────────────────────────
  const { id: providerId } = resolveProvider(ia);
  console.log(`[LLM] Provider résolu : ${providerId}`);

  // ── 2. Config effective et hook vue (calculés une fois par viewResolver.js) ─
  // effectiveWorkerConfig = workerConfig fusionné avec le MANIFEST du hook vue.
  // viewHook              = module views/<viewModule>.js (ou null).
  const effectiveWorkerConfig = session.effectiveWorkerConfig;
  const viewHook              = session.viewHook || null;

  // ── 2b. selectChoix et mode actif ───────────────────────────────────────────
  const selectChoix = session.selectChoix || {};

  // Mode actif et ses surcharges
  const activeModeId = session.activeMode;
  const activeMode   = activeModeId ? (session.modes?.[activeModeId] || null) : null;
  const hiddenKeys   = new Set(activeMode?.colonnesLlmHidden || []);

  // Construire un effectiveWorkerConfig surchargé par le mode actif
  const overriddenConfig = { ...effectiveWorkerConfig };
  if (activeMode) {
    if (activeMode.systemPrompt)    overriddenConfig.systemPrompt    = activeMode.systemPrompt;
    if (activeMode.regles)          overriddenConfig.regles          = activeMode.regles;
    if (activeMode.modele)          overriddenConfig.modele          = activeMode.modele;
    if (activeMode.promptsSuggeres) overriddenConfig.promptsSuggeres = activeMode.promptsSuggeres;
    if (activeMode.formatReponse)   overriddenConfig.formatReponse   = activeMode.formatReponse;
    if (activeMode.editionParActions !== undefined) overriddenConfig.editionParActions = activeMode.editionParActions;
  }

  // ── Appliquer les surchargesColonnes du mode actif (fusion avec MANIFEST) ───
  const modeSurcharges = activeMode?.surchargesColonnes || {};
  const mergedColonnes = overriddenConfig.colonnes.map(col => {
    const modeOverride = modeSurcharges[col.champ];
    return modeOverride ? { ...col, ...modeOverride } : col;
  });
  overriddenConfig.colonnes = mergedColonnes;

  // ── 3. Colonnes actives (tout sauf placeholder + masquées par le mode) ────
  const colonnes = overriddenConfig.colonnes || [];
  const colsLLM  = colonnes.filter(c => !c.placeholder && !hiddenKeys.has(c.cle));

  // ── 4. System prompt (+ additions du hook vue) ─────────────────────────────
  const systemPrompt = buildSystemPrompt(overriddenConfig, data, colsLLM, viewHook, mode);

  // ── 5. Rows avec valeurs par défaut + hook vue ─────────────────────────────
  const rowsWithDefaults = applyPlaceholderDefaults(
    session.rows, colonnes, effectiveWorkerConfig.regles, viewHook
  );

  // ── 6. Message utilisateur ─────────────────────────────────────────────────
  const editionParActions = overriddenConfig.editionParActions === true;
  const dataCSV    = buildDataCSV(rowsWithDefaults, colsLLM, selectChoix, editionParActions);
  const userText   = buildUserMessage(userPrompt, mode, dataCSV, data.infosParent, data.infosVue, effectiveWorkerConfig);

  // ── 7. Contenu multi-part (texte + fichiers routés par provider) ───────────
  const userContent = await buildUserContent(userText, files, providerId);

  // ── 8. Messages ────────────────────────────────────────────────────────────
  const messages = [
    { role: 'system', content: systemPrompt },
    ...session.history.filter(m => m.role !== 'system'),
    { role: 'user',   content: userContent },
  ];

  const truncated = truncateMessages(messages, ia.maxPromptLength || 25000);

  // ── 9. Appel LLM ───────────────────────────────────────────────────────────
  console.log(`[LLM] ${mode.toUpperCase()} → ${ia.endpoint} (${ia.model})`);
  const rawResponse = await callLLM(ia, truncated);

  // ── 10. Historique ─────────────────────────────────────────────────────────
  SM.pushHistory(session, 'assistant', rawResponse);

  // ── 11. Traitement selon le mode ───────────────────────────────────────────
  if (mode === 'plan') {
    session.currentPlan = rawResponse;
    if (onPlan) onPlan(rawResponse);
    return;
  }

  // Mode ACT
  let updatedRows = editionParActions
    ? applyRowActions(rawResponse, session.rows, colonnes, selectChoix, session)
    : parseAndMergeRows(rawResponse, session.rows, colonnes, selectChoix);

  // Hook vue — post-traitement métier après merge
  if (viewHook?.postProcessMerge) {
    updatedRows = viewHook.postProcessMerge(updatedRows, session.rows, colonnes);
  }

  // Rendu progressif "cellule par cellule" — uniquement pertinent pour le contrat
  // historique positionnel. En mode editionParActions, les insert/delete décalent les
  // index : une comparaison position par position enverrait des cell:update sur de
  // mauvaises lignes. On saute ce rendu intermédiaire ; le résultat final passe par
  // onDone (remplacement complet du tableau, cf. act:done côté grid.js).
  if (onCellUpdate && !editionParActions) {
    for (let i = 0; i < updatedRows.length; i++) {
      const orig = session.rows[i] || {};
      const upd  = updatedRows[i]  || {};
      for (const col of colsLLM) {
        const newVal = upd[col.cle];
        const oldVal = orig[col.cle];
        if (newVal !== undefined && String(newVal) !== String(oldVal)) {
          onCellUpdate(i, col.cle, newVal);
          await sleep(30);
        }
      }
    }
  }

  if (onDone) onDone(updatedRows);
}

// ── Valeurs par défaut sur les placeholders ───────────────────────────────────
function applyPlaceholderDefaults(rows, colonnes, regles, viewHook) {
  const defaults    = regles?.valeursParDefaut || {};
  const placeholders = colonnes.filter(c => c.placeholder);

  let result = rows;

  // Valeurs par défaut déclaratives depuis le manifeste
  if (placeholders.length) {
    result = rows.map(row => {
      const r = { ...row };
      for (const col of placeholders) {
        if (r[col.cle] === '' || r[col.cle] === ' ' || r[col.cle] === null || r[col.cle] === undefined) {
          const def = defaults[col.cle];
          if (def !== undefined) r[col.cle] = resolveDefault(def, r);
        }
      }
      return r;
    });
  }

  // Hook vue — post-traitement spécifique (ex: tauxHoraire conditionnel)
  if (viewHook?.postProcessDefaults) {
    result = viewHook.postProcessDefaults(result, colonnes, regles);
  }

  return result;
}

/**
 * Résolution générique d'une valeur par défaut.
 * Supporte :
 *   - Valeur scalaire (number, string) → retournée telle quelle
 *   - Objet conditionnel :
 *     { type: "conditional", if: { field, op }, then, else }
 *     op supportés : "empty" | "eq" | "gt" | "lt" | "gte" | "lte"
 *   - String texte → retournée telle quelle (label pour le LLM, pas une valeur)
 */
function resolveDefault(def, row) {
  if (typeof def !== 'object' || def === null) return def;

  if (def.type === 'conditional') {
    const { field, op } = def.if || {};
    const val = row[field];
    const isEmpty = val === '' || val === ' ' || val === null || val === undefined || Number(val) === 0;
    let condition;
    switch (op) {
      case 'empty': condition = isEmpty; break;
      case 'eq':    condition = String(val) === String(def.if.value); break;
      case 'gt':    condition = Number(val) > Number(def.if.value); break;
      case 'lt':    condition = Number(val) < Number(def.if.value); break;
      case 'gte':   condition = Number(val) >= Number(def.if.value); break;
      case 'lte':   condition = Number(val) <= Number(def.if.value); break;
      default:      condition = isEmpty;
    }
    return condition ? def.then : def.else;
  }

  return def;
}

// ── System prompt ─────────────────────────────────────────────────────────────
function buildSystemPrompt(workerConfig, data, colsLLM, viewHook = null, mode = 'act') {
  const parts = [];

  parts.push(workerConfig.systemPrompt || 'Tu es un assistant IA qui complète des tableaux.');

  // Colonnes disponibles
  parts.push('\n== COLONNES ==');
  for (const c of colsLLM) {
    let desc = `  - ${c.cle} [${c.type || 'string'}] : ${c.libelle || c.cle}`;
    if (c.round) desc += ` (arrondir à ${c.round} décimales)`;
    parts.push(desc);
  }

  // Règles — sérialisées en JSON de façon générique (llmClient ne connaît pas la structure)
  const regles = workerConfig.regles || {};
  if (regles && typeof regles === 'object' && Object.keys(regles).length) {
    parts.push("\n== RÈGLES DE CONSTRUCTION D'UNE LIGNE ==");
    parts.push(JSON.stringify(regles, null, 2));
  }

  // Modele — issu de effectiveWorkerConfig (peut être surchargé par le MANIFEST)
  // Fallback sur data.modele si absent de workerConfig
  const modele = workerConfig.modele?.length ? workerConfig.modele : (data?.modele || []);
  if (modele.length) {
    const clsLLM = new Set(colsLLM.map(c => c.cle));
    const modeleFiltered = modele.map(row => {
      const r = {};
      for (const k of clsLLM) r[k] = row[k] ?? '';
      return r;
    });
    parts.push("\n== MODÈLE DE LIGNE - Donné à titre d'exemple pour le format des données à renvoyer ==");
    parts.push(JSON.stringify(modeleFiltered, null, 2));
  }

  // Additions spécifiques à la vue
  if (viewHook?.buildPromptAdditions) {
    const additions = viewHook.buildPromptAdditions(workerConfig);
    if (additions) parts.push('\n' + additions);
  }

  // Format de réponse — seulement en mode ACT (pas en mode PLAN)
  // Surchargeable via workerConfig.formatReponse (mode actif) ; sinon texte générique.
  if (mode !== 'plan') {
    const formatReponse = workerConfig.formatReponse || `
== FORMAT DE RÉPONSE ==
Réponds UNIQUEMENT avec un tableau JSON valide.
- Inclure TOUTES les lignes dans le même ordre.
- Retourner UNIQUEMENT les clés des colonnes listées ci-dessus.
- Si une valeur est inconnue, utiliser "" (chaîne vide).
- Pas de texte avant ni après. Pas de balises markdown.
`;
    parts.push(formatReponse);
  }

  // Consigne de concision spécifique au mode PLAN
  if (mode === 'plan') {
    parts.push('\n== CONSIGNE PLAN ==');
    parts.push('Réponse compacte — pas de sauts de ligne inutiles, pas de gras ni formatage superflu.');
  }

  return parts.join('\n');
}

// ── Message utilisateur ───────────────────────────────────────────────────────
function buildUserMessage(userPrompt, mode, dataCSV, infosParent, infosVue, workerConfig) {
  const parts = [];

  if (infosParent && Object.keys(infosParent).length) {
    parts.push('== CONTEXTE ==');
    for (const [k, v] of Object.entries(infosParent)) {
      if (v) parts.push(`${k} : ${v}`);
    }
  }

  // Infos vue (contrat §4.1)
  if (infosVue && Object.keys(infosVue).length) {
    parts.push('\n== INFOS VUE ==');
    for (const [k, v] of Object.entries(infosVue)) {
      if (v !== null && v !== undefined) {
        if (typeof v === 'object') {
          parts.push(`${k} : ${JSON.stringify(v)}`);
        } else {
          parts.push(`${k} : ${v}`);
        }
      }
    }
  }

  parts.push('\n== DONNÉES ACTUELLES ==');
  parts.push(dataCSV);

  if (userPrompt) {
    parts.push('\n== DEMANDE ==');
    parts.push(userPrompt);
  }

  if (mode === 'plan') {
    parts.push(`
== INSTRUCTION ==
Décris le plan : colonnes, logique, attention. Format compact. Attends validation.`);
  } else {
    if (workerConfig._currentPlan) {
      parts.push('\n== PLAN VALIDÉ ==');
      parts.push(workerConfig._currentPlan);
    }
    parts.push('\n== INSTRUCTION ==\nExécute le remplissage. Retourne le tableau JSON complet.');
  }

  return parts.join('\n');
}

// ── CSV des données ───────────────────────────────────────────────────────────
/**
 * Construit le CSV des données envoyé au LLM.
 * Si une colonne a un selectChoix avec sendLabel:true, la valeur brute
 * est remplacée par le label lisible (ex: "1" → "35 €/h").
 *
 * @param {Array}  rows        — lignes de données
 * @param {Array}  colsLLM     — colonnes visibles par le LLM
 * @param {Object} selectChoix — mapping { cle: { sendLabel, choix, fallback } }
 * @returns {string}
 */
/**
 * Construit le CSV des données envoyé au LLM.
 * Si une colonne a un selectChoix avec sendLabel:true, la valeur brute
 * est remplacée par le label lisible (ex: "1" → "35 €/h").
 *
 * @param {Array}   rows        — lignes de données
 * @param {Array}   colsLLM     — colonnes visibles par le LLM
 * @param {Object}  selectChoix — mapping { cle: { sendLabel, choix, fallback } }
 * @param {boolean} includeId   — si true, ajoute _id en première colonne (contrat
 *                                d'édition par actions update/delete/insert)
 * @returns {string}
 */
function buildDataCSV(rows, colsLLM, selectChoix = {}, includeId = false) {
  if (!rows?.length || !colsLLM?.length) return '(aucune donnée)';

  const header = (includeId ? ['_id', ...colsLLM.map(c => c.cle)] : colsLLM.map(c => c.cle)).join(';');
  const lines  = rows.map(row => {
    const cells = colsLLM.map(c => {
      const v = row[c.cle];
      if (v === null || v === undefined || v === '') return '';

      // Substitution valeur → label si sendLabel est activé
      const sc = selectChoix[c.cle];
      if (sc?.sendLabel) {
        const entry = sc.choix.find(e => e.valeur === v);
        if (entry) return entry.label;
      }

      return String(v).replace(/;/g, ',').replace(/\n/g, ' ');
    });
    return (includeId ? [row._id ?? '', ...cells] : cells).join(';');
  });

  return [header, ...lines].join('\n');
}

// ── Contenu multi-part avec routing provider → fileType → handler ─────────────
/**
 * Construit le champ `content` du message utilisateur.
 * Si pas de fichiers → string simple (compatibilité maximale).
 * Si fichiers → tableau de blocs routés selon provider + type.
 *
 * @param {string}   textContent  — message texte principal
 * @param {Array}    files        — fichiers joints
 * @param {string}   providerId   — ex: "albert"
 * @returns {string|Array}
 */
async function buildUserContent(textContent, files = [], providerId = 'openai') {
  if (!files.length) return textContent;

  const blocks = [{ type: 'text', text: textContent }];

  for (const file of files) {
    const { name, mimeType } = file;

    // 1. Identifier le type de fichier
    const typeId = resolveFileType(mimeType, name);

    if (!typeId) {
      blocks.push({ type: 'text', text: `[Fichier joint : "${name}" (${mimeType}) — type non reconnu, ignoré]` });
      continue;
    }

    // 2. Clé logique du handler pour ce provider + type (ex: "image_url")
    const handlerKey = getHandler(providerId, typeId);

    if (!handlerKey) {
      blocks.push({ type: 'text', text: `[Fichier joint : "${name}" — non supporté par ce provider (${providerId})]` });
      console.warn(`[LLM] Fichier ignoré — ${providerId} ne supporte pas ${typeId}`);
      continue;
    }

    // 3. Nom de la fonction réelle (ex: "image_url" → "buildImageUrl")
    const handlerName = FILE_TYPES[typeId]?.handlers?.[handlerKey];
    if (!handlerName) {
      blocks.push({ type: 'text', text: `[Fichier joint : "${name}" — handler "${handlerKey}" non trouvé dans fileTypes]` });
      continue;
    }

    // 4. Exécuter le handler
    console.log(`[LLM] Fichier "${name}" → type:${typeId} → ${handlerKey} → ${handlerName}`);
    try {
      const fileBlocks = await runHandler(handlerName, file, providerId);
      blocks.push(...fileBlocks);
    } catch (err) {
      console.error(`[LLM] Erreur handler "${handlerName}" pour "${name}" :`, err.message);
      blocks.push({ type: 'text', text: `[Fichier joint : "${name}" — erreur de traitement : ${err.message}]` });
    }
  }

  return blocks;
}

// ── Appel HTTP LLM ────────────────────────────────────────────────────────────
async function callLLM(ia, messages) {
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), ia.timeoutMs || 30000);

  let response;
  try {
    response = await fetch(ia.endpoint, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${ia.apiKey}`,
      },
      body: JSON.stringify({
        model:       ia.model,
        messages,
        max_tokens:  4096,
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    throw new Error(`LLM HTTP ${response.status} : ${err.slice(0, 300)}`);
  }

  const data    = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`Réponse LLM inattendue : ${JSON.stringify(data).slice(0, 200)}`);

  console.log(`[LLM] Réponse reçue (${content.length} chars)`);
  return content;
}

// ── Parse JSON générique (extrait la réponse LLM, tolérant aux ```json``` et texte parasite) ─
function parseJsonArrayResponse(rawResponse) {
  const clean = rawResponse.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    const match = clean.match(/\[[\s\S]*\]/);
    if (match) {
      try { parsed = JSON.parse(match[0]); }
      catch { throw new Error(`Impossible de parser la réponse LLM : ${clean.slice(0, 300)}`); }
    } else {
      throw new Error(`Réponse LLM sans tableau JSON : ${clean.slice(0, 300)}`);
    }
  }

  if (!Array.isArray(parsed)) throw new Error('Réponse LLM : pas un tableau JSON');
  return parsed;
}

// ── Parse et merge (contrat historique : tableau complet positionnel) ────────
function parseAndMergeRows(rawResponse, originalRows, colonnes, selectChoix = {}) {
  const parsed = parseJsonArrayResponse(rawResponse);

  const placeholderKeys = new Set(colonnes.filter(c => c.placeholder).map(c => c.cle));

  const merged = originalRows.map((orig, i) => {
    const llmRow = parsed[i] || {};
    const result = { ...orig };
    for (const [key, val] of Object.entries(llmRow)) {
      if (placeholderKeys.has(key)) continue;
      const col = colonnes.find(c => c.cle === key);
      result[key] = coerceValue(val, col);
    }
    // Normalisation selectChoix après coerce (label → valeur)
    normalizeSelectChoixRow(result, selectChoix);
    return result;
  });

  // Nouvelles lignes ajoutées par le LLM
  if (parsed.length > originalRows.length) {
    for (let i = originalRows.length; i < parsed.length; i++) {
      if (parsed[i]?.designation) {
        merged.push(sanitizeNewRow(parsed[i], colonnes, placeholderKeys, selectChoix));
      }
    }
  }

  return merged;
}

// ── Parse et merge (contrat par actions : update / delete / insert via _id) ──
/**
 * Résout un tableau d'actions LLM en un tableau de rows final, à plat.
 *
 * Contrat attendu de la réponse LLM (tableau JSON d'objets) :
 *   { "_action": "update", "_id": 3, <champs modifiés uniquement> }
 *   { "_action": "delete", "_id": 7 }
 *   { "_action": "insert", "_apres": 3 | null | "fin", <champs de la nouvelle ligne> }
 *
 * - update : fusionne uniquement les champs fournis sur la ligne existante _id
 * - delete : retire la ligne _id du résultat
 * - insert : _apres = id d'une ligne existante (insère juste après),
 *            null/absent = insère en tête, "fin" = insère en dernier
 * - Toute ligne existante non référencée par une action reste inchangée (défaut : conservation)
 * - Toute action malformée (action inconnue, _id introuvable) est ignorée avec un avertissement,
 *   plutôt que de faire échouer tout le traitement.
 *
 * @param {string} rawResponse    — réponse brute du LLM
 * @param {Array}  originalRows   — rows actuels de la session (avec _id)
 * @param {Array}  colonnes       — colonnes effectives de la vue
 * @param {Object} selectChoix    — mapping selectChoix (label → valeur)
 * @param {Object} session        — session courante (pour SM.consumeNextId)
 * @returns {Array} — tableau de rows final, à plat (comme parseAndMergeRows)
 */
function applyRowActions(rawResponse, originalRows, colonnes, selectChoix, session) {
  const actions = parseJsonArrayResponse(rawResponse);
  const placeholderKeys = new Set(colonnes.filter(c => c.placeholder).map(c => c.cle));

  const byId          = new Map(originalRows.map(r => [r._id, r]));
  const deletedIds     = new Set();
  const updatesById     = new Map();  // _id → champs modifiés (bruts, avant coerce)
  const insertionsAfter = new Map();  // clé (_id | '__start__' | '__end__') → array de champs bruts

  const addInsertion = (afterKey, fields) => {
    if (!insertionsAfter.has(afterKey)) insertionsAfter.set(afterKey, []);
    insertionsAfter.get(afterKey).push(fields);
  };

  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;
    const { _action, _id, _apres, ...fields } = action;

    if (_action === 'delete') {
      if (_id === undefined || !byId.has(_id)) {
        console.warn(`[LLM] Action "delete" ignorée — _id introuvable : ${_id}`);
        continue;
      }
      deletedIds.add(_id);

    } else if (_action === 'update') {
      if (_id === undefined || !byId.has(_id)) {
        console.warn(`[LLM] Action "update" ignorée — _id introuvable : ${_id}`);
        continue;
      }
      updatesById.set(_id, fields);

    } else if (_action === 'insert') {
      const afterKey = (_apres === null || _apres === undefined) ? '__start__'
                      : (_apres === 'fin')                        ? '__end__'
                      : _apres;
      addInsertion(afterKey, fields);

    } else {
      console.warn(`[LLM] Action inconnue ignorée : ${JSON.stringify(action).slice(0, 150)}`);
    }
  }

  const buildUpdatedRow = (orig, fields) => {
    const result = { ...orig };
    for (const [key, val] of Object.entries(fields)) {
      if (placeholderKeys.has(key)) continue;
      const col = colonnes.find(c => c.cle === key);
      result[key] = coerceValue(val, col);
    }
    normalizeSelectChoixRow(result, selectChoix);
    return result;
  };

  const buildInsertedRow = (fields) => {
    const row = sanitizeNewRow(fields, colonnes, placeholderKeys, selectChoix);
    row._id = SM.consumeNextId(session);
    return row;
  };

  const result = [];

  // Insertions en tête
  for (const fields of insertionsAfter.get('__start__') || []) {
    result.push(buildInsertedRow(fields));
  }

  // Lignes existantes (conservées, mises à jour, ou omises si supprimées)
  // + insertions positionnées juste après chaque ligne
  for (const orig of originalRows) {
    if (deletedIds.has(orig._id)) continue;

    const fields = updatesById.get(orig._id);
    result.push(fields ? buildUpdatedRow(orig, fields) : { ...orig });

    for (const insFields of insertionsAfter.get(orig._id) || []) {
      result.push(buildInsertedRow(insFields));
    }
  }

  // Insertions explicitement en fin
  for (const fields of insertionsAfter.get('__end__') || []) {
    result.push(buildInsertedRow(fields));
  }

  // Robustesse : _apres référençant un _id inexistant → ne pas perdre la ligne,
  // l'ajouter en fin plutôt que de la faire disparaître silencieusement.
  for (const [key, fieldsList] of insertionsAfter.entries()) {
    if (key === '__start__' || key === '__end__' || byId.has(key)) continue;
    console.warn(`[LLM] Action "insert" avec _apres introuvable (${key}) — insérée en fin par sécurité`);
    for (const fields of fieldsList) {
      result.push(buildInsertedRow(fields));
    }
  }

  return result;
}

function coerceValue(value, col) {
  if (!col || value === '' || value === null || value === undefined) return value ?? '';
  switch (col.type) {
    case 'integer': { const n = parseInt(value, 10);  return isNaN(n) ? 0 : n; }
    case 'decimal':
    case 'number':  { const n = parseFloat(value);    if (isNaN(n)) return ''; return col.round ? parseFloat(n.toFixed(col.round)) : n; }
    case 'boolean': return value ? 1 : 0;
    default:        return String(value);
  }
}

/**
 * Normalise une valeur brute retournée par le LLM via selectChoix.
 *
 * Le LLM peut retourner :
 *   - un indice valide (1) → gardé tel quel
 *   - un label ("35 €/h") → converti en valeur (1)
 *   - un indice hors plage (99) → fallback
 *
 * @param {*}      rawValue  — valeur retournée par le LLM
 * @param {Object} scDef     — définition selectChoix { choix, fallback }
 * @param {Object} row       — ligne courante (pour fallback siCondition)
 * @returns {*} valeur normalisée
 */
function normalizeSelectChoixValue(rawValue, scDef, row) {
  if (!scDef || !scDef.choix?.length) return rawValue;

  // 1. Indice valide → garder
  for (const entry of scDef.choix) {
    if (entry.valeur === rawValue) return rawValue;
  }

  // 2. Label connu → convertir
  const strVal = String(rawValue).trim();
  for (const entry of scDef.choix) {
    if (entry.label === strVal) return entry.valeur;
  }

  // 3. Hors plage → fallback
  if (scDef.fallback && row) {
    const fb = scDef.fallback;
    const isEmpty = row[fb.siCondition.champ] === '' || row[fb.siCondition.champ] === ' ' || row[fb.siCondition.champ] === null || row[fb.siCondition.champ] === undefined || Number(row[fb.siCondition.champ]) === 0;
    const cond = fb.siCondition.op === 'empty' ? isEmpty : true;
    return cond ? fb.alors : fb.sinon;
  }

  return rawValue;
}

/**
 * Applique normalizeSelectChoixValue sur toutes les colonnes
 * qui ont un selectChoix avec sendLabel.
 */
function normalizeSelectChoixRow(row, selectChoix) {
  for (const [cle, scDef] of Object.entries(selectChoix)) {
    if (scDef?.sendLabel && row[cle] !== undefined) {
      row[cle] = normalizeSelectChoixValue(row[cle], scDef, row);
    }
  }
}

function sanitizeNewRow(llmRow, colonnes, placeholderKeys, selectChoix = {}) {
  const row = {};
  for (const col of colonnes) {
    row[col.cle] = placeholderKeys.has(col.cle)
      ? ''
      : (llmRow[col.cle] !== undefined ? coerceValue(llmRow[col.cle], col) : '');
  }
  normalizeSelectChoixRow(row, selectChoix);
  return row;
}

// ── Troncature ────────────────────────────────────────────────────────────────
function truncateMessages(messages, maxLength) {
  const total = messages.reduce((a, m) => a + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0);
  if (total <= maxLength) return messages;

  console.warn(`[LLM] Troncature historique (${total} > ${maxLength} chars)`);
  const system = messages[0];
  const last   = messages[messages.length - 1];
  const middle = messages.slice(1, -1);

  let truncated = [system, ...middle, last];
  while (truncated.reduce((a, m) => a + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0) > maxLength && middle.length > 0) {
    middle.shift();
    truncated = [system, ...middle, last];
  }
  return truncated;
}

// ── Utilitaires ───────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Aperçu du prompt (sans appel LLM) ─────────────────────────────────────────
/**
 * Reconstruit EXACTEMENT les messages qui seraient envoyés au LLM par run(),
 * mais sans effectuer l'appel réseau. Permet à l'UI de prévisualiser/copier
 * le prompt réel (bloc système seul ou prompt complet).
 *
 * @param {Object}       session     — session courante
 * @param {string|null}  userPrompt  — texte utilisateur
 * @param {'plan'|'act'} mode
 * @param {Array}        files       — [{ name, mimeType, data (base64), size }]
 * @returns {Promise<{ system: string, full: Array }>}
 *   system : contenu du message système (bloc A)
 *   full   : tableau de messages complet [{role, content}, ...] qui serait envoyé
 */
async function buildPromptPreview(session, userPrompt, mode, files = []) {
  const { ia, data } = session;

  // 1. Résolution du provider
  const { id: providerId } = resolveProvider(ia);

  // 2. Config effective et hook vue
  const effectiveWorkerConfig = session.effectiveWorkerConfig;
  const viewHook              = session.viewHook || null;

  // 2b. selectChoix et mode actif
  const selectChoix = session.selectChoix || {};
  const activeModeId = session.activeMode;
  const activeMode   = activeModeId ? (session.modes?.[activeModeId] || null) : null;
  const hiddenKeys   = new Set(activeMode?.colonnesLlmHidden || []);

  // Config surchargée par le mode actif
  const overriddenConfig = { ...effectiveWorkerConfig };
  if (activeMode) {
    if (activeMode.systemPrompt)    overriddenConfig.systemPrompt    = activeMode.systemPrompt;
    if (activeMode.regles)          overriddenConfig.regles          = activeMode.regles;
    if (activeMode.modele)          overriddenConfig.modele          = activeMode.modele;
    if (activeMode.promptsSuggeres) overriddenConfig.promptsSuggeres = activeMode.promptsSuggeres;
    if (activeMode.formatReponse)   overriddenConfig.formatReponse   = activeMode.formatReponse;
    if (activeMode.editionParActions !== undefined) overriddenConfig.editionParActions = activeMode.editionParActions;
  }

  // Surcharges colonnes du mode actif
  const modeSurcharges = activeMode?.surchargesColonnes || {};
  const mergedColonnes = overriddenConfig.colonnes.map(col => {
    const modeOverride = modeSurcharges[col.champ];
    return modeOverride ? { ...col, ...modeOverride } : col;
  });
  overriddenConfig.colonnes = mergedColonnes;

  // 3. Colonnes actives
  const colonnes = overriddenConfig.colonnes || [];
  const colsLLM  = colonnes.filter(c => !c.placeholder && !hiddenKeys.has(c.cle));

  // 4. System prompt (bloc A)
  const systemPrompt = buildSystemPrompt(overriddenConfig, data, colsLLM, viewHook, mode);

  // 5. Rows avec valeurs par défaut
  const rowsWithDefaults = applyPlaceholderDefaults(
    session.rows, colonnes, effectiveWorkerConfig.regles, viewHook
  );

  // 6. Message utilisateur
  const editionParActions = overriddenConfig.editionParActions === true;
  const dataCSV    = buildDataCSV(rowsWithDefaults, colsLLM, selectChoix, editionParActions);
  const userText   = buildUserMessage(userPrompt, mode, dataCSV, data.infosParent, data.infosVue, effectiveWorkerConfig);

  // 7. Contenu multi-part (texte + fichiers routés)
  const userContent = await buildUserContent(userText, files, providerId);

  // 8. Messages
  const messages = [
    { role: 'system', content: systemPrompt },
    ...session.history.filter(m => m.role !== 'system'),
    { role: 'user',   content: userContent },
  ];

  return { system: systemPrompt, full: messages };
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = { run, buildSystemPrompt, buildDataCSV, buildUserMessage, buildPromptPreview };
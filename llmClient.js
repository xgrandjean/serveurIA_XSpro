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

// ── Politique de cycle de vie du contexte LLM (cf. README-prompts.md §3-6) ────
// Policies par défaut : reproduisent exactement le comportement "PAS d'historique"
// actuel tant qu'aucun JSON pairé n'existe pour la vue (session.promptPolicy null).
const DEFAULT_SLOT_POLICIES = {
  systemPrompt:    'once',
  regles:          'once',
  modele:          'once',
  promptAdditions: 'once',
  formatReponse:   'once',
  donnees:         'latest',
  plan:            'latest',
  infosParent:     'latest', // figé — jamais surchargeable (cf. README §4)
  infosVue:        'historise',
  demande:         'historise',
  reponse:         'nonHistorise',
};

/**
 * Résout la policy effective de chaque slot pour le mode actif, à partir des
 * défauts ci-dessus surchargés par session.promptPolicy (racine puis mode).
 * @returns {Object|null} — { [slot]: { policy, resume } }, ou null si aucun JSON
 *                           pairé pour cette vue (comportement actuel inchangé).
 */
function resolveSlotPolicies(promptPolicy, modeId) {
  if (!promptPolicy) return null; // pas de JSON pairé → pas d'historisation, comme avant

  // La seule présence d'un JSON pairé (ex: pour factoriser systemPrompt/regles) ne
  // doit pas activer l'historisation par défaut — il faut que la vue définisse
  // explicitement une section 'slots' (racine ou par mode) pour l'opt-in.
  const hasSlotsBase = !!promptPolicy.slotsBase;
  const hasSlotsMode  = modeId && !!promptPolicy.slotsParMode?.[modeId];
  if (!hasSlotsBase && !hasSlotsMode) return null;

  const resolved = {};
  for (const slot of Object.keys(DEFAULT_SLOT_POLICIES)) {
    const fromBase = promptPolicy.slotsBase?.[slot];
    const fromMode = modeId ? promptPolicy.slotsParMode?.[modeId]?.[slot] : null;
    const entry = fromMode || fromBase || { policy: DEFAULT_SLOT_POLICIES[slot] };
    resolved[slot] = entry;
  }
  // infosParent : figé en 'latest' quoi qu'il arrive (cf. README §4).
  resolved.infosParent = { policy: 'latest' };
  return resolved;
}

/**
 * Construit les messages user/assistant des tours historisés (avant le tour
 * courant), à partir de session.llmTurns, en appliquant la limite de rétention.
 * @returns {{ messages: Array, warnings: Array }}
 */
function buildHistorizedMessages(session, historiqueCfg) {
  const allTurns = session.llmTurns || [];
  if (!allTurns.length) return { messages: [], warnings: [] };

  const limite = historiqueCfg?.limite;
  let keptTurns = allTurns;
  let toursSupprimes = 0;

  if (limite?.type === 'tours' && Number.isFinite(limite.valeur)) {
    if (allTurns.length > limite.valeur) {
      toursSupprimes = allTurns.length - limite.valeur;
      keptTurns = allTurns.slice(toursSupprimes);
    }
  } else if (limite?.type === 'caracteres' && Number.isFinite(limite.valeur)) {
    let total = 0;
    const reversed = [...allTurns].reverse();
    const kept = [];
    for (const t of reversed) {
      const size = (t.demande?.length || 0) + (t.infosVue ? JSON.stringify(t.infosVue).length : 0) + (t.reponse?.length || 0);
      if (total + size > limite.valeur && kept.length > 0) break; // garder au moins 1 tour
      total += size;
      kept.push(t);
    }
    keptTurns = kept.reverse();
    toursSupprimes = allTurns.length - keptTurns.length;
  }

  const messages = [];
  for (const turn of keptTurns) {
    let userContent = '';
    if (turn.infosVue) userContent += `INFOS VUE (tour précédent) :\n${JSON.stringify(turn.infosVue)}\n\n`;
    if (turn.demande)  userContent += `DEMANDE (tour précédent) : ${turn.demande}`;
    if (userContent) messages.push({ role: 'user', content: userContent });
    if (turn.reponse) messages.push({ role: 'assistant', content: turn.reponse });
  }

  const warnings = [];
  if (toursSupprimes > 0) {
    warnings.push({ type: 'troncature_historique', limiteAppliquee: limite.valeur, toursSupprimes });
  }
  return { messages, warnings };
}

// ── Point d'entrée principal ──────────────────────────────────────────────────
/**
 * @param {Object}       session     — session courante
 * @param {string|null}  userPrompt  — texte utilisateur
 * @param {'plan'|'act'} mode
 * @param {Object}       callbacks   — { onPlan, onCellUpdate, onDone }
 *   onDone(updatedRows, meta) — meta.warnings: Array, ex. troncature_historique /
 *   troncature_taille (cf. README-prompts.md §6). meta.actionsResume : { inserted,
 *   updated, deleted } (uniquement en editionParActions — cf. applyRowActions),
 *   null pour le contrat positionnel historique où onCellUpdate porte déjà le détail.
 *   meta est un nouveau paramètre, tout code appelant existant qui l'ignore continue
 *   de fonctionner à l'identique.
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

  // ── 2c. Policies de cycle de vie du contexte (cf. README-prompts.md §3-6) ──
  // null si la vue n'a pas de JSON pairé → aucune historisation, comportement
  // strictement identique à avant cette évolution.
  const slotPolicies = resolveSlotPolicies(session.promptPolicy, activeModeId);

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

  // Mode revue (session.reviewMode) : une ligne marquée __pendingDelete n'a pas encore
  // été retirée de session.rows (elle reste affichée, barrée, tant que l'utilisateur n'a
  // pas validé la suppression) — mais du point de vue du LLM elle est déjà partie, sans
  // quoi il pourrait la re-proposer ou raisonner sur une ligne "fantôme".
  const rowsForLLM = session.reviewMode
    ? rowsWithDefaults.filter(r => !r.__pendingDelete)
    : rowsWithDefaults;

  // ── 6. Injection du plan validé dans le message ACT ────────────────────────
  // Le plan est stocké dans session.currentPlan (set par le mode PLAN).
  // buildUserMessage() le cherche dans workerConfig._currentPlan.
  // On copie effectiveWorkerConfig et on y injecte le plan si on est en mode ACT.
  const actWorkerConfig = { ...effectiveWorkerConfig };
  if (mode === 'act' && session.currentPlan) {
    actWorkerConfig._currentPlan = session.currentPlan;
    console.log(`[LLM] Plan injecté dans le message ACT (${session.currentPlan.length} chars)`);
  }

  const editionParActions = overriddenConfig.editionParActions === true;
  const dataCSV    = buildDataCSV(rowsForLLM, colsLLM, selectChoix, editionParActions);
  const userText   = buildUserMessage(userPrompt, mode, dataCSV, data.infosParent, data.infosVue, actWorkerConfig, activeMode);

  // ── 7. Contenu multi-part (texte + fichiers routés par provider) ───────────
  const userContent = await buildUserContent(userText, files, providerId);

  // ── 8. Messages ──────────────────────────────────────────────────────────
  // Sans JSON pairé (slotPolicies === null) : comportement inchangé — le message
  // utilisateur est auto-suffisant, pas d'historique envoyé au LLM (session.history
  // reste réservé à l'affichage UI). Avec JSON pairé : les tours dont au moins un
  // slot est 'historise' sont rejoués comme vrais messages user/assistant avant le
  // tour courant (cf. README-prompts.md §3-6), dans la limite de session.promptPolicy.historique.
  let warnings = [];
  const messages = [{ role: 'system', content: systemPrompt }];

  if (slotPolicies) {
    const { messages: historizedMessages, warnings: historiqueWarnings } =
      buildHistorizedMessages(session, session.promptPolicy.historique);
    messages.push(...historizedMessages);
    warnings = warnings.concat(historiqueWarnings);
  }

  messages.push({ role: 'user', content: userContent });

  const truncated = truncateMessages(messages, ia.maxPromptLength || 40000);
  if (truncated.length < messages.length) {
    warnings.push({
      type: 'troncature_taille',
      limiteAppliquee: ia.maxPromptLength || 40000,
      messagesSupprimes: messages.length - truncated.length,
    });
  }

  // ── 9. Log taille des messages + appel LLM ─────────────────────────────────
  const systemPromptSize = truncated[0]?.content?.length || 0;
  const userMsgSize = truncated[truncated.length - 1]?.content?.length || 0;
  const totalSize = truncated.reduce((a, m) => a + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0);
  console.log(`[LLM] ${mode.toUpperCase()} → ${ia.endpoint} (${ia.model})`);
  console.log(`[LLM] Messages : ${truncated.length} total, system ${systemPromptSize} chars, user ${userMsgSize} chars, total ${totalSize} chars`);
  console.log(`[LLM] Timeout config : ${mode === 'act' ? Math.max((ia.timeoutMs || 30000) * 4, 120000) : (ia.timeoutMs || 30000)}ms (mode ${mode})`);
  const rawResponse = await callLLM(ia, truncated, mode);

  // ── 10. Historique ─────────────────────────────────────────────────────────
  SM.pushHistory(session, 'assistant', rawResponse);

  // Tour historisé à usage LLM (distinct de session.history ci-dessus) — cf.
  // README-prompts.md §3-6. Rien n'est stocké si la vue n'a pas de JSON pairé,
  // ou si aucun slot n'est en policy 'historise' pour ce mode.
  if (slotPolicies) {
    const turn = {
      modeId:   activeModeId,
      demande:  slotPolicies.demande?.policy  === 'historise' ? (userPrompt || null) : null,
      infosVue: slotPolicies.infosVue?.policy === 'historise' ? (data.infosVue || null) : null,
      reponse:  slotPolicies.reponse?.policy  === 'historise' ? (rawResponse || null) : null,
    };
    if (turn.demande || turn.infosVue || turn.reponse) SM.pushLlmTurn(session, turn);
  }

  // ── 11. Traitement selon le mode ───────────────────────────────────────────
  if (mode === 'plan') {
    session.currentPlan = rawResponse;
    if (onPlan) onPlan(rawResponse);
    return;
  }

  // Mode ACT
  // actionsResume : uniquement renseigné en editionParActions (cf. applyRowActions) —
  // le contrat positionnel n'a pas besoin d'un résumé séparé, onCellUpdate ci-dessous
  // porte déjà le détail cellule par cellule pour ce contrat.
  let updatedRows;
  let actionsResume = null;
  let rapportIA     = null;   // synthese redigee par le LLM (contrat { rapport, actions })
  if (editionParActions) {
    const applied = applyRowActions(rawResponse, session.rows, colonnes, selectChoix, session);
    updatedRows   = applied.rows;
    actionsResume = applied.resume;
    rapportIA     = applied.rapport;
  } else {
    updatedRows = parseAndMergeRows(rawResponse, session.rows, colonnes, selectChoix);
  }

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

  if (onDone) onDone(updatedRows, { warnings, actionsResume, rapport: rapportIA });
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
function buildUserMessage(userPrompt, mode, dataCSV, infosParent, infosVue, workerConfig, activeMode = null) {
  const parts = [];

  if (infosParent && Object.keys(infosParent).length) {
    parts.push('== CONTEXTE ==');
    for (const [k, v] of Object.entries(infosParent)) {
      if (v) {
        if (typeof v === 'object') {
          parts.push(`${k} : ${JSON.stringify(v)}`);
        } else {
          parts.push(`${k} : ${v}`);
        }
      }
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

  if (activeMode) {
    parts.push('\n== MODE ACTIF ==');
    parts.push(`Mode : ${activeMode.label || '(mode actif)'}`);
    if (activeMode.description) parts.push(`Description : ${activeMode.description}`);
    parts.push('La demande ci-dessous peut ne pas correspondre au mode actif. En cas de conflit, la demande prime.');
  }

  if (userPrompt) {
    parts.push('\n== DEMANDE ==');
    parts.push(userPrompt);
  }

  if (mode === 'plan') {
    parts.push(`
== INSTRUCTION ==
Regarde la logique et décris ta proposition en résumé : points d'attention, colonnes. Indique clairement s'il s'agit d'un ajout, d'une modification, ou des deux. Format compact. Attends validation.`);
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

  const header = (includeId ? ['_id', ...colsLLM.map(c => c.cle)] : colsLLM.map(c => c.cle)).join('\t');
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

      return String(v).replace(/\t/g, ' ').replace(/\n/g, '\\n');
    });
    return (includeId ? [row._id ?? '', ...cells] : cells).join('\t');
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
/**
 * Appelle l'API LLM avec timeout adaptatif et logs détaillés.
 * Enrichit les erreurs avec cause, suggestion et httpStatus pour un affichage
 * informatif côté UI (cf. server.js, grid.js).
 *
 * @param {Object}   ia       — config IA { endpoint, apiKey, model, timeoutMs }
 * @param {Array}    messages — messages format OpenAI [{ role, content }]
 * @param {string}   mode     — 'plan' | 'act' (pour adapter le timeout et max_tokens)
 * @returns {Promise<string>} — contenu textuel de la réponse LLM
 */
async function callLLM(ia, messages, mode = 'act') {
  // Timeout adaptatif : 30s pour PLAN, 120s pour ACT (4x le timeout config, min 120s)
  const baseTimeout = ia.timeoutMs || 30000;
  const timeoutMs = mode === 'act' ? Math.max(baseTimeout * 4, 120000) : baseTimeout;

  // max_tokens adaptatif : 4096 pour PLAN, 8192 pour ACT
  const maxTokens = mode === 'act' ? 8192 : 4096;

  // Sérialiser le body une seule fois (log + envoi)
  const bodyPayload = {
    model:       ia.model,
    messages,
    max_tokens:  maxTokens,
    temperature: 0.2,
  };
  const bodyStr = JSON.stringify(bodyPayload);
  console.log(`[LLM] Requête ${mode} — body ${bodyStr.length} chars, timeout ${timeoutMs}ms, max_tokens ${maxTokens}`);

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), timeoutMs);

  let startTime = Date.now();
  let response;
  try {
    response = await fetch(ia.endpoint, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${ia.apiKey}`,
      },
      body: bodyStr,
      signal: controller.signal,
    });
  } catch (fetchError) {
    clearTimeout(timeoutId);
    // AbortError (timeout) vs autre erreur réseau
    if (fetchError.name === 'AbortError') {
      const cause = 'timeout';
      const suggestion = `Le LLM n'a pas répondu dans le délai imparti de ${timeoutMs / 1000}s. Tu peux augmenter ia.timeoutMs dans le payload ou réessayer.`;
      console.error(`[LLM] Timeout (${mode}) après ${timeoutMs}ms`);
      throw Object.assign(new Error(`⚠ Timeout : le LLM n'a pas répondu en ${timeoutMs / 1000}s`), { cause, suggestion, httpStatus: null, timeoutMs });
    }
    const cause = 'network';
    const suggestion = 'Vérifie ta connexion réseau et que l\'endpoint est accessible.';
    console.error(`[LLM] Erreur réseau (${mode}) :`, fetchError.message);
    throw Object.assign(new Error(`⚠ Erreur réseau : ${fetchError.message}`), { cause, suggestion, httpStatus: null });
  } finally {
    clearTimeout(timeoutId);
  }

  const elapsed = Date.now() - startTime;

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    const truncatedErr = errBody.slice(0, 300);
    let cause, suggestion;
    switch (response.status) {
      case 401:
        cause = 'auth';
        suggestion = 'Clé API invalide — vérifie ta clé Mistral.';
        break;
      case 429:
        cause = 'rate_limit';
        suggestion = 'Trop de requêtes vers l\'API — attends quelques secondes puis réessaie.';
        break;
      case 400:
        cause = 'bad_request';
        suggestion = 'Requête mal formée — vérifie les logs pour plus de détails.';
        break;
      case 500: case 502: case 503:
        cause = 'server_error';
        suggestion = `Le serveur LLM a retourné une erreur HTTP ${response.status} — réessaie plus tard ou contacte le support.`;
        break;
      default:
        cause = 'http_error';
        suggestion = `Erreur HTTP ${response.status} — vérifie la configuration.`;
    }
    console.error(`[LLM] Échec HTTP ${response.status} (${mode}) en ${elapsed}ms : ${truncatedErr}`);
    throw Object.assign(
      new Error(`⚠ ${suggestion} (HTTP ${response.status})`),
      { cause, suggestion, httpStatus: response.status }
    );
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    const cause = 'empty_response';
    const suggestion = 'Le LLM a répondu mais sans contenu textuel — vérifie les logs de la requête.';
    console.error(`[LLM] Réponse inattendue (${mode}) en ${elapsed}ms :`, JSON.stringify(data).slice(0, 200));
    throw Object.assign(
      new Error(`⚠ Réponse LLM vide ou inattendue`),
      { cause, suggestion, httpStatus: response.status }
    );
  }

  console.log(`[LLM] Réponse reçue (${mode}) — ${content.length} chars en ${elapsed}ms`);
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
/**
 * Parse la reponse du contrat "edition par actions".
 * Accepte DEUX formes, volontairement :
 *   - { "rapport": "...", "actions": [...] }  — forme demandee : le rapport est le seul
 *     canal ou le modele s'adresse a l'utilisateur (sans lui, il ecrivait ses observations
 *     dans une colonne de donnees, faute de mieux).
 *   - [ ... ]                                  — tableau nu : forme historique, conservee
 *     pour qu'un modele qui ignore la consigne continue d'etre exploite normalement.
 * @returns {{actions: Array, rapport: string|null}}
 */
function parseActionsResponse(rawResponse) {
  const clean = String(rawResponse || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    // Repli : extraire le premier objet OU tableau complet noye dans du texte parasite.
    const m = clean.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!m) throw new Error(`Reponse LLM sans JSON exploitable : ${clean.slice(0, 300)}`);
    try { parsed = JSON.parse(m[0]); }
    catch { throw new Error(`Impossible de parser la reponse LLM : ${clean.slice(0, 300)}`); }
  }

  if (Array.isArray(parsed)) return { actions: parsed, rapport: null };

  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.actions)) {
    const r = typeof parsed.rapport === 'string' ? parsed.rapport.trim() : '';
    return { actions: parsed.actions, rapport: r || null };
  }

  throw new Error("Reponse LLM : ni tableau d'actions, ni objet { rapport, actions }");
}

function applyRowActions(rawResponse, originalRows, colonnes, selectChoix, session) {
  const { actions, rapport } = parseActionsResponse(rawResponse);
  const placeholderKeys = new Set(colonnes.filter(c => c.placeholder).map(c => c.cle));
  // Mode revue (cf. viewResolver.js MANIFEST.revueParPending) : les actions ne sont plus
  // committées directement — elles sont marquées "en attente" sur les rows elles-mêmes
  // (__pendingFields / __pendingInsert / __pendingDelete), pour validation/rejet ultérieur
  // via sessionManager.js (approveField/rejectField/approveRow/rejectRow/approveAll/rejectAll).
  const reviewMode = !!session?.reviewMode;

  // Les donnees partent au LLM en TSV (cf. buildDataCSV) : il y relit `_id` comme du texte
  // et le renvoie volontiers en chaine — "3" au lieu de 3. Indexer par une cle normalisee
  // plutot que par la valeur brute evite que TOUTES les actions soient rejetees en
  // "_id introuvable" selon la facon dont le modele a serialise sa reponse.
  const cleId = (v) => (v === null || v === undefined) ? null : String(v).trim();
  const byId          = new Map(originalRows.map(r => [cleId(r._id), r]));
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

    const idAction = cleId(_id);

    if (_action === 'delete') {
      if (idAction === null || !byId.has(idAction)) {
        console.warn(`[LLM] Action "delete" ignorée — _id introuvable : ${_id}`);
        continue;
      }
      deletedIds.add(idAction);

    } else if (_action === 'update') {
      if (idAction === null || !byId.has(idAction)) {
        console.warn(`[LLM] Action "update" ignorée — _id introuvable : ${_id}`);
        continue;
      }
      updatesById.set(idAction, fields);

    } else if (_action === 'insert') {
      // Meme normalisation pour `_apres` : sans elle l'insertion n'etait pas perdue, mais
      // repoussee en fin par le filet de securite plus bas — donc placee ailleurs que la ou
      // le modele l'avait demandee, sans que rien ne le signale a l'utilisateur.
      const afterKey = (_apres === null || _apres === undefined) ? '__start__'
                      : (_apres === 'fin')                        ? '__end__'
                      : cleId(_apres);
      addInsertion(afterKey, fields);

    } else {
      console.warn(`[LLM] Action inconnue ignorée : ${JSON.stringify(action).slice(0, 150)}`);
    }
  }

  const valuesEqualPending = SM.valuesEqual;
  let lignesReellementModifiees = 0;   // cf. resume ci-dessous : on ne compte pas les faux changements
  const idsSansEffet = [];             // _id declares en 'update' par le LLM mais sans changement reel
  const buildUpdatedRow = (orig, fields) => {
    const result = { ...orig };
    let aChange = false;
    // En mode revue, snapshot de la valeur d'ORIGINE de chaque champ touché — une seule
    // fois par champ (si un 2e run IA retouche un champ déjà en attente, on ne doit pas
    // écraser la vraie baseline avec la valeur intermédiaire déjà proposée).
    const pendingFields = reviewMode ? { ...(orig.__pendingFields || {}) } : null;
    for (const [key, val] of Object.entries(fields)) {
      if (placeholderKeys.has(key)) continue;
      // Jamais `undefined` comme valeur d'origine : JSON.stringify SUPPRIME les cles dont
      // la valeur est undefined. La ligne partait alors avec un __pendingFields vide, alors
      // que countPendingRows (qui lit Object.keys avant serialisation) en comptait bien un —
      // le client recevait {} et n'affichait aucun marquage. Le cas est courant : compactRows
      // omet les champs vides de la ligne envoyee, donc tout champ complete par l'IA
      // (indication, explicationCorrection...) est absent de `orig`. '' est aussi la valeur
      // correcte a restaurer en cas de rejet : le champ etait vide.
      const col = colonnes.find(c => c.cle === key);
      const nouvelle = coerceValue(val, col);

      // Une "modification" qui ne modifie rien ne doit ni etre marquee ni etre comptee :
      // sinon l'utilisateur lit "N lignes modifiees" alors que rien n'a bouge, et voit des
      // cellules ambre dont le "Avant" et le "Apres" sont identiques. Meme regle que
      // l'edition manuelle (sessionManager.setCellValue), d'ou le meme comparateur.
      const valeurOrigine = orig[key] === undefined ? '' : orig[key];
      if (SM.valuesEqual(valeurOrigine, nouvelle)) continue;

      if (pendingFields && !(key in pendingFields)) pendingFields[key] = valeurOrigine;
      result[key] = nouvelle;
      aChange = true;

      // Retour a la valeur d'origine apres un precedent run : le champ n'est plus en attente.
      if (pendingFields && valuesEqualPending(pendingFields[key], nouvelle)) {
        delete pendingFields[key];
      }
    }
    if (pendingFields && Object.keys(pendingFields).length) result.__pendingFields = pendingFields;
    normalizeSelectChoixRow(result, selectChoix);
    return { row: result, aChange };
  };

  const buildInsertedRow = (fields) => {
    const row = sanitizeNewRow(fields, colonnes, placeholderKeys, selectChoix);
    row._id = SM.consumeNextId(session);
    if (reviewMode) row.__pendingInsert = true;
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
    const idOrig = cleId(orig._id);
    if (deletedIds.has(idOrig)) {
      // Mode revue : la ligne reste affichée (barrée côté UI), en attente de validation
      // de la suppression — retirée seulement via SM.approveRow/approveAll.
      if (reviewMode) result.push({ ...orig, __pendingDelete: true });
      continue;
    }

    const fields = updatesById.get(idOrig);
    if (fields) {
      const { row, aChange } = buildUpdatedRow(orig, fields);
      if (aChange) lignesReellementModifiees++;
      else idsSansEffet.push(orig._id);
      result.push(row);
    } else {
      result.push({ ...orig });
    }

    for (const insFields of insertionsAfter.get(idOrig) || []) {
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

  // Résumé des actions réellement appliquées (ignore les delete/update à _id introuvable,
  // déjà écartés plus haut) — cf. run() (onDone meta.actionsResume) et grid.js (message de
  // fin "N ligne(s) ajoutée(s)/modifiée(s)/supprimée(s)"). Nécessaire car le rendu cellule
  // par cellule (onCellUpdate/state.updatedCells) est désactivé pour ce contrat (cf. run(),
  // les insert/delete décalent les index) : sans ce résumé, le message de fin affichait
  // toujours "0 cellule(s) mise(s) à jour" même après des insertions/suppressions réelles.
  const insertedCount = Array.from(insertionsAfter.values())
    .reduce((sum, fieldsList) => sum + fieldsList.length, 0);
  // `updated` compte les lignes REELLEMENT changees, et non les actions "update" declarees
  // par le LLM : celui-ci en emet volontiers qui reecrivent une valeur a l'identique, et
  // annoncer "N lignes modifiees" sans que rien ne bouge a l'ecran est precisement ce qu'il
  // faut eviter. Le decompte correspond donc exactement aux lignes qui porteront un marqueur.
  const resume = { inserted: insertedCount, updated: lignesReellementModifiees, deleted: deletedIds.size };

  // Trace persistante de l'ecart entre ce que le LLM DECLARE et ce qui est REELLEMENT retenu.
  // Le message affiche dans l'UI disparait avec la session ; ce log-ci reste dans la sortie du
  // Worker (relayee dans le terminal XSpro sous le prefixe [serveurIA]) et permet, apres coup,
  // de savoir si un "N lignes modifiees" surprenant venait du modele ou du traitement.
  if (updatesById.size !== lignesReellementModifiees) {
    console.warn(
      `[LLM] Ecart actions/effet — ${updatesById.size} action(s) "update" declaree(s) par le modele, `
      + `${lignesReellementModifiees} ligne(s) reellement modifiee(s). `
      + `Sans effet (valeur identique a l'existante) : _id ${idsSansEffet.join(', ') || '(aucun)'}.`
    );
  }
  console.log(`[LLM] Actions appliquees — inserees:${resume.inserted} modifiees:${resume.updated} supprimees:${resume.deleted}`);

  return { rows: result, resume, rapport };
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
  // cf. run() — une ligne __pendingDelete (mode revue) est invisible pour le LLM
  const rowsForLLM = session.reviewMode
    ? rowsWithDefaults.filter(r => !r.__pendingDelete)
    : rowsWithDefaults;

  // 6. Message utilisateur
  const editionParActions = overriddenConfig.editionParActions === true;
  const dataCSV    = buildDataCSV(rowsForLLM, colsLLM, selectChoix, editionParActions);
  const userText   = buildUserMessage(userPrompt, mode, dataCSV, data.infosParent, data.infosVue, effectiveWorkerConfig, activeMode);

  // 7. Contenu multi-part (texte + fichiers routés)
  const userContent = await buildUserContent(userText, files, providerId);

  // 8. Messages — PAS d'historique (identique à run())
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: userContent },
  ];

  return { system: systemPrompt, full: messages };
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = { run, buildSystemPrompt, buildDataCSV, buildUserMessage, buildPromptPreview };
/**
 * AI Worker — sessionManager.js
 * Gestion des sessions en mémoire, isolées par sessionId.
 *
 * Chaque session contient :
 *   - le payload complet (ia, data, workerConfig)
 *   - les rows en cours de travail (copie mutable)
 *   - l'historique conversationnel (messages LLM)
 *   - le statut courant
 *   - la WebSocket UI attachée
 *
 * TTL : une session expirée sans activité est nettoyée automatiquement.
 */

'use strict';

// ── Constantes ────────────────────────────────────────────────────────────────
const SESSION_TTL_MS      = 2 * 60 * 60 * 1000; // 2 heures sans activité
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;      // nettoyage toutes les 10 min

// ── Statuts possibles d'une session ──────────────────────────────────────────
const STATUS = {
  IDLE:       'idle',        // session créée, UI pas encore connectée
  CONNECTED:  'connected',   // UI connectée, en attente d'action
  PLANNING:   'planning',    // IA en train d'élaborer un plan
  ACTING:     'acting',      // IA en train de remplir les cellules
  PAUSED:     'paused',      // IA terminée, utilisateur en train de corriger
  DELIVERING: 'delivering',  // envoi du résultat final vers XSpro ou export Excel
  DONE:       'done',        // session terminée avec succès
  CANCELLED:  'cancelled',   // session annulée par l'utilisateur
  ERROR:      'error',       // erreur fatale
};

// ── Store en mémoire ──────────────────────────────────────────────────────────
const store = new Map(); // sessionId → SessionObject

// ── Création d'une session ────────────────────────────────────────────────────
/**
 * Crée une nouvelle session à partir d'un payload validé.
 * Si la session existe déjà, la retourne sans la recréer.
 *
 * @param {Object} payload  — payload complet reçu via POST /process ou standalone
 * @returns {Object}        — session créée ou existante
 */
function createSession(payload) {
  const { sessionId, contextName, callbackUrl, ia, data, workerConfig } = payload;

  if (!sessionId || !contextName) {
    throw new Error('createSession : sessionId et contextName sont requis');
  }

  if (store.has(sessionId)) {
    console.warn(`[SessionManager] Session déjà existante, réutilisée : ${sessionId}`);
    return store.get(sessionId);
  }

  // Copie défensive des lignes source → les rows sont mutables pendant le travail
  // _id : identifiant stable interne à la session, utilisé par le LLM pour référencer
  // une ligne sans ambiguïté (update/delete/insert), indépendant de sa position dans
  // le tableau. Jamais transmis à XSpro (retiré par snapshotRows).
  const rowsSource = Array.isArray(data?.lignes) ? data.lignes : [];
  const rows = rowsSource.map((r, i) => ({ _id: i + 1, ...r }));

  const session = {
    // ── Identité ──────────────────────────────────────────────────────────────
    sessionId,
    contextName,
    callbackUrl: callbackUrl || null,

    // ── Config IA (jamais persistée sur disque) ───────────────────────────────
    ia: { ...ia },

    // ── Payload brut original reçu de XSpro ──────────────────────────────────
    xsproPayload: { ...payload },

    // ── Données source (lecture seule après init) ─────────────────────────────
    data: {
      lignes:      rowsSource,
      infosParent: data?.infosParent  || {},
      lexique:     data?.lexique      || {},
      maxContenu:  data?.maxContenu   || 50000,
      modele:      data?.modele       || [],
      infosVue:    data?.infosVue     || {},
    },

    // ── Config grille et règles ───────────────────────────────────────────────
    workerConfig: workerConfig || {},

    // ── État de travail ───────────────────────────────────────────────────────
    rows,           // copie mutable — modifiée au fil du remplissage
    _nextId: rows.length + 1,  // prochain _id disponible pour une insertion LLM
    status:  STATUS.IDLE,

    // ── Historique conversationnel (isolé par session) ────────────────────────
    // Format OpenAI-compatible : [{ role: 'system'|'user'|'assistant', content }]
    // Usage : AFFICHAGE UI UNIQUEMENT (cf. llmClient.js). Ne sert pas à reconstruire
    // les messages envoyés au LLM.
    history: [],

    // ── Tours historisés à usage LLM (cf. README-prompts.md §3-6) ─────────────
    // Distinct de `history` ci-dessus : contenu structuré par slot (demande /
    // infosVue / reponse), un tour par appel où au moins un slot est marqué
    // 'historise' pour le mode actif. Consommé par llmClient.js pour reconstruire
    // un vrai tableau messages[] user/assistant. Vide/non utilisé pour un hook
    // sans JSON pairé (session.promptPolicy === null) — comportement inchangé.
    llmTurns: [],

    // ── Plan en cours (mode Plan/Act) ─────────────────────────────────────────
    currentPlan: null,

    // ── WebSocket UI attachée à cette session ─────────────────────────────────
    ws: null,

    // ── Timestamps ────────────────────────────────────────────────────────────
    createdAt:    Date.now(),
    lastActivityAt: Date.now(),
  };

  store.set(sessionId, session);
  console.log(`[SessionManager] Session créée : ${sessionId} (${contextName})`);
  return session;
}

// ── Récupération ──────────────────────────────────────────────────────────────
/**
 * @param {string} sessionId
 * @returns {Object|null}
 */
function getSession(sessionId) {
  const session = store.get(sessionId);
  if (session) touchSession(session);
  return session || null;
}

// ── Mise à jour du statut ─────────────────────────────────────────────────────
/**
 * @param {Object} session
 * @param {string} newStatus  — une des valeurs STATUS
 */
function setStatus(session, newStatus) {
  if (!Object.values(STATUS).includes(newStatus)) {
    console.warn(`[SessionManager] Statut inconnu : ${newStatus}`);
    return;
  }
  session.status = newStatus;
  touchSession(session);
  console.log(`[SessionManager] ${session.sessionId} → ${newStatus}`);
}

// Comparaison de valeur "légère" (miroir de la même fonction côté client, public/grid.js) — les
// champs array (choix, choixCorrect) sont reconstruits en un nouveau tableau à chaque édition ;
// une comparaison === les considérerait toujours différents même à contenu strictement identique,
// empêchant le nettoyage de __pendingFields ci-dessous de fonctionner pour ces deux colonnes.
function valuesEqual(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

// ── Mise à jour d'une cellule ─────────────────────────────────────────────────
/**
 * Modifie une valeur dans session.rows et met à jour lastActivityAt.
 *
 * En mode revue (session.reviewMode), le changement devient "en attente" au lieu
 * d'être committé directement — même mécanisme que les propositions IA (cf.
 * llmClient.js applyRowActions/buildUpdatedRow) : snapshot de la valeur d'origine
 * dans row.__pendingFields (une seule fois), écriture de la nouvelle valeur. Décision
 * du 2026-07-30 : peu importe l'origine du changement (frappe manuelle ou LLM), même
 * traitement — validable/rejetable via approveField/rejectField. Une ligne déjà
 * __pendingInsert (pas encore validée) n'a pas besoin de ce sous-suivi par champ :
 * valider/rejeter la ligne couvre déjà tout son contenu.
 *
 * @param {Object} session
 * @param {number} rowIndex  — index dans session.rows
 * @param {string} cle       — clé de la colonne
 * @param {*}      value
 * @returns {boolean}        — true si la mise à jour a eu lieu
 */
function setCellValue(session, rowIndex, cle, value) {
  const row = session.rows[rowIndex];
  if (!row) {
    console.warn(`[SessionManager] setCellValue : rowIndex ${rowIndex} hors limites`);
    return false;
  }
  if (session.reviewMode && !row.__pendingInsert) {
    if (!row.__pendingFields) row.__pendingFields = {};
    if (!(cle in row.__pendingFields)) row.__pendingFields[cle] = row[cle];
    row[cle] = value;
    if (valuesEqual(row.__pendingFields[cle], value)) {
      delete row.__pendingFields[cle];
      if (Object.keys(row.__pendingFields).length === 0) delete row.__pendingFields;
    }
  } else {
    row[cle] = value;
  }
  touchSession(session);
  return true;
}

// ── Attribution d'un nouvel _id ───────────────────────────────────────────────
/**
 * Consomme et incrémente le compteur _nextId de la session.
 * Utilisé par llmClient.js (applyRowActions) pour assigner un _id stable
 * à chaque nouvelle ligne insérée par le LLM.
 *
 * @param {Object} session
 * @returns {number} — l'_id attribué
 */
function consumeNextId(session) {
  const id = session._nextId || 1;
  session._nextId = id + 1;
  return id;
}

// ── Ajout d'un message à l'historique ────────────────────────────────────────
/**
 * @param {Object} session
 * @param {'user'|'assistant'|'system'} role
 * @param {string} content
 */
function pushHistory(session, role, content) {
  session.history.push({ role, content });
  touchSession(session);
}

// ── Ajout d'un tour historisé à usage LLM ────────────────────────────────────
/**
 * Stocke un tour structuré par slot, distinct de session.history (UI). Un champ
 * absent/null signifie "ce slot n'était pas en policy 'historise' pour ce tour" —
 * llmClient.js ne le rejoue donc pas dans messages[]. Cf. README-prompts.md §3-6.
 *
 * @param {Object} session
 * @param {Object} turn — { modeId, demande, infosVue, reponse }
 */
function pushLlmTurn(session, turn) {
  session.llmTurns.push({ ...turn, timestamp: Date.now() });
  touchSession(session);
}

// ── Attachement de la WebSocket UI ───────────────────────────────────────────
/**
 * @param {Object} session
 * @param {WebSocket} ws
 */
function attachWs(session, ws) {
  session.ws = ws;
  setStatus(session, STATUS.CONNECTED);
}

function detachWs(session) {
  session.ws = null;
  // Si la session n'est pas terminée, repasse en IDLE (UI fermée accidentellement)
  if (![STATUS.DONE, STATUS.CANCELLED, STATUS.ERROR].includes(session.status)) {
    session.status = STATUS.IDLE;
  }
}

// ── Suppression explicite ─────────────────────────────────────────────────────
/**
 * @param {string} sessionId
 */
function deleteSession(sessionId) {
  if (store.has(sessionId)) {
    store.delete(sessionId);
    console.log(`[SessionManager] Session supprimée : ${sessionId}`);
  }
}

// ── Snapshot des rows ─────────────────────────────────────────────────────────
/**
 * Retourne une copie profonde des rows courants.
 * Utilisé avant export ou renvoi à XSpro.
 *
 * @param {Object} session
 * @returns {Array}
 */
function snapshotRows(session) {
  return session.rows.map(({ _id, __pendingFields, __pendingInsert, __pendingDelete, ...rest }) => ({ ...rest }));
}

// ── Revue des propositions (IA + manuelles, mode revueParPending) ─────────────
/**
 * Une row porte jusqu'à 3 marqueurs internes, jamais transmis à XSpro (retirés par
 * snapshotRows comme _id) :
 *   __pendingFields = { champ: valeurOrigine, ... } — update proposé, pas encore validé
 *   __pendingInsert = true                          — ligne insérée (IA ou manuelle)
 *   __pendingDelete = true                          — suppression proposée, ligne encore présente
 * Posés par llmClient.js (applyRowActions) POUR les propositions IA, et par
 * setCellValue/proposeInsertRow/proposeDeleteRows ci-dessous POUR les changements
 * manuels (bouton "+ Ligne"/"✂️", édition de cellule) — décision du 2026-07-30 :
 * même traitement quelle que soit l'origine. Résolus ici (approve = garder l'état
 * actuel, reject = revenir à l'état d'avant la proposition).
 */
function hasPendingMarker(row) {
  return !!(row.__pendingInsert || row.__pendingDelete || (row.__pendingFields && Object.keys(row.__pendingFields).length));
}

/**
 * Nombre de lignes portant au moins une proposition en attente (granularité ligne —
 * utilisé pour le badge "N ligne(s) en attente" côté UI).
 */
function countPendingRows(session) {
  return session.rows.filter(hasPendingMarker).length;
}

/**
 * Valide un champ en attente : la valeur proposée par le LLM devient définitive.
 * @returns {boolean} true si une proposition existait bien pour ce champ
 */
function approveField(session, id, cle) {
  const row = session.rows.find(r => r._id === id);
  if (!row?.__pendingFields || !(cle in row.__pendingFields)) return false;
  delete row.__pendingFields[cle];
  if (Object.keys(row.__pendingFields).length === 0) delete row.__pendingFields;
  touchSession(session);
  return true;
}

/**
 * Rejette un champ en attente : restaure la valeur d'origine (avant la proposition IA).
 */
function rejectField(session, id, cle) {
  const row = session.rows.find(r => r._id === id);
  if (!row?.__pendingFields || !(cle in row.__pendingFields)) return false;
  row[cle] = row.__pendingFields[cle];
  delete row.__pendingFields[cle];
  if (Object.keys(row.__pendingFields).length === 0) delete row.__pendingFields;
  touchSession(session);
  return true;
}

/**
 * Valide toutes les propositions en attente d'une ligne — insertion conservée,
 * suppression effectuée, mises à jour de champs committées. Une ligne à la fois
 * pending-delete ET pending-fields voit la suppression l'emporter (elle disparaît).
 * @returns {boolean} true si la ligne portait bien une proposition
 */
function approveRow(session, id) {
  const idx = session.rows.findIndex(r => r._id === id);
  if (idx === -1) return false;
  const row = session.rows[idx];
  if (row.__pendingDelete) {
    session.rows.splice(idx, 1);
  } else if (row.__pendingInsert) {
    delete row.__pendingInsert;
  } else if (row.__pendingFields) {
    delete row.__pendingFields;
  } else {
    return false;
  }
  touchSession(session);
  return true;
}

/**
 * Rejette toutes les propositions en attente d'une ligne — insertion annulée (ligne
 * retirée, elle n'a jamais existé côté données validées), suppression annulée (ligne
 * conservée), mises à jour de champs restaurées à leur valeur d'origine.
 * @returns {boolean} true si la ligne portait bien une proposition
 */
function rejectRow(session, id) {
  const idx = session.rows.findIndex(r => r._id === id);
  if (idx === -1) return false;
  const row = session.rows[idx];
  if (row.__pendingInsert) {
    session.rows.splice(idx, 1);
  } else if (row.__pendingDelete) {
    delete row.__pendingDelete;
  } else if (row.__pendingFields) {
    for (const [cle, oldVal] of Object.entries(row.__pendingFields)) row[cle] = oldVal;
    delete row.__pendingFields;
  } else {
    return false;
  }
  touchSession(session);
  return true;
}

/**
 * Valide/rejette une liste de lignes en une passe (sélection multiple via la colonne
 * fusionnée sélection+revue, cf. public/grid.js ReviewHeaderComponent). Ignore
 * silencieusement les _id qui ne portent aucune proposition en attente.
 */
function approveRows(session, ids) {
  for (const id of ids) approveRow(session, id);
}

function rejectRows(session, ids) {
  for (const id of ids) rejectRow(session, id);
}

/**
 * Insère une ligne proposée manuellement (bouton "+ Ligne" en mode revue) — même
 * statut __pendingInsert et mêmes commandes d'approbation/rejet qu'une insertion IA
 * (cf. llmClient.js applyRowActions). `fields` est la ligne déjà construite côté
 * client (valeurs par défaut/placeholders déjà appliquées, cf. grid.js
 * addRowAfterSelected) — on se contente d'assigner l'_id et le marqueur pending.
 *
 * @param {Object} session
 * @param {number|null|'fin'} apres — _id après lequel insérer ; null = en tête ; 'fin' = en dernier
 * @param {Object} fields
 */
function proposeInsertRow(session, apres, fields) {
  const row = { ...fields, _id: consumeNextId(session), __pendingInsert: true };
  if (apres === null || apres === undefined) {
    session.rows.unshift(row);
  } else if (apres === 'fin') {
    session.rows.push(row);
  } else {
    const idx = session.rows.findIndex(r => r._id === apres);
    if (idx === -1) session.rows.push(row);
    else session.rows.splice(idx + 1, 0, row);
  }
  touchSession(session);
}

/**
 * Marque une liste de lignes comme proposées à la suppression (bouton "✂️" en mode
 * revue) — même statut __pendingDelete qu'une suppression IA. Une ligne encore
 * __pendingInsert (jamais validée) est retirée directement : elle n'a jamais existé
 * côté données validées, il n'y a rien à "proposer de supprimer".
 *
 * @param {Object} session
 * @param {Array<number>} ids
 */
function proposeDeleteRows(session, ids) {
  for (const id of ids) {
    const idx = session.rows.findIndex(r => r._id === id);
    if (idx === -1) continue;
    const row = session.rows[idx];
    if (row.__pendingInsert) session.rows.splice(idx, 1);
    else row.__pendingDelete = true;
  }
  touchSession(session);
}

// ── Déplacement manuel de lignes/blocs (boutons ▲/▼/"Déplacer ici") ───────────
/**
 * Déplace un ensemble de lignes (bloc contigu ou non) juste après la ligne _id=apres.
 * Disponible dans toutes les vues (tout objet ligne a un _id, cf. createSession) et
 * dans les deux modes (direct et revue) — un déplacement n'est jamais mis en attente :
 * réordonner ne change aucun contenu, c'est l'outil même destiné à corriger un
 * placement, y compris sur des lignes encore __pendingInsert. Comme les OBJETS ligne
 * existants sont déplacés sans être recréés, tout marqueur __pendingFields/
 * __pendingInsert/__pendingDelete déjà présent survit intact au déplacement.
 *
 * @param {Object} session
 * @param {Array<number>} ids — _id des lignes à déplacer ; réinsérées dans l'ordre où
 *                              elles apparaissent ACTUELLEMENT dans session.rows (pas
 *                              l'ordre de `ids`), pour préserver l'ordre interne du bloc.
 * @param {number|null|'fin'} apres — _id après lequel réinsérer ; null = tête ; 'fin' = fin.
 *                              Doit être hors de `ids` (auto-référence interdite).
 * @returns {boolean} true si au moins une ligne a été déplacée
 */
function moveRows(session, ids, apres) {
  const idSet = new Set(ids);
  if (apres !== null && apres !== undefined && apres !== 'fin' && idSet.has(apres)) {
    console.warn(`[SessionManager] moveRows refusé — _apres (${apres}) fait partie du bloc déplacé`);
    return false;
  }
  const moving = session.rows.filter(r => idSet.has(r._id));
  if (!moving.length) return false;

  session.rows = session.rows.filter(r => !idSet.has(r._id));

  if (apres === null || apres === undefined) {
    session.rows.unshift(...moving);
  } else if (apres === 'fin') {
    session.rows.push(...moving);
  } else {
    const idx = session.rows.findIndex(r => r._id === apres);
    if (idx === -1) {
      console.warn(`[SessionManager] moveRows — _apres introuvable (${apres}), déplacé en fin par sécurité`);
      session.rows.push(...moving);
    } else {
      session.rows.splice(idx + 1, 0, ...moving);
    }
  }
  touchSession(session);
  return true;
}

// ── Reset des rows vers les données source ────────────────────────────────────
/**
 * Remet les rows à l'état initial (données d'entrée de XSpro).
 * Utilisé si l'utilisateur demande un "recommencer".
 *
 * @param {Object} session
 */
function resetRows(session) {
  session.rows = session.data.lignes.map((r, i) => ({ _id: i + 1, ...r }));
  session._nextId = session.rows.length + 1;
  session.history   = [];
  session.llmTurns  = [];
  session.currentPlan = null;
  setStatus(session, STATUS.CONNECTED);
  console.log(`[SessionManager] Rows réinitialisés : ${session.sessionId}`);
}

// ── Touche de vie ─────────────────────────────────────────────────────────────
function touchSession(session) {
  session.lastActivityAt = Date.now();
}

// ── Nettoyage TTL ─────────────────────────────────────────────────────────────
function cleanupExpiredSessions() {
  const now  = Date.now();
  let count  = 0;

  for (const [id, session] of store.entries()) {
    const idle = now - session.lastActivityAt;
    if (idle > SESSION_TTL_MS) {
      // Ferme la WebSocket proprement si encore ouverte
      if (session.ws && session.ws.readyState === 1) {
        try {
          session.ws.send(JSON.stringify({ type: 'session:expired' }));
          session.ws.close();
        } catch (_) { /* ignoré */ }
      }
      store.delete(id);
      count++;
      console.log(`[SessionManager] Session expirée supprimée : ${id}`);
    }
  }

  if (count > 0) {
    console.log(`[SessionManager] Nettoyage TTL : ${count} session(s) supprimée(s)`);
  }
}

// Lance le nettoyage périodique
const _cleanupTimer = setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);
// Ne bloque pas la fermeture du process Node
_cleanupTimer.unref();

// ── Diagnostics ───────────────────────────────────────────────────────────────
/**
 * Liste toutes les sessions actives (pour logs/debug).
 * @returns {Array}
 */
function listSessions() {
  return Array.from(store.values()).map(s => ({
    sessionId:      s.sessionId,
    contextName:    s.contextName,
    status:         s.status,
    rowCount:       s.rows.length,
    historyLength:  s.history.length,
    hasWs:          !!s.ws,
    createdAt:      new Date(s.createdAt).toISOString(),
    lastActivityAt: new Date(s.lastActivityAt).toISOString(),
  }));
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  STATUS,
  createSession,
  getSession,
  setStatus,
  setCellValue,
  consumeNextId,
  pushHistory,
  pushLlmTurn,
  attachWs,
  detachWs,
  deleteSession,
  snapshotRows,
  resetRows,
  listSessions,
  countPendingRows,
  approveField,
  rejectField,
  approveRow,
  rejectRow,
  approveRows,
  rejectRows,
  proposeInsertRow,
  proposeDeleteRows,
  moveRows,
};
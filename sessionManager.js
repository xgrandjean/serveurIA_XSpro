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
    history: [],

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

// ── Mise à jour d'une cellule ─────────────────────────────────────────────────
/**
 * Modifie une valeur dans session.rows et met à jour lastActivityAt.
 *
 * @param {Object} session
 * @param {number} rowIndex  — index dans session.rows
 * @param {string} cle       — clé de la colonne
 * @param {*}      value
 * @returns {boolean}        — true si la mise à jour a eu lieu
 */
function setCellValue(session, rowIndex, cle, value) {
  if (!session.rows[rowIndex]) {
    console.warn(`[SessionManager] setCellValue : rowIndex ${rowIndex} hors limites`);
    return false;
  }
  session.rows[rowIndex][cle] = value;
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
  return session.rows.map(({ _id, ...rest }) => ({ ...rest }));
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
  attachWs,
  detachWs,
  deleteSession,
  snapshotRows,
  resetRows,
  listSessions,
};
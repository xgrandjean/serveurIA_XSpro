/**
 * AI Worker — server.js
 * Point d'entrée principal. Express + WebSocket + gestion de sessions.
 *
 * Modes :
 *   node server.js               → mode serveur (écoute XSpro)
 *   node server.js --standalone  → mode test (charge standalone-payload.json)
 *
 * Dépendances : npm install express ws open cors
 */

'use strict';

const express    = require('express');
const http       = require('http');
const path       = require('path');
const fs         = require('fs');
const { WebSocketServer } = require('ws');
const SM                                        = require('./sessionManager');
const { resolveProvider, getSupportedTypes }    = require('./providers');
const { buildAcceptString }                     = require('./fileTypes');
const { resolveEffectiveWorkerConfig }          = require('./viewResolver');

// ── Résolution des chemins ────────────────────────────────────────────────────
const ROOT            = __dirname;
const PUBLIC_DIR      = path.join(ROOT, 'public');
const PARAMS_FILE     = path.join(ROOT, 'parametresAi.json');

// ── Détection du mode et du payload ───────────────────────────────────────────
const IS_STANDALONE = process.argv.includes('--standalone');
const STANDALONE_ARG = process.argv.find(arg => arg.startsWith('--payload='));
const STANDALONE_DIR = path.join(ROOT, 'standalone');
// Accepte soit un chemin complet, soit un nom de payload (ex: "detailsDevis")
let STANDALONE_FILE;
if (STANDALONE_ARG) {
  const payloadValue = STANDALONE_ARG.replace('--payload=', '');
  // Si c'est un chemin absolu ou relatif contenant des séparateurs, l'utiliser tel quel
  if (payloadValue.includes(path.sep) || payloadValue.startsWith('/')) {
    STANDALONE_FILE = payloadValue;
  } else {
    // Sinon, c'est un nom de contexte → construire le nom de fichier
    STANDALONE_FILE = path.join(STANDALONE_DIR, `standalone-payload-${payloadValue}.json`);
  }
} else {
  STANDALONE_FILE = path.join(STANDALONE_DIR, 'standalone-payload.json');
}

// ── Configuration Worker (worker-config.json) ────────────────────────────────
const WORKER_CONFIG_FILE = path.join(ROOT, 'worker-config.json');
let WORKER_CONFIG = { port: 8888, contexts: { listeBlanche: [], listeNoire: [] } };

if (fs.existsSync(WORKER_CONFIG_FILE)) {
  try {
    const raw = JSON.parse(fs.readFileSync(WORKER_CONFIG_FILE, 'utf-8'));
    WORKER_CONFIG = {
      port:     raw.port     || 8888,
      callbackUrl: raw.callbackUrl || null,
      callbackUrlPriority: !!raw.callbackUrlPriority,
      autoOpenUI: raw.autoOpenUI !== false, // défaut true
      contexts: {
        listeBlanche: Array.isArray(raw.contexts?.listeBlanche) ? raw.contexts.listeBlanche : [],
        listeNoire:   Array.isArray(raw.contexts?.listeNoire)   ? raw.contexts.listeNoire   : [],
      },
    };
    // console.log(`[Worker] Config chargee : port=${WORKER_CONFIG.port}`);
  } catch (e) {
    console.warn(`[Worker] Erreur lecture worker-config.json : ${e.message} — valeurs par défaut`);
  }
}

const PORT = WORKER_CONFIG.port;

// ── Verrou anti-double-instance ───────────────────────────────────────────────
const LOCK_FILE = path.join(ROOT, '.worker.lock');

function readLockPid() {
  if (!fs.existsSync(LOCK_FILE)) return null;
  try { return parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10) || null; }
  catch { return null; }
}

// Renvoie true si le processus avec ce PID existe toujours (false si mort/crash)
function isProcessAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function cleanupLock() {
  try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch {}
}

// ── Résolution des contextes autorisés ───────────────────────────────────────
/**
 * @param {string} contextName
 * @returns {boolean}
 */
function isContextAllowed(contextName) {
  const { listeBlanche, listeNoire } = WORKER_CONFIG.contexts;

  // Liste noire prioritaire
  if (listeNoire.includes(contextName)) {
    console.log(`[Worker] Contexte refusé (liste noire) : ${contextName}`);
    return false;
  }

  // Liste blanche vide = tout accepter
  if (listeBlanche.length === 0) return true;

  // Liste blanche non vide = filtre
  const allowed = listeBlanche.includes(contextName);
  // if (!allowed) console.log(`[Worker] Contexte refusé (hors liste blanche) : ${contextName}`);
  return allowed;
}

// ── Application Express ───────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));

// Fichiers statiques publics (UI)
if (!fs.existsSync(PUBLIC_DIR)) {
  console.error(`[Worker] ⚠ Dossier public/ introuvable : ${PUBLIC_DIR}`);
  console.error(`[Worker] Crée le dossier public/ avec index.html, grid.js, style.css`);
}
app.use(express.static(PUBLIC_DIR));

// Route explicite pour index.html (fallback si le static middleware rate)
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// ── Endpoint : ouverture UI à la demande ──────────────────────────────────────
// XSpro appelle GET /open-ui?sessionId=xxx pour ouvrir le navigateur
// uniquement quand l'utilisateur a demandé l'ouverture manuellement.
app.get('/open-ui', (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) return res.status(400).json({ error: 'sessionId requis' });

  const session = SM.getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session inconnue' });

  if (!session.ws || session.ws.readyState !== 1) {
    const uiUrl = `http://localhost:${PORT}/index.html?sessionId=${sessionId}`;
    openBrowser(uiUrl);
    return res.json({ opened: true, url: uiUrl });
  }

  // UI déjà connectée via WebSocket
  res.json({ opened: false, reason: ' déjà connectée' });
});

// Route exports Excel — lazy require pour ne pas bloquer le démarrage si exceljs absent
const EXPORTS_DIR_PATH = path.join(ROOT, 'exports');
if (!fs.existsSync(EXPORTS_DIR_PATH)) fs.mkdirSync(EXPORTS_DIR_PATH, { recursive: true });
app.use('/exports', express.static(EXPORTS_DIR_PATH, {
  setHeaders: (res, fp) => {
    if (fp.endsWith('.xlsx')) {
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(fp)}"`);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    }
  },
}));

// CORS permissif pour usage local uniquement
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Endpoint : probe de disponibilité ────────────────────────────────────────
// XSpro teste HEAD /view-config/ avant tout appel
app.head('/view-config/', (req, res) => {
  res.sendStatus(200);
});
app.get('/view-config/', (req, res) => {
  res.json({ status: 'ok', worker: 'ai-worker', version: '1.0.0' });
});

// ── Endpoint : découverte de vue ──────────────────────────────────────────────
// GET /view-config/:contextName
// Si le Worker héberge un manifeste local pour ce contextName, il le renvoie.
// Sinon 404 → XSpro garde sa config locale.
app.get('/view-config/:contextName', (req, res) => {
  const configFile = path.join(ROOT, 'view-configs', `${req.params.contextName}.json`);
  if (fs.existsSync(configFile)) {
    try {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      return res.json(config);
    } catch (e) {
      return res.status(500).json({ error: 'Erreur lecture config locale' });
    }
  }
  res.status(404).json({ error: 'Vue inconnue' });
});

// ── Endpoint principal : POST /process ───────────────────────────────────────
// XSpro envoie le payload complet ici.
// Le Worker répond immédiatement avec { sessionId } et ouvre la fenêtre UI.
// La réponse finale arrive via WebSocket (ou callbackUrl HTTP).
app.post('/process', async (req, res) => {
  const payload = req.body;


  // Validation structurelle minimale
  if (!payload || !payload.sessionId || !payload.contextName) {
    return res.status(400).json({
      status:  'unknown',
      message: 'Payload invalide : sessionId et contextName requis',
      rows:    [],
    });
  }

  if (!payload.workerConfig?.colonnes?.length) {
    await notifyXSpro(payload.callbackUrl, {
      sessionId:   payload.sessionId,
      contextName: payload.contextName,
      status:      'unknown',
      rows:        [],
      message:     'workerConfig.colonnes manquant ou vide — traitement local recommandé',
    });
    return res.status(422).json({ status: 'unknown', message: 'workerConfig invalide' });
  }

  // ── Vérification des flags de capacité workerConfig ─────────────────────────
  const { copyToClipBoard, exportExcel } = payload.workerConfig || {};

  // copyToClipBoard === true → XSpro demande une fonctionnalité non supportée
  if (copyToClipBoard === true) {
    await notifyXSpro(payload.callbackUrl, {
      sessionId:   payload.sessionId,
      contextName: payload.contextName,
      status:      'unknown',
      rows:        [],
      message:     'copyToClipBoard demandé mais non supporté par ce Worker',
    });
    return res.status(422).json({ status: 'unknown', message: 'copyToClipBoard non supporté' });
  }

  // exportExcel === false → requête standard sans export, ce Worker ne produit qu'un export Excel comme résultat
  if (exportExcel === false) {
    await notifyXSpro(payload.callbackUrl, {
      sessionId:   payload.sessionId,
      contextName: payload.contextName,
      status:      'unknown',
      rows:        [],
      message:     'exportExcel=false — requête standard sans export non gérée par ce Worker',
    });
    return res.status(422).json({ status: 'unknown', message: 'exportExcel=false non supporté (ce Worker produit un export Excel)' });
  }

  // ── Vérification liste blanche / liste noire ────────────────────────────────
  if (!isContextAllowed(payload.contextName)) {
    await notifyXSpro(payload.callbackUrl, {
      sessionId:   payload.sessionId,
      contextName: payload.contextName,
      status:      'unknown',
      rows:        [],
      message:     `Contexte "${payload.contextName}" non traité par ce Worker`,
    });
    return res.status(200).json({ status: 'unknown', message: `Contexte non pris en charge` });
  }

  // ── Résolution callbackUrl (payload XSpro prime, sauf si priorité locale) ──
  const localCallback = WORKER_CONFIG.callbackUrl;
  if (WORKER_CONFIG.callbackUrlPriority === true && localCallback) {
    // Priorité locale : on impose le callbackUrl de worker-config.json
    payload.callbackUrl = localCallback;
  } else if (!payload.callbackUrl && localCallback) {
    // Fallback local : XSpro n'a pas fourni de callbackUrl
    payload.callbackUrl = localCallback;
  }

  const session = SM.createSession(payload);

  // Résolution du MANIFEST hook vue → session.effectiveWorkerConfig
  // Fait une seule fois ici, consommé par WS init et llmClient.js
  resolveEffectiveWorkerConfig(session);

  // Réponse immédiate → XSpro sait que le Worker a pris en charge la requête
  res.json({ sessionId: session.sessionId, status: 'accepted' });

  // Ouverture de la fenêtre UI dans le navigateur (si activé dans la config)
  if (WORKER_CONFIG.autoOpenUI) {
    const uiUrl = `http://localhost:${PORT}/index.html?sessionId=${session.sessionId}`;
    openBrowser(uiUrl);
  }
});

// ── Endpoint : résultat final renvoyé vers XSpro ─────────────────────────────
// Appelé par la logique interne quand l'utilisateur valide dans l'UI.
// Si callbackUrl est null → export Excel (géré dans excelExport.js, étape suivante).
// ── Notification XSpro (générique) ──────────────────────────────────────────
/**
 * Envoie un message structuré vers callbackUrl.
 * @returns {boolean} true si XSpro a bien répondu
 */
async function notifyXSpro(callbackUrl, payload) {
  if (!callbackUrl) return false;

  try {
    const { default: fetch } = await import('node-fetch');
    const response = await fetch(callbackUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(5000), // 5s timeout
    });
    if (response.ok) {
      // console.log(`[Worker] XSpro notifié (${payload.status}) → ${response.status}`);
      return true;
    }
    // console.warn(`[Worker] XSpro a répondu ${response.status}`);
    return false;
  } catch (e) {
    console.warn(`[Worker] XSpro injoignable : ${e.message}`);
    return false;
  }
}

// ── Livraison du résultat final ───────────────────────────────────────────────
/**
 * Cas 3 — done : envoie les rows à XSpro, fallback Excel si absent/injoignable.
 * @returns {boolean} true si XSpro a bien reçu le résultat, false si fallback Excel
 */
async function deliverResult(session, finalRows) {
  SM.setStatus(session, SM.STATUS.DELIVERING);

  const payload = {
    sessionId:   session.sessionId,
    contextName: session.contextName,
    status:      'done',
    rows:        finalRows,
    message:     `${finalRows.length} ligne(s) traitée(s)`,
  };

  // Tentative envoi vers XSpro
  const delivered = await notifyXSpro(session.callbackUrl, payload);

   // Fallback Excel si XSpro absent ou injoignable
   if (!delivered) {
     console.log(`[Worker] Fallback Excel → export pour ${session.sessionId}`);
     try {
       const excelExport = require('./excelExport');
       await excelExport.exportSession(session, finalRows, session.exportFormat);
     } catch (e) {
       console.error('[Worker] Erreur export Excel :', e.message);
     }
   }

  return delivered;
}

// ── Notification annulation vers XSpro ───────────────────────────────────────
/**
 * Cas 2 — cancelled : informe XSpro que l'utilisateur a annulé.
 */
async function notifyCancelled(session) {
  await notifyXSpro(session.callbackUrl, {
    sessionId:   session.sessionId,
    contextName: session.contextName,
    status:      'cancelled',
    rows:        [],
    message:     "Session annulée par l'utilisateur",
  });
}

// ── Serveur HTTP ──────────────────────────────────────────────────────────────
const httpServer = http.createServer(app);

// ── WebSocket ─────────────────────────────────────────────────────────────────
// L'UI se connecte via ws://localhost:{PORT}/ws?sessionId=xxx
// Le Worker pousse les updates cellule par cellule et reçoit les actions utilisateur.
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url       = new URL(req.url, `http://localhost:${PORT}`);
  const sessionId = url.searchParams.get('sessionId');
  const session   = SM.getSession(sessionId);

  if (!session) {
    ws.send(JSON.stringify({ type: 'error', message: `Session inconnue : ${sessionId}` }));
    ws.close();
    return;
  }

  // Attache la socket à la session via SM
  SM.attachWs(session, ws);
  console.log(`[WS] UI connectée → session ${sessionId}`);

  // Résolution du provider pour construire l'accept string
  const { id: providerId }    = resolveProvider(session.ia);
  const supportedTypes         = getSupportedTypes(providerId);
  const acceptString           = buildAcceptString(supportedTypes);

   // Envoie l'état initial (config grille effective + données)
    ws.send(JSON.stringify({
      type:         'init',
      sessionId,
      contextName:  session.contextName,
      workerConfig: session.effectiveWorkerConfig,
      rows:         session.rows,
      infosParent:  session.data.infosParent || {},
      providerId,
      acceptString,
      supportedTypes,
      xsproPayload: session.xsproPayload,
      modes:        session.modes       || {},
      selectChoix:  session.selectChoix || {},
      rowStyles:    session.rowStyles   || [],
      colonnesDerivees: session.colonnesDerivees || {},
    }));

    // Validation initiale des lignes (pour cohérence affichage ↔ édition)
    // Une ligne invalide doit apparaître barrée comme après édition manuelle, et une
    // ligne partiellement remplie doit afficher ses champs encore requis en rouge —
    // même logique qu'après une édition manuelle acceptée (cf. cas 'cell:edit' plus bas).
    if (Array.isArray(session.rows) && (session.viewHook?.getInvalidFields || session.viewHook?.getMissingFields)) {
      session.rows.forEach((row, rowIndex) => {
        const invalidFields = session.viewHook.getInvalidFields?.(row) || [];
        const missingFields = session.viewHook.getMissingFields?.(row) || [];
        const combined = Array.from(new Set([...invalidFields, ...missingFields]));
        if (combined.length > 0) {
          wsSend(session, { type: 'cell:validate', rowIndex, invalidFields: combined, message: null });
        }
      });
    }

  // Messages entrants depuis l'UI
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    await handleUIMessage(session, msg);
  });

  ws.on('close', () => {
    SM.detachWs(session);
    console.log(`[WS] UI déconnectée → session ${sessionId}`);
  });

  ws.on('error', (err) => {
    console.error(`[WS] Erreur session ${sessionId} :`, err.message);
  });
});

// ── Dispatcher messages UI → Worker ──────────────────────────────────────────
async function handleUIMessage(session, msg) {
  const { type } = msg;

  switch (type) {

    // L'utilisateur valide une cellule éditée manuellement
    case 'cell:edit': {
      const { rowIndex, cle, value } = msg;
      console.log('[DEBUG] cell:edit', { rowIndex, cle, value: JSON.stringify(value) });
      // Validation métier via le hook vue
      if (session.viewHook?.validateCellEdit) {
        const row = { ...session.rows[rowIndex] };
        const result = session.viewHook.validateCellEdit(row, cle, value);
        console.log('[DEBUG] validateCellEdit result:', JSON.stringify(result));
        if (!result.ok) {
          if (result.rowInvalid) {
            wsSend(session, {
              type: 'cell:validate',
              rowIndex,
              invalidFields: result.invalidFields || [],
              message: result.message,
            });
          } else {
            console.log('[DEBUG] cell:edit → REVERT!');
            wsSend(session, {
              type: 'cell:revert',
              rowIndex, cle,
              value: session.rows[rowIndex]?.[cle],
              message: result.message,
            });
            break;
          }
        } else {
          wsSend(session, {
            type: 'cell:validate',
            rowIndex,
            invalidFields: result.invalidFields || [],
            message: null,
          });
        }
      }
      SM.setCellValue(session, rowIndex, cle, value);
      break;
    }

    // L'utilisateur demande un aperçu du prompt réellement envoyé (sans appel LLM)
    case 'prompt:preview': {
      const { prompt, mode, files = [], activeMode = null } = msg;
      session.activeMode = activeMode;
      try {
        const llmClient = require('./llmClient');
        const preview = await llmClient.buildPromptPreview(session, prompt, mode, files);
        wsSend(session, {
          type:    'prompt:preview',
          system:  preview.system,
          full:    preview.full,
        });
      } catch (e) {
        wsSend(session, { type: 'error', message: `⚠ Aperçu impossible : ${e.message}` });
      }
      break;
    }

    // L'utilisateur lance un prompt (mode Plan ou Act direct)
    case 'prompt:send': {
      const { prompt, mode, files = [], activeMode = null } = msg; // mode: 'plan' | 'act'

      // Mémoriser le mode actif UI pour plan:validate (qui n'a pas de nouveau activeMode)
      session.activeMode = activeMode;

      SM.pushHistory(session, 'user', prompt);
      SM.setStatus(session, mode === 'plan' ? SM.STATUS.PLANNING : SM.STATUS.ACTING);
      wsSend(session, { type: 'status', status: session.status });

      try {
        const llmClient = require('./llmClient');
        await llmClient.run(session, prompt, mode, {
          onPlan:       (plan)              => wsSend(session, { type: 'plan', plan }),
          onCellUpdate: (rowIndex, cle, val) => {
            SM.setCellValue(session, rowIndex, cle, val);
            wsSend(session, { type: 'cell:update', rowIndex, cle, value: val });
          },
          onDone: (updatedRows) => {
            session.rows = updatedRows;
            SM.setStatus(session, SM.STATUS.PAUSED);
            wsSend(session, { type: 'act:done', rows: updatedRows });
          },
        }, files, activeMode);
      } catch (e) {
        SM.setStatus(session, SM.STATUS.ERROR);
        wsSend(session, { type: 'error', message: e.message });
      }
      break;
    }

    // L'utilisateur valide le plan et lance l'exécution
    case 'plan:validate': {
      SM.setStatus(session, SM.STATUS.ACTING);
      wsSend(session, { type: 'status', status: SM.STATUS.ACTING });
      try {
        const llmClient = require('./llmClient');
        // session.activeMode mémorisé lors du prompt:send qui a déclenché le plan
        await llmClient.run(session, null, 'act', {
          onCellUpdate: (rowIndex, cle, val) => {
            SM.setCellValue(session, rowIndex, cle, val);
            wsSend(session, { type: 'cell:update', rowIndex, cle, value: val });
          },
          onDone: (updatedRows) => {
            session.rows = updatedRows;
            SM.setStatus(session, SM.STATUS.PAUSED);
            wsSend(session, { type: 'act:done', rows: updatedRows });
          },
        }, [], session.activeMode);
      } catch (e) {
        SM.setStatus(session, SM.STATUS.ERROR);
        wsSend(session, { type: 'error', message: e.message });
      }
      break;
    }

    // L'utilisateur valide le résultat final et demande l'export/renvoi
    case 'session:validate': {
      wsSend(session, { type: 'status', status: SM.STATUS.DELIVERING });
      const finalRows = SM.snapshotRows(session);
      wsSend(session, { type: 'xspro:response', payload: { sessionId: session.sessionId, contextName: session.contextName, status: 'done', rows: finalRows, message: `${finalRows.length} ligne(s) traitée(s)` } });
      const delivered = await deliverResult(session, finalRows);
      SM.setStatus(session, SM.STATUS.DONE);
      wsSend(session, { type: 'session:done', exportFallback: !delivered });
      break;
    }

    // L'utilisateur réinitialise les rows (recommencer)
    case 'session:reset': {
      SM.resetRows(session);
      wsSend(session, { type: 'init', sessionId: session.sessionId, contextName: session.contextName, workerConfig: session.effectiveWorkerConfig, rows: session.rows, infosParent: session.data.infosParent, modes: session.modes || {}, selectChoix: session.selectChoix || {} });
      break;
    }

    // Sync complet des rows (après ajout/suppression manuel de lignes)
    case 'rows:sync': {
      if (Array.isArray(msg.rows)) {
        session.rows = msg.rows;
        console.log(`[WS] rows:sync — ${session.rows.length} lignes pour ${session.sessionId}`);
      }
      break;
    }

    // L'utilisateur annule — cas 2
    case 'session:cancel': {
      SM.setStatus(session, SM.STATUS.CANCELLED);
      wsSend(session, { type: 'session:cancelled' });
      wsSend(session, { type: 'xspro:response', payload: { sessionId: session.sessionId, contextName: session.contextName, status: 'cancelled', rows: [], message: "Session annulée par l'utilisateur" } });
      await notifyCancelled(session);   // informe XSpro si présent
      SM.deleteSession(session.sessionId);
      break;
    }

    default:
      console.warn(`[WS] Message inconnu : ${type}`);
  }
}

// ── Helper : envoi WebSocket sécurisé ────────────────────────────────────────
function wsSend(session, data) {
  if (session.ws && session.ws.readyState === 1 /* OPEN */) {
    session.ws.send(JSON.stringify(data));
  }
}

// ── Ouverture navigateur ──────────────────────────────────────────────────────
async function openBrowser(url) {
  try {
    const { default: open } = await import('open');
    await open(url);
    console.log(`[Worker] Navigateur ouvert → ${url}`);
  } catch (e) {
    console.warn(`[Worker] Impossible d'ouvrir le navigateur : ${e.message}`);
    console.log(`[Worker] Ouvre manuellement : ${url}`);
  }
}

// ── Mode standalone ───────────────────────────────────────────────────────────
// Charge standalone-payload.json et crée la session automatiquement.
function startStandaloneMode() {
  if (!fs.existsSync(STANDALONE_FILE)) {
    console.error(`[Standalone] Fichier introuvable : ${STANDALONE_FILE}`);
    process.exit(1);
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(STANDALONE_FILE, 'utf-8'));
  } catch (e) {
    console.error(`[Standalone] Erreur lecture payload : ${e.message}`);
    process.exit(1);
  }

  console.log(`[Standalone] Payload chargé → contextName: ${payload.contextName}`);

  // callbackUrl forcé à null en standalone → toujours fallback Excel
  payload.callbackUrl = null;

  const session = SM.createSession(payload);

  // Résolution du MANIFEST hook vue (même logique qu'en mode serveur)
  resolveEffectiveWorkerConfig(session);

  const uiUrl   = `http://localhost:${PORT}/index.html?sessionId=${session.sessionId}`;

  // Afficher le nom du fichier chargé
  const payloadFileName = path.basename(STANDALONE_FILE);
  console.log(`[Standalone] Fichier : ${payloadFileName}`);

  // Petit délai pour laisser le serveur démarrer avant d'ouvrir le navigateur
  setTimeout(() => openBrowser(uiUrl), 500);
}

// ── Démarrage ─────────────────────────────────────────────────────────────────
// Filet de sécurité : si le port est déjà pris (autre instance), message clair
// au lieu d'une stack trace d'erreur fatale.
httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('────────────────────────────────────────────');
    console.log(`ℹ️  Le port ${PORT} est déjà utilisé.`);
    console.log('    Une instance du Worker est probablement déjà lancée.');
    console.log('    Cas prévu et géré : cette instance s\'arrête, l\'autre continue de répondre.');
    console.log('────────────────────────────────────────────');
    process.exit(0);
  }
  console.error(`[Worker] Erreur serveur : ${err.message}`);
  process.exit(1);
});

// Contrôle anti-double-instance (indépendant du port) : si un verrou valide
// pointe vers un PID encore vivant, on ne relance pas une seconde fois.
const lockPid = readLockPid();
if (lockPid && isProcessAlive(lockPid)) {
  console.log('────────────────────────────────────────────');
  console.log(`ℹ️  Le Worker tourne déjà (PID ${lockPid}).`);
  console.log('    Une seule instance suffit — cette instance s\'arrête.');
  console.log('────────────────────────────────────────────');
  process.exit(0);
} else if (lockPid) {
  // Verrou périmé (crash sans nettoyage) → on le retire avant de redémarrer
  cleanupLock();
}

// Nettoyage du verrou à la fermeture (quitter, Ctrl+C, terminaison)
process.on('exit', cleanupLock);
process.on('SIGINT',  () => { cleanupLock(); process.exit(0); });
process.on('SIGTERM', () => { cleanupLock(); process.exit(0); });

httpServer.listen(PORT, () => {
  // Pose le verrou (PID courant) pour empêcher tout futur double-lancement
  try { fs.writeFileSync(LOCK_FILE, String(process.pid)); } catch {}

  console.log(`============================================`);
  console.log(`AI Worker  -  http://localhost:${PORT}`);
  console.log(`Mode : ${IS_STANDALONE ? 'STANDALONE' : 'SERVEUR (ecoute XSpro)'}`);
  if (IS_STANDALONE) {
    console.log(`Payload : ${path.basename(STANDALONE_FILE)}`);
  }
  console.log(`============================================`);

  // Nettoyage exports anciens (lazy — exceljs peut ne pas être installé au premier lancement)
  try {
    const { cleanOldExports } = require('./excelExport');
    cleanOldExports(7);
  } catch (e) {
    console.warn('[Worker] excelExport non disponible au démarrage :', e.message);
  }
  if (IS_STANDALONE) startStandaloneMode();
});

// ── Exports (pour tests unitaires éventuels) ──────────────────────────────────
module.exports = { deliverResult, wsSend };
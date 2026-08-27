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
// ASSETS_ROOT : base des fichiers statiques en lecture seule (public/, views/,
// worker-config.json, standalone/). DATA_ROOT : base des fichiers écrits à
// l'exécution (.worker.lock, exports/). Les deux retombent, par ordre de
// priorité, sur AI_WORKER_*_DIR (positionnées par XSpro quand il spawn l'exe
// compilé), puis sur le dossier de l'exe (si lancé via `pkg`), puis sur
// __dirname (lancement manuel `node server.js` depuis les sources — inchangé).
const ROOT            = __dirname;
const EXE_DIR          = (typeof process.pkg !== 'undefined') ? path.dirname(process.execPath) : ROOT;
const ASSETS_ROOT      = process.env.AI_WORKER_ASSETS_DIR || EXE_DIR;
const DATA_ROOT         = process.env.AI_WORKER_DATA_DIR   || EXE_DIR;
const PUBLIC_DIR      = path.join(ASSETS_ROOT, 'public');
const PARAMS_FILE     = path.join(ASSETS_ROOT, 'parametresAi.json');

// ── Détection du mode et du payload ───────────────────────────────────────────
const IS_STANDALONE = process.argv.includes('--standalone');
const STANDALONE_ARG = process.argv.find(arg => arg.startsWith('--payload='));
const STANDALONE_DIR = path.join(ASSETS_ROOT, 'standalone');
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
const WORKER_CONFIG_FILE = path.join(ASSETS_ROOT, 'worker-config.json');
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
const LOCK_FILE = path.join(DATA_ROOT, '.worker.lock');

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
const EXPORTS_DIR_PATH = path.join(DATA_ROOT, 'exports');
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
  const configFile = path.join(ASSETS_ROOT, 'view-configs', `${req.params.contextName}.json`);
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
  const { copyToClipBoard } = payload.workerConfig || {};

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

  // exportExcel : n'est plus une condition d'acceptation de la requête — XSpro décide de la
  // destination du résultat (copie presse-papier systématique, puis raccourcis optionnels) une
  // fois le résultat reçu, pas avant l'envoi. La génération d'un Excel par CE Worker reste gérée
  // ailleurs, uniquement en secours quand XSpro est injoignable (cf. deliverResult ci-dessous).

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

  // Identité standalone/XSpro de la session — un vrai appel XSpro n'envoie jamais
  // _origin, donc reste 'xspro' par défaut (aucune régression). Consommé par
  // viewResolver.js pour la priorité des promptsSuggeres par mode.
  session.origin = payload._origin === 'standalone' ? 'standalone' : 'xspro';

  // Résolution du MANIFEST hook vue → session.effectiveWorkerConfig
  // Fait une seule fois ici, consommé par WS init et llmClient.js
  resolveEffectiveWorkerConfig(session);

  // Réponse immédiate → XSpro sait que le Worker a pris en charge la requête
  res.json({ sessionId: session.sessionId, status: 'accepted' });

  // Ouverture de la fenêtre UI dans le navigateur (si activé dans la config).
  // AI_WORKER_DISABLE_AUTO_OPEN=1 : positionné par XSpro quand il pilote ce
  // process (le paquet `open` échoue une fois compilé via pkg — XSpro ouvre
  // alors lui-même le navigateur via shell.openExternal, plus fiable).
  // Absent (lancement manuel/standalone) → comportement inchangé.
  if (WORKER_CONFIG.autoOpenUI && process.env.AI_WORKER_DISABLE_AUTO_OPEN !== '1') {
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
    // Pas d'import dynamique ici : `open` a déjà cassé de cette façon une fois compilé
    // via pkg (cf. ipcAI.js côté XSpro) — on utilise le fetch global natif (Node 18+,
    // déjà la cible pkg de ce build), qui ne dépend d'aucune résolution ESM dynamique.
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
       origin:       session.origin,
       workerConfig: session.effectiveWorkerConfig,
       rows:         session.rows,
       infosParent:  session.data.infosParent || {},
       providerId,
       // Modele LLM reellement utilise pour l'appel (cf. callLLM : `model: ia.model`).
       // Nomme `modeleIA` et non `modele` : `data.modele` designe deja les lignes-modele
       // fournies par XSpro, la collision aurait ete difficile a demeler.
       modeleIA:     session.ia?.model || null,
       acceptString,
       supportedTypes,
       xsproPayload: session.xsproPayload,
       modes:        session.modes       || {},
       selectChoix:  session.selectChoix || {},
       champsRestreints: session.champsRestreints || {},
       champsNonApplicables: session.champsNonApplicables || {},
       rowStyles:    session.rowStyles   || [],
       colonnesDerivees: session.colonnesDerivees || {},
       reviewMode:   !!session.reviewMode,
       pendingCount: SM.countPendingRows(session),
     }));

    // Validation initiale des lignes (pour cohérence affichage ↔ édition)
    // Une ligne invalide doit apparaître barrée comme après édition manuelle, et une
    // ligne partiellement remplie doit afficher ses champs encore requis en rouge —
    // même logique qu'après une édition manuelle acceptée (cf. cas 'cell:edit' plus bas).
    // Note : le grisage des champs non applicables au type (champsNonApplicables) ne
    // passe pas par ce mécanisme — c'est une map statique consommée directement côté
    // client (public/grid.js), pas besoin de la recalculer par ligne ici.
    revalidateAllRows(session);

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
      let sideEffects = null;
      let invalidFields = [];
      let validateMessage = null;

      // Validation métier via le hook vue
      if (session.viewHook?.validateCellEdit) {
        const row = { ...session.rows[rowIndex] };
        const result = session.viewHook.validateCellEdit(row, cle, value);
        if (!result.ok) {
          if (result.rowInvalid) {
            // type/désignation → garder la valeur, champs fautifs remontés plus bas
            invalidFields = result.invalidFields || [];
            validateMessage = result.message;
            // Ne pas break : on accepte la valeur
          } else {
            // Autre champ → revert (pas de rouge : la valeur est restaurée)
            wsSend(session, {
              type: 'cell:revert',
              rowIndex, cle,
              value: session.rows[rowIndex]?.[cle],
              message: result.message,
            });
            break; // ne pas setCellValue
          }
        } else {
          // Ligne valide → conserver l'affichage des champs encore requis pour ce
          // type (result.invalidFields = getMissingFields, purement indicatif — cf.
          // viewHook.validateCellEdit), sans quoi le rouge "à remplir" disparaît dès
          // que la modification est acceptée.
          invalidFields = result.invalidFields || [];
          sideEffects = result.sideEffects || null;
        }
      }

      // Commit — ou mise en attente en mode revue, cf. SM.setCellValue : même
      // traitement qu'une proposition IA, peu importe l'origine du changement
      // (décision du 2026-07-30). Appelé AVANT l'envoi de cell:validate ci-dessous
      // pour que pendingFields reflète l'état réellement à jour.
      SM.setCellValue(session, rowIndex, cle, value);

      // Effets de bord déclarés par le hook (ex: réconcilier un champ dont les valeurs
      // référencent le champ qu'on vient d'éditer — cf. champsIndexRef). Générique : on
      // applique et on notifie ce que le hook a calculé, sans connaître les noms de champs.
      if (sideEffects) {
        for (const [field, val] of Object.entries(sideEffects)) {
          SM.setCellValue(session, rowIndex, field, val);
          wsSend(session, { type: 'cell:update', rowIndex, cle: field, value: val });
        }
      }

      // Message consolidé : rouge (invalide) + jaune (en attente, mode revue),
      // état final après commit et effets de bord. pendingCount permet au client de
      // mettre à jour la visibilité de "Valider et exporter" sans repasser par
      // review:sync (édition manuelle = pas de changement de rows, juste de champ).
      // pendingFields transporte l'OBJET complet { champ: valeurOrigine } et non ses
      // seules clés : le client s'en sert pour afficher l'ancienne valeur au survol, et
      // n'a aucun autre moyen de la connaître (review:sync n'est pas émis ici). N'envoyer
      // que les clés écrasait les valeurs d'origine déjà reçues pour cette ligne.
      const finalRow = session.rows[rowIndex];
      wsSend(session, {
        type: 'cell:validate',
        rowIndex,
        invalidFields,
        pendingFields: session.reviewMode ? { ...(finalRow?.__pendingFields || {}) } : {},
        pendingCount: session.reviewMode ? SM.countPendingRows(session) : undefined,
        message: validateMessage,
      });
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

    // Consultation de l'echange reellement transmis au LLM lors du dernier appel.
    // Distinct de 'prompt:preview', qui reconstruit ce qui PARTIRAIT maintenant : ici on
    // restitue ce qui EST parti, reponse comprise, sans rien recalculer.
    case 'prompt:dernierEnvoi': {
      const env = session.dernierEnvoi;
      wsSend(session, {
        type:       'prompt:dernierEnvoi',
        present:    !!env,
        messages:   env ? env.messages : null,
        reponse:    env ? env.reponse  : null,
        modele:     env ? env.modele   : null,
        mode:       env ? env.mode     : null,
        horodatage: env ? env.horodatage : null,
      });
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
          onDone: (updatedRows, meta) => {
            session.rows = updatedRows;
            SM.setStatus(session, SM.STATUS.PAUSED);
            wsSend(session, { type: 'act:done', rows: updatedRows, pendingCount: SM.countPendingRows(session), actionsResume: meta?.actionsResume || null, rapport: meta?.rapport || null });
          },
        }, files, activeMode);
      } catch (e) {
        SM.setStatus(session, SM.STATUS.ERROR);
        // Message d'erreur enrichi avec cause, suggestion, httpStatus si disponibles
        const errorMsg = {
          type: 'error',
          message: e.message || '⚠ Erreur inconnue',
          cause: e.cause || 'unknown',
          suggestion: e.suggestion || null,
          httpStatus: e.httpStatus || null,
          timestamp: Date.now(),
        };
        console.error(`[WS] Erreur session ${session.sessionId} (prompt:send ${mode}) :`, e.message, e.cause ? `(cause: ${e.cause})` : '');
        wsSend(session, errorMsg);
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
          onDone: (updatedRows, meta) => {
            session.rows = updatedRows;
            SM.setStatus(session, SM.STATUS.PAUSED);
            wsSend(session, { type: 'act:done', rows: updatedRows, pendingCount: SM.countPendingRows(session), actionsResume: meta?.actionsResume || null, rapport: meta?.rapport || null });
          },
        }, [], session.activeMode);
      } catch (e) {
        SM.setStatus(session, SM.STATUS.ERROR);
        const errorMsg = {
          type: 'error',
          message: e.message || '⚠ Erreur inconnue',
          cause: e.cause || 'unknown',
          suggestion: e.suggestion || null,
          httpStatus: e.httpStatus || null,
          timestamp: Date.now(),
        };
        console.error(`[WS] Erreur session ${session.sessionId} (plan:validate) :`, e.message, e.cause ? `(cause: ${e.cause})` : '');
        wsSend(session, errorMsg);
      }
      break;
    }

    // ── Revue des propositions IA (mode revueParPending) ────────────────────────
    // Chaque action agit sur session.rows (marqueurs __pendingFields/__pendingInsert/
    // __pendingDelete posés par llmClient.js) puis renvoie l'état à jour à l'UI.
    case 'review:approveField': {
      SM.approveField(session, msg.id, msg.cle);
      sendReviewSync(session);
      break;
    }
    case 'review:rejectField': {
      SM.rejectField(session, msg.id, msg.cle);
      sendReviewSync(session);
      break;
    }
    case 'review:approveRow': {
      SM.approveRow(session, msg.id);
      sendReviewSync(session);
      break;
    }
    case 'review:rejectRow': {
      SM.rejectRow(session, msg.id);
      sendReviewSync(session);
      break;
    }
    // Validation/rejet multi-lignes (sélection via la colonne fusionnée
    // sélection+revue, commandes dans son en-tête — cf. public/grid.js ReviewHeaderComponent)
    case 'review:approveRows': {
      SM.approveRows(session, Array.isArray(msg.ids) ? msg.ids : []);
      sendReviewSync(session);
      break;
    }
    case 'review:rejectRows': {
      SM.rejectRows(session, Array.isArray(msg.ids) ? msg.ids : []);
      sendReviewSync(session);
      break;
    }

    // Ajout/suppression manuelle de ligne (boutons "+ Ligne"/"✂️") en mode revue —
    // même statut __pendingInsert/__pendingDelete qu'une action IA (cf. décision du
    // 2026-07-30 : peu importe l'origine du changement). Le client (grid.js) n'envoie
    // ces messages que si session.reviewMode est actif côté init.
    case 'review:proposeInsert': {
      SM.proposeInsertRow(session, msg.apres, msg.fields || {});
      sendReviewSync(session);
      break;
    }
    case 'review:proposeDelete': {
      SM.proposeDeleteRows(session, Array.isArray(msg.ids) ? msg.ids : []);
      sendReviewSync(session);
      break;
    }

    // L'utilisateur valide le résultat final et demande l'export/renvoi
    case 'session:validate': {
      // Défense en profondeur : le bouton est déjà masqué côté UI tant qu'il reste du
      // pending (mode revue), mais on refuse aussi côté serveur au cas où.
      if (session.reviewMode && SM.countPendingRows(session) > 0) {
        wsSend(session, { type: 'error', message: '⚠ Il reste des modifications en attente de validation — résous-les avant de valider et exporter.' });
        break;
      }
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
      wsSend(session, { type: 'init', sessionId: session.sessionId, contextName: session.contextName, origin: session.origin, modeleIA: session.ia?.model || null, workerConfig: session.effectiveWorkerConfig, rows: session.rows, infosParent: session.data.infosParent, modes: session.modes || {}, selectChoix: session.selectChoix || {}, champsRestreints: session.champsRestreints || {}, champsNonApplicables: session.champsNonApplicables || {}, reviewMode: !!session.reviewMode, pendingCount: 0 });
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

    // Déplacement manuel d'un bloc de lignes (boutons ▲/▼/"Déplacer ici") — disponible
    // en mode direct ET en mode revue : réordonner n'est pas un contenu à valider (cf.
    // SM.moveRows, pas de marqueur __pending posé). Bloqué si l'IA travaille : un
    // réordonnancement pendant un run 'act' en cours corromprait les rowIndex que
    // onCellUpdate envoie de façon incrémentale (cf. server.js case 'prompt:send').
    case 'rows:move': {
      if ([SM.STATUS.PLANNING, SM.STATUS.ACTING, SM.STATUS.DELIVERING].includes(session.status)) {
        wsSend(session, { type: 'error', message: '⚠ Déplacement impossible pendant que l\'IA travaille.' });
        break;
      }
      const ids = Array.isArray(msg.ids) ? msg.ids : [];
      const moved = SM.moveRows(session, ids, msg.apres);
      if (moved) {
        wsSend(session, { type: 'rows:moved', rows: session.rows, pendingCount: SM.countPendingRows(session) });
        revalidateAllRows(session);
      }
      break;
    }

    // Nouvelle tâche : vide l'historique et le plan, garde les données modifiées
    case 'session:newtask': {
      session.history = [];
      session.currentPlan = null;
      SM.setStatus(session, SM.STATUS.CONNECTED);
      wsSend(session, { type: 'session:newtask' });
      console.log(`[WS] Nouvelle tâche pour ${session.sessionId} — historique vidé, données conservées`);
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

// ── Helper : notifie l'UI de l'état courant des rows après une action de revue ─
function sendReviewSync(session) {
  wsSend(session, {
    type:         'review:sync',
    rows:         session.rows,
    pendingCount: SM.countPendingRows(session),
  });
}

// ── Revalidation en masse (recalcule cell:validate pour toutes les lignes) ────
// Un rowIndex associé à un état invalide/manquant devient faux dès que l'ORDRE des
// lignes change (ex: 'rows:move') — il faut le recalculer intégralement à la position
// ACTUELLE, jamais le patcher. getInvalidFields/getMissingFields sont des règles PAR
// LIGNE (pas croisées), donc le statut de chaque ligne ne change pas en soi — seul son
// rowIndex change, d'où la nécessité de renvoyer un cell:validate frais pour chaque
// ligne encore fautive. Appelée aussi à la connexion WS (état initial).
function revalidateAllRows(session) {
  if (!Array.isArray(session.rows)) return;
  if (!session.viewHook?.getInvalidFields && !session.viewHook?.getMissingFields) return;
  session.rows.forEach((row, rowIndex) => {
    const invalidFields = session.viewHook.getInvalidFields?.(row) || [];
    const missingFields = session.viewHook.getMissingFields?.(row) || [];
    const combined = Array.from(new Set([...invalidFields, ...missingFields]));
    if (combined.length > 0) {
      wsSend(session, { type: 'cell:validate', rowIndex, invalidFields: combined, message: null });
    }
  });
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

// ── Configuration IA éditable (mode standalone) ────────────────────────────────
// Un seul fichier pour le bloc "ia" (fournisseur/clé API/modèle), au lieu de le
// dupliquer dans les 7 payloads standalone. But : ce bloc change selon qui lance le
// Worker en autonome (clé API personnelle, fournisseur préféré) — l'éditer une fois
// via /ia-config.html plutôt que dans chaque fichier de payload.
// N'affecte QUE startStandaloneMode() ci-dessous : une session pilotée par XSpro
// reçoit toujours son bloc "ia" du payload XSpro, jamais de ce fichier (cf. mémoire
// "séparation Worker/XSpro : tout par le payload" — ceci reste un réglage 100% local
// au fonctionnement autonome, aucun couplage nouveau avec XSpro).
const IA_CONFIG_FILE   = path.join(STANDALONE_DIR, 'ia-config.json');
const IA_CONFIG_CHAMPS = ['apiKey', 'endpoint', 'provider', 'model', 'timeoutMs', 'maxPromptLength'];

app.get('/api/ia-config', (req, res) => {
  if (fs.existsSync(IA_CONFIG_FILE)) {
    try {
      return res.json({ source: 'ia-config.json', ia: JSON.parse(fs.readFileSync(IA_CONFIG_FILE, 'utf-8')) });
    } catch (e) {
      return res.status(500).json({ error: `ia-config.json invalide : ${e.message}` });
    }
  }
  // Pas encore configuré → renvoyer le bloc "ia" du payload standalone par défaut,
  // comme simple point de départ pour préremplir le formulaire (rien n'est écrit ici).
  try {
    const payload = JSON.parse(fs.readFileSync(STANDALONE_FILE, 'utf-8'));
    return res.json({ source: 'payload par défaut', ia: payload.ia || {} });
  } catch (e) {
    return res.json({ source: 'aucun', ia: {} });
  }
});

app.post('/api/ia-config', (req, res) => {
  const body = req.body || {};
  const ia = {};
  for (const champ of IA_CONFIG_CHAMPS) {
    if (body[champ] !== undefined && body[champ] !== '') ia[champ] = body[champ];
  }
  if (!ia.apiKey || !ia.endpoint) {
    return res.status(400).json({ error: 'apiKey et endpoint sont requis.' });
  }
  ia.timeoutMs       = Number(ia.timeoutMs)       || 30000;
  ia.maxPromptLength = Number(ia.maxPromptLength) || 25000;
  try {
    fs.mkdirSync(STANDALONE_DIR, { recursive: true });
    fs.writeFileSync(IA_CONFIG_FILE, JSON.stringify(ia, null, 2) + '\n', 'utf-8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

  // Surcharge par la configuration IA éditable (/ia-config.html), si elle existe —
  // ne remplace que les champs qu'elle définit, le reste du payload est inchangé.
  if (fs.existsSync(IA_CONFIG_FILE)) {
    try {
      const surcharge = JSON.parse(fs.readFileSync(IA_CONFIG_FILE, 'utf-8'));
      payload.ia = { ...payload.ia, ...surcharge };
      console.log(`[Standalone] Configuration IA personnalisée appliquée (${path.basename(IA_CONFIG_FILE)})`);
    } catch (e) {
      console.warn(`[Standalone] ia-config.json invalide, ignoré : ${e.message}`);
    }
  }

  // callbackUrl forcé à null en standalone → toujours fallback Excel
  payload.callbackUrl = null;

  const session = SM.createSession(payload);

  // Identité standalone/XSpro : inconditionnelle ici — le flag CLI --standalone
  // est déjà la source de vérité pour ce chemin, indépendamment du contenu du
  // fichier payload (y compris les anciens fichiers sans clé _origin).
  session.origin = 'standalone';

  // Résolution du MANIFEST hook vue (même logique qu'en mode serveur)
  resolveEffectiveWorkerConfig(session);

  const uiUrl   = `http://localhost:${PORT}/index.html?sessionId=${session.sessionId}`;

  // Afficher le nom du fichier chargé
  const payloadFileName = path.basename(STANDALONE_FILE);
  console.log(`[Standalone] Fichier : ${payloadFileName}`);
  console.log(`[Standalone] Configuration IA : http://localhost:${PORT}/ia-config.html`);

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
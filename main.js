/**
 * AI Worker — main.js
 * Point d'entrée Electron.
 * Aucune fenêtre — uniquement une icône dans la barre système (tray).
 * Lance server.js en child_process et expose un menu contextuel.
 *
 * Usage :
 *   electron .                        → mode serveur
 *   electron . --standalone           → mode standalone
 *   electron . --port 8888            → port personnalisé
 */

'use strict';

const { app, Tray, Menu, nativeImage } = require('electron');
const { spawn }                          = require('child_process');
const path                               = require('path');
const fs                                 = require('fs');
const http                               = require('http');

// ── Variables globales ─────────────────────────────────────────────────────────
let tray           = null;
let serverProc     = null;
let serverPort     = 8888;
let isStandalone   = false;
let currentPayload = null; // Chemin du fichier standalone actif (null = par défaut)
let externallyManagedServer = false; // true si on s'est attaché à un serveur déjà lancé

// ── Résolution des chemins ────────────────────────────────────────────────────
const ROOT           = __dirname;
const ICON_PATH      = path.join(ROOT, 'build', 'icon.png');
const SERVER_JS      = path.join(ROOT, 'server.js');
const CONFIG_FILE    = path.join(ROOT, 'worker-config.json');
const STANDALONE_DIR = path.join(ROOT, 'standalone');

// ── Récupération de la liste des fichiers standalone disponibles ───────────────
function getStandaloneFiles() {
  try {
    const files = fs.readdirSync(STANDALONE_DIR)
      .filter(f => f.startsWith('standalone-payload') && f.endsWith('.json'))
      .sort();
    return files;
  } catch (_) {
    return [];
  }
}

// Chemin du fichier standalone par défaut
function getDefaultPayloadPath() {
  return path.join(STANDALONE_DIR, 'standalone-payload.json');
}

// Nom lisible du payload (ex: "detailsDevis" ou "par défaut")
function getPayloadDisplayName() {
  if (!currentPayload) return 'par défaut';
  const basename = path.basename(currentPayload);
  // standalone-payload-detailsDevis.json → detailsDevis
  return basename.replace('standalone-payload-', '').replace('.json', '') || 'par défaut';
}

// ── Protection anti-double-instance (évite un 2e tray dans la barre Windows) ───
// Si une autre instance de l'app Electron tourne déjà, on ne crée pas de 2e tray :
// on quitte immédiatement. L'instance déjà active reçoit 'second-instance'.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  console.log('[Electron] Instance déjà active — nouvelle instance ignorée (pas de 2e tray).');
  app.quit();
} else {
  app.on('second-instance', () => {
    // Une 2e instance a été lancée puis s'est auto-fermée. L'instance courante
    // (la seule visible) reçoit cet événement — aucune action nécessaire.
    console.log('[Electron] Tentative de 2e lancement ignorée (instance unique).');
  });
}

// ── Détection du port depuis worker-config.json ────────────────────────────────
function detectPort() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (raw.port) return raw.port;
    }
  } catch (_) { /* ignore */ }
  return 8888;
}

// ── Vérification si un PID existe encore sur le système ───────────────────────
function isProcessAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ── Probe HTTP : vérifie si un serveur répond déjà sur le port ────────────────
function checkServerRunning(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/view-config/`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

// ── Démarrage du serveur Node.js ──────────────────────────────────────────────
async function startServer() {
  if (serverProc) return; // déjà lancé

  // Vérifier si un serveur répond déjà sur ce port (ex: orphelin d'un crash précédent)
  const alreadyRunning = await checkServerRunning(serverPort);
  if (alreadyRunning) {
    console.log('────────────────────────────────────────────');
    console.log(`ℹ️  Un serveur répond déjà sur le port ${serverPort}.`);
    console.log(`    L'instance Electron se raccroche à ce serveur existant.`);
    console.log('────────────────────────────────────────────');
    externallyManagedServer = true;
    updateTrayTooltip();
    return;
  }

  // Nettoyer un éventuel verrou obsolète (PID plus valide)
  if (!alreadyRunning) {
    const lockFile = path.join(ROOT, '.worker.lock');
    if (fs.existsSync(lockFile)) {
      try {
        const lockPid = parseInt(fs.readFileSync(lockFile, 'utf-8').trim(), 10);
        if (lockPid && !isProcessAlive(lockPid)) {
          fs.unlinkSync(lockFile);
          console.log(`[Electron] Verrou obsolète (PID ${lockPid}) nettoyé.`);
        }
      } catch (_) { /* ignore */ }
    }
  }

  const args = [];
  if (isStandalone) {
    args.push('--standalone');
    // Si un payload spécifique est défini (via menu ou argument CLI)
    if (currentPayload) {
      args.push(`--payload=${currentPayload}`);
    } else {
      // Fallback dessus l'argument CLI
      const payloadArg = process.argv.find(arg => arg.startsWith('--payload='));
      if (payloadArg) args.push(payloadArg);
    }
  }

  console.log(`[Electron] Lancement : node server.js ${args.join(' ')}`);

  serverProc = spawn(process.execPath, [SERVER_JS, ...args], {
    cwd:   ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProc.stdout.on('data', (data) => {
    console.log(data.toString().trim());
  });

  serverProc.stderr.on('data', (data) => {
    console.error(`[server:err] ${data.toString().trim()}`);
  });

  serverProc.on('error', (err) => {
    console.error(`[Electron] Erreur démarrage serveur :`, err.message);
  });

  serverProc.on('exit', (code, signal) => {
    console.log(`[Electron] Serveur arrêté (code=${code}, signal=${signal})`);
    serverProc = null;
    // Quitter Electron si le serveur crash
    if (code !== 0 && signal === null) {
      app.quit();
    }
  });
}

// ── Arrêt du serveur Node.js (asynchrone — attend la mort du processus) ──────
function stopServer() {
  return new Promise((resolve) => {
    // Serveur externe (non géré par ce process) : on ne fait rien
    if (externallyManagedServer) {
      externallyManagedServer = false;
      return resolve();
    }

    if (!serverProc) return resolve();

    console.log('[Electron] Arrêt du serveur...');

    let forceKillTimer = null;
    let resolved = false;

    const done = () => {
      if (resolved) return;
      resolved = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      serverProc = null;
      resolve();
    };

    // Le processus s'est arrêté tout seul
    serverProc.on('exit', done);

    forceKillTimer = setTimeout(() => {
      if (serverProc) {
        serverProc.kill('SIGKILL');
        // SIGKILL est immédiat, l'event 'exit' va se déclencher
      } else {
        done();
      }
    }, 3000);

    // Envoyer SIGTERM pour débuter l'arrêt
    serverProc.kill('SIGTERM');

    // Timeout de sécurité au cas où exit ne se déclencherait jamais
    setTimeout(() => {
      if (!resolved) {
        serverProc = null;
        resolve();
      }
    }, 5000).unref();
  });
}

// ── Redémarrage en mode standalone avec payload spécifique ───────────────────────
async function restartStandaloneWithPayload(payloadPath) {
  await stopServer();
  currentPayload = payloadPath;
  isStandalone = true;
  await startServer();
  tray.setContextMenu(buildContextMenu());
  updateTrayTooltip();
}

// ── Redémarrage en mode standalone ────────────────────────────────────────────
async function restartStandalone() {
  await stopServer();
  currentPayload = null; // Reset au défaut
  isStandalone = true;
  await startServer();
  tray.setContextMenu(buildContextMenu());
  updateTrayTooltip();
}

// ── Redémarrage en mode serveur ───────────────────────────────────────────────
async function restartServer() {
  await stopServer();
  currentPayload = null; // Reset
  isStandalone = false;
  await startServer();
  tray.setContextMenu(buildContextMenu());
  updateTrayTooltip();
}

// ── Mise à jour du tooltip du tray ────────────────────────────────────────────
function updateTrayTooltip() {
  if (!tray) return;
  const mode = isStandalone ? 'STANDALONE' : 'SERVEUR';
  const payloadName = isStandalone ? ` (${getPayloadDisplayName()})` : '';
  tray.setToolTip(`AI Worker — port ${serverPort} (${mode}${payloadName})`);
}

// ── Construction du menu contextuel ───────────────────────────────────────────
function buildContextMenu() {
  const standaloneFiles = getStandaloneFiles();
  const defaultPath = getDefaultPayloadPath();

  // Si on est en mode standalone, proposer les options de fichiers
  if (isStandalone) {
    const payloadMenuItems = standaloneFiles.map(file => {
      const fullPath = path.join(STANDALONE_DIR, file);
      const isActive = currentPayload === fullPath || (!currentPayload && file === 'standalone-payload.json');
      const displayName = file.replace('standalone-payload-', '').replace('.json', '') || 'par défaut';
      
      return {
        label: isActive 
          ? `✓ ${displayName}` 
          : `  ${displayName}`,
        click: () => {
          restartStandaloneWithPayload(fullPath);
        },
      };
    });

    return Menu.buildFromTemplate([
      {
        label: '🔁 Basculer en mode Serveur',
        click: () => {
          restartServer();
        },
      },
      { type: 'separator' },
      {
        label: '📁 Standalone',
        submenu: payloadMenuItems,
      },
      {
        label: '📝 Éditer la config standalone',
        click: () => {
          const { shell } = require('electron');
          const targetPath = currentPayload || defaultPath;
          shell.openPath(targetPath);
        },
      },
      {
        label: '📂 Dossier contenant',
        click: () => {
          const { shell } = require('electron');
          const targetPath = currentPayload || defaultPath;
          shell.showItemInFolder(targetPath);
        },
      },
      { type: 'separator' },
      {
        label: '❌ Quitter',
        click: () => { app.quit(); },
      },
    ]);
  }

  // Mode serveur : menu classique avec option pour choisir le standalone
  return Menu.buildFromTemplate([
    {
      label: '🚀 Basculer en mode Standalone',
      click: () => {
        restartStandalone();
      },
    },
    { type: 'separator' },
    {
      label: '📁 Choisir un fichier standalone',
      submenu: [
        ...standaloneFiles.map(file => {
          const fullPath = path.join(STANDALONE_DIR, file);
          const displayName = file.replace('standalone-payload-', '').replace('.json', '') || 'par défaut';
          
          return {
            label: displayName,
            click: () => {
              currentPayload = fullPath;
              restartStandaloneWithPayload(fullPath);
            },
          };
        }),
        { type: 'separator' },
        {
          label: 'Utiliser par défaut (standalone-payload.json)',
          click: () => {
            currentPayload = null;
            restartStandalone();
          },
        },
      ],
    },
    {
      label: '📝 Éditer la config standalone',
      click: () => {
        const { shell } = require('electron');
        shell.openPath(defaultPath);
      },
    },
    {
      label: '📂 Dossier contenant',
      click: () => {
        const { shell } = require('electron');
        shell.showItemInFolder(defaultPath);
      },
    },
    { type: 'separator' },
    {
      label: '❌ Quitter',
      click: () => { app.quit(); },
    },
  ]);
}

// ── Création de l'icône tray ─────────────────────────────────────────────────
function createTray() {
  let icon;
  if (fs.existsSync(ICON_PATH)) {
    icon = nativeImage.createFromPath(ICON_PATH);
    // Redimensionner pour le tray (16x16 à 22x22 selon l'OS)
    icon = icon.resize({ width: 22, height: 22 });
  } else {
    // Icône par défaut (carré blanc minimal)
    const size = 22;
    const canvas = Buffer.alloc(size * size * 4, 0);
    // Remplir de bleu-gris pour être visible en tray
    for (let i = 0; i < size * size; i++) {
      const px = i * 4;
      canvas[px]     = 70;   // R
      canvas[px + 1] = 130;  // G
      canvas[px + 2] = 180;  // B
      canvas[px + 3] = 255;  // A
    }
    icon = nativeImage.createFromBuffer(canvas, { width: size, height: size });
  }

  tray = new Tray(icon);
  tray.setToolTip('AI Worker — démarrage...');
  tray.setContextMenu(buildContextMenu());
}

// ── Application Electron ─────────────────────────────────────────────────────
app.on('ready', async () => {
  // Lire les arguments
  isStandalone = process.argv.includes('--standalone');

  // Détecter le payload depuis l'argument CLI
  const payloadArg = process.argv.find(arg => arg.startsWith('--payload='));
  if (payloadArg) {
    currentPayload = payloadArg.replace('--payload=', '');
  }

  // Port personnalisé via --port NNNN
  const portIdx = process.argv.indexOf('--port');
  if (portIdx !== -1 && portIdx < process.argv.length - 1) {
    serverPort = parseInt(process.argv[portIdx + 1], 10) || detectPort();
  } else {
    serverPort = detectPort();
  }

  // Créer le tray
  createTray();

  // Démarrer le serveur (maintenant async — probe HTTP en amont)
  await startServer();
  updateTrayTooltip();

  if (externallyManagedServer) {
    console.log(`[Electron] Raccroché au serveur existant → http://localhost:${serverPort}`);
  } else {
    console.log(`[Electron] AI Worker pret - tray dans la barre systeme`);
    console.log(`[Electron] UI : http://localhost:${serverPort}/index.html`);
  }
});

app.on('before-quit', () => {
  if (!externallyManagedServer) {
    stopServer();
  } else {
    console.log('[Electron] Serveur externe non géré — pas d\'arrêt.');
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

// Évite de quitter quand toutes les fenêtres sont fermées (on n'en a pas)
app.on('window-all-closed', (e) => {
  e.preventDefault();
});

// macOS : ne pas quitter au clic sur le dock
app.on('activate', () => {
  // rien à faire — pas de fenêtre
});
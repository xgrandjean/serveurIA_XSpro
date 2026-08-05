/**
 * Copie les assets statiques (public/, views/, worker-config.json, standalone/)
 * vers XSpro/assets/model/serveurIA-data/, à côté de l'exécutable compilé
 * serveurIA.exe. Ces fichiers ne sont pas embarqués dans le binaire pkg :
 * ils sont lus directement sur disque via AI_WORKER_ASSETS_DIR (cf. server.js).
 *
 * Usage : node scripts/copy-assets-for-xspro.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEST = path.join(ROOT, '..', 'XSpro', 'assets', 'model', 'serveurIA-data');

const ITEMS = ['public', 'views', 'standalone', 'worker-config.json'];

fs.mkdirSync(DEST, { recursive: true });

for (const item of ITEMS) {
  const src = path.join(ROOT, item);
  const dest = path.join(DEST, item);
  if (!fs.existsSync(src)) {
    console.warn(`[copy-assets] introuvable, ignoré : ${item}`);
    continue;
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log(`[copy-assets] copié : ${item}`);
}

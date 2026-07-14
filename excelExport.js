/**
 * AI Worker — excelExport.js
 * Génère un fichier .xlsx à partir des rows finaux de la session.
 *
 * Flux :
 *   1. Construire le classeur (ExcelJS) avec mise en forme
 *   2. Sauvegarder dans exports/
 *   3. Notifier l'UI via WebSocket → bouton de téléchargement
 *   4. Servir le fichier via GET /exports/:filename (dans server.js)
 *
 * Dépendance : npm install exceljs
 */

'use strict';

const path = require('path');
const fs   = require('fs');
let ExcelJS;
try {
  ExcelJS = require('exceljs');
} catch {
  ExcelJS = null;
}

// ── Dossier de sortie ─────────────────────────────────────────────────────────
const EXPORTS_DIR = path.join(__dirname, 'exports');
if (!fs.existsSync(EXPORTS_DIR)) {
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
}

// ── Couleurs et styles ────────────────────────────────────────────────────────
const STYLE = {
  headerBg:     'FF1E3A5F',  // bleu marine
  headerFont:   'FFFFFFFF',  // blanc
  sourceBg:     'FFF0F4FA',  // bleu très clair (colonnes source)
  targetBg:     'FFFFF8E8',  // jaune très clair (colonnes IA)
  chapterBg:    'FFE8EFF8',  // bleu pâle (lignes chapitre niveauListe=1)
  chapterFont:  'FF1E3A5F',  // bleu marine pour texte chapitre
  borderColor:  'FFCCCCCC',
};

// ── Conversion valeur pour export ───────────────────────────────────────────────
/**
 * Convertit une valeur selon la configuration exportFormat.
 * Si convert: 'label' et que la valeur est un indice numérique,
 * renvoie le libellé correspondant depuis la table labels.
 */
function convertValueForExport(value, col, exportFormat) {
  const fmt = exportFormat?.[col.cle];
  if (!fmt) return value;
  
  if (fmt.convert === 'label' && fmt.labels && typeof value === 'number') {
    return fmt.labels[value] ?? value;
  }
  return value;
}

/**
 * Formate les arrays ou strings avec <br> pour l'export texte.
 * Array → string multiligne séparé par \n
 * String avec <br> → sauts de ligne
 */
function formatArrayForExport(value) {
  if (Array.isArray(value)) return value.join('\n');
  if (typeof value === 'string') return value.replace(/<br\s*\/?>/gi, '\n');
  return value;
}

// ── Point d'entrée principal ──────────────────────────────────────────────────
/**
 * @param {Object} session    — session complète (via SM)
 * @param {Array}  finalRows  — rows finaux à exporter (snapshot)
 * @param {Object} exportFormat — configuration de conversion depuis viewHook.MANIFEST
 * @returns {string}          — chemin du fichier généré
 */
async function exportSession(session, finalRows, exportFormat = {}) {
  if (!ExcelJS) {
    throw new Error('ExcelJS non installé — lance : npm install exceljs');
  }

  const { workerConfig, contextName, sessionId } = session;
  const exportConfig = workerConfig.export || {};

  // ── Colonnes à exporter (dans l'ordre défini) ──────────────────────────────
  const colonnesExport = resolveExportColumns(workerConfig);

  // ── Nom du fichier ─────────────────────────────────────────────────────────
  const timestamp  = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const baseName   = exportConfig.nomFichier || `${contextName}_export`;
  const fileName   = `${baseName}_${timestamp}.xlsx`;
  const filePath   = path.join(EXPORTS_DIR, fileName);

  // ── Construction du classeur ───────────────────────────────────────────────
  const workbook  = new ExcelJS.Workbook();
  workbook.creator  = 'AI Worker';
  workbook.created  = new Date();

  const sheetName = exportConfig.nomOnglet || contextName || 'Résultat IA';
  const sheet     = workbook.addWorksheet(sheetName, {
    views: [{ state: 'frozen', ySplit: 1 }], // ligne d'en-tête figée
  });

  // ── Définition des colonnes AG Grid → colonnes ExcelJS ────────────────────
  sheet.columns = colonnesExport.map(col => ({
    header: col.cle,
    key:    col.cle,
    width:  Math.max(10, Math.round((col.width || 120) / 7)), // px → chars approx
  }));

  // ── Style de l'en-tête ────────────────────────────────────────────────────
  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell, colNum) => {
    const col = colonnesExport[colNum - 1];
    cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: STYLE.headerBg } };
    cell.font  = { bold: true, color: { argb: STYLE.headerFont }, size: 10 };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: false };
    cell.border = makeBorder();
  });
  headerRow.height = 22;

  // ── Ajout des lignes de données ───────────────────────────────────────────
  // exportFormat provient du MANIFEST du viewHook (conversion indices→labels)
  const ef = exportFormat || {};
  
  for (const row of finalRows) {
    const rowData = {};
    for (const col of colonnesExport) {
      let v = row[col.cle];
      
      // 1. Conversion selon exportFormat (indices → labels)
      v = convertValueForExport(v, col, ef);
      
      // 2. Formatage des arrays/choix (choix, choixCorrect) en texte multiligne
      if (['choix', 'choixCorrect'].includes(col.cle)) {
        v = formatArrayForExport(v);
      }
      
      // 3. Arrondi si demandé
      if (col.round && typeof v === 'number') {
        v = parseFloat(v.toFixed(col.round));
      }
      rowData[col.cle] = v ?? '';
    }

    const excelRow = sheet.addRow(rowData);

    // Style selon le niveau hiérarchique (niveauListe)
    const niveau = row['niveauListe'];
    if (niveau === 1 || niveau === 0) {
      // Chapitre : fond coloré + gras
      excelRow.eachCell({ includeEmpty: true }, cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STYLE.chapterBg } };
        cell.font = { bold: true, color: { argb: STYLE.chapterFont }, size: 10 };
        cell.border = makeBorder();
      });
    } else {
      // Ligne normale : distinguer colonnes source et colonnes IA
      excelRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
        const col = colonnesExport[colNum - 1];
        if (col) {
          cell.fill = {
            type: 'pattern', pattern: 'solid',
            fgColor: { argb: col.source ? STYLE.sourceBg : STYLE.targetBg },
          };
        }
        cell.font   = { size: 10 };
        cell.border = makeBorder();
      });
    }

    // Formatage numérique
    colonnesExport.forEach((col, i) => {
      if (col.type === 'decimal' || col.type === 'number') {
        const cell = excelRow.getCell(i + 1);
        cell.numFmt = col.round === 2 ? '#,##0.00' : '#,##0.###';
        cell.alignment = { horizontal: 'right' };
      }
      if (col.type === 'integer') {
        const cell = excelRow.getCell(i + 1);
        cell.numFmt = '0';
        cell.alignment = { horizontal: 'center' };
      }
    });

    excelRow.height = 18;
  }

  // ── Filtres automatiques sur l'en-tête ───────────────────────────────────
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to:   { row: 1, column: colonnesExport.length },
  };

  // ── Onglet d'infos session (métadonnées) ──────────────────────────────────
  const infoSheet = workbook.addWorksheet('_info', {
    state: 'veryHidden', // caché, mais accessible si besoin
  });
  infoSheet.addRow(['Clé', 'Valeur']);
  infoSheet.addRow(['sessionId',   sessionId]);
  infoSheet.addRow(['contextName', contextName]);
  infoSheet.addRow(['exportDate',  new Date().toISOString()]);
  infoSheet.addRow(['lignes',      finalRows.length]);
  if (session.data?.infosParent) {
    for (const [k, v] of Object.entries(session.data.infosParent)) {
      infoSheet.addRow([k, v]);
    }
  }

  // ── Sauvegarde ────────────────────────────────────────────────────────────
  await workbook.xlsx.writeFile(filePath);
  // console.log(`[Export] Fichier généré : ${filePath}`);

  // ── Notification UI via WebSocket ─────────────────────────────────────────
  notifyUI(session, fileName, finalRows.length);

  return filePath;
}

// ── Résolution des colonnes à exporter ───────────────────────────────────────
/**
 * Priorité :
 *   1. workerConfig.export.colonnesExport (liste de clés ordonnée)
 *   2. Toutes les colonnes non readOnly
 */
function resolveExportColumns(workerConfig) {
  const allCols     = workerConfig.colonnes || [];
  const exportKeys  = workerConfig.export?.colonnesExport;

  if (exportKeys?.length) {
    return exportKeys
      .map(cle => allCols.find(c => c.cle === cle))
      .filter(Boolean);
  }

  // Par défaut : toutes sauf celles explicitement readOnly sans aiTarget
  return allCols.filter(c => !c.readOnly || c.aiTarget);
}

// ── Notification WebSocket ────────────────────────────────────────────────────
function notifyUI(session, fileName, rowCount) {
  if (!session.ws || session.ws.readyState !== 1) return;

  session.ws.send(JSON.stringify({
    type:      'export:ready',
    fileName,
    downloadUrl: `/exports/${encodeURIComponent(fileName)}`,
    rowCount,
    message: `Fichier prêt : ${fileName} (${rowCount} lignes)`,
  }));
}

// ── Ouverture du fichier avec l'application OS par défaut ────────────────────
async function openFile(filePath) {
  try {
    const { default: open } = await import('open');
    await open(filePath);
    // console.log(`[Export] Fichier ouvert automatiquement`);
  } catch (e) {
    console.warn(`[Export] Impossible d'ouvrir le fichier automatiquement : ${e.message}`);
  }
}

// ── Helper : bordure standard ─────────────────────────────────────────────────
function makeBorder() {
  const side = { style: 'thin', color: { argb: STYLE.borderColor } };
  return { top: side, left: side, bottom: side, right: side };
}

// ── Nettoyage des exports anciens (optionnel, appelable manuellement) ─────────
/**
 * Supprime les fichiers .xlsx de plus de maxAgeDays jours dans exports/.
 * @param {number} maxAgeDays  — défaut 7 jours
 */
function cleanOldExports(maxAgeDays = 7) {
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const now      = Date.now();
  let   count    = 0;

  try {
    const files = fs.readdirSync(EXPORTS_DIR);
    for (const file of files) {
      if (!file.endsWith('.xlsx')) continue;
      const filePath = path.join(EXPORTS_DIR, file);
      const stat     = fs.statSync(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(filePath);
        count++;
      }
    }
    if (count > 0) console.log(`[Export] ${count} fichier(s) anciens supprimés`);
  } catch (e) {
    console.warn(`[Export] Erreur nettoyage : ${e.message}`);
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = { exportSession, cleanOldExports, EXPORTS_DIR };

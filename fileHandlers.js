/**
 * AI Worker — fileHandlers.js
 * Fonctions de traitement des fichiers joints avant envoi au LLM.
 *
 * Chaque handler reçoit :
 *   file       — { name, mimeType, data (base64 pur), size }
 *   providerId — ex: "claude" | "albert" | "openai" ...
 *
 * Chaque handler retourne un tableau de blocs de contenu
 * compatibles avec le format messages[] de l'API cible.
 *
 * Format de bloc :
 *   { type: 'text',       text: '...' }
 *   { type: 'image_url',  image_url: { url: 'data:...' } }
 *   { type: 'document',   source: { type: 'base64', media_type, data } }
 */

'use strict';

let pdfParse;
try {
  pdfParse = require('pdf-parse');
} catch {
  pdfParse = null; // pdf-parse non installé — extract_text désactivé
}

// ── HANDLERS NATIFS ───────────────────────────────────────────────────────────

/**
 * buildNativeDocument — PDF natif pour Claude et Gemini.
 *
 * Claude  : bloc "document" Anthropic (type: 'document')
 * Gemini  : bloc "image_url" avec data URL (format OpenAI-compat Gemini)
 */
async function buildNativeDocument(file, providerId) {
  const { name, mimeType, data, size } = file;
  const blocks = [];

  if (providerId === 'claude') {
    // Format natif Anthropic
    blocks.push({
      type:   'document',
      source: { type: 'base64', media_type: mimeType || 'application/pdf', data },
    });
  } else if (providerId === 'gemini') {
    // Gemini OpenAI-compat accepte les PDFs via image_url (inline base64)
    blocks.push({
      type:      'image_url',
      image_url: { url: `data:${mimeType};base64,${data}` },
    });
  }

  // Note contextuelle dans tous les cas
  blocks.push({
    type: 'text',
    text: `[Document joint : "${name}" — ${fmtSize(size)}]`,
  });

  return blocks;
}

/**
 * buildNativeImage — Image native pour Claude et Gemini.
 *
 * Claude  : bloc "image" Anthropic
 * Gemini  : bloc "image_url" (OpenAI-compat)
 */
async function buildNativeImage(file, providerId) {
  const { name, mimeType, data, size } = file;
  const blocks = [];

  if (providerId === 'claude') {
    blocks.push({
      type:   'image',
      source: { type: 'base64', media_type: mimeType, data },
    });
  } else {
    // Gemini OpenAI-compat + fallback
    blocks.push({
      type:      'image_url',
      image_url: { url: `data:${mimeType};base64,${data}` },
    });
  }

  blocks.push({
    type: 'text',
    text: `[Image jointe : "${name}" — ${fmtSize(size)}]`,
  });

  return blocks;
}

/**
 * buildImageUrl — Image via data URL base64 (OpenAI Vision, Mistral Vision).
 */
async function buildImageUrl(file) {
  const { name, mimeType, data, size } = file;
  return [
    {
      type:      'image_url',
      image_url: { url: `data:${mimeType};base64,${data}` },
    },
    {
      type: 'text',
      text: `[Image jointe : "${name}" — ${fmtSize(size)}]`,
    },
  ];
}

// ── HANDLERS EXTRACTION TEXTE ─────────────────────────────────────────────────

/**
 * extractPdfText — Extraction texte serveur via pdf-parse.
 * Utilisé quand le provider ne supporte pas les PDFs nativement.
 * Requiert : npm install pdf-parse
 */
async function extractPdfText(file) {
  const { name, size, data } = file;

  if (!pdfParse) {
    console.warn('[FileHandlers] pdf-parse non installé — contenu PDF non extrait');
    return [{
      type: 'text',
      text: `[PDF joint : "${name}" — ${fmtSize(size)}]\n⚠ Extraction texte indisponible (pdf-parse non installé). Lance : npm install pdf-parse`,
    }];
  }

  try {
    const buffer    = Buffer.from(data, 'base64');
    const parsed    = await pdfParse(buffer, { max: 0 }); // max:0 = toutes les pages
    const text      = parsed.text?.trim() || '';
    const pages     = parsed.numpages || '?';
    const truncated = text.length > 60000
      ? text.slice(0, 60000) + '\n… [tronqué — contenu trop long]'
      : text;

    // console.log(`[FileHandlers] PDF extrait : "${name}" — ${pages} page(s), ${text.length} chars`);

    return [{
      type: 'text',
      text: `== CONTENU PDF : "${name}" (${pages} page(s), ${fmtSize(size)}) ==\n${truncated}\n== FIN PDF ==`,
    }];

  } catch (err) {
    console.error(`[FileHandlers] Erreur extraction PDF "${name}" :`, err.message);
    return [{
      type: 'text',
      text: `[PDF joint : "${name}" — extraction échouée : ${err.message}]`,
    }];
  }
}

/**
 * buildInlineText — Injection texte brut dans le prompt.
 * Universel — fonctionne avec tous les providers.
 * Gère : .txt, .csv, .json, .md, .yaml, .sql, .log, code source...
 */
async function buildInlineText(file) {
  const { name, mimeType, data, size } = file;

  try {
    const decoded   = Buffer.from(data, 'base64').toString('utf-8');
    const truncated = decoded.length > 60000
      ? decoded.slice(0, 60000) + '\n… [tronqué]'
      : decoded;

    // Détection du langage pour annotation
    const lang = detectLang(name);
    const header = lang
      ? `== FICHIER "${name}" (${lang}, ${fmtSize(size)}) ==`
      : `== FICHIER "${name}" (${fmtSize(size)}) ==`;

    return [{
      type: 'text',
      text: `${header}\n${truncated}\n== FIN FICHIER ==`,
    }];

  } catch (err) {
    return [{
      type: 'text',
      text: `[Fichier texte : "${name}" — décodage échoué : ${err.message}]`,
    }];
  }
}

// ── STUBS FUTURS ──────────────────────────────────────────────────────────────

/**
 * extractXlsxText — Extraction texte depuis Excel.
 * Futur : npm install xlsx (SheetJS)
 */
async function extractXlsxText(file) {
  const { name, size } = file;
  // TODO: implémenter via SheetJS
  // const XLSX = require('xlsx');
  // const wb = XLSX.read(Buffer.from(file.data, 'base64'));
  // const text = wb.SheetNames.map(s => XLSX.utils.sheet_to_csv(wb.Sheets[s])).join('\n');
  return [{
    type: 'text',
    text: `[Excel joint : "${name}" — ${fmtSize(size)}]\n⚠ Extraction Excel non encore implémentée.`,
  }];
}

/**
 * extractDocxText — Extraction texte depuis Word.
 * Futur : npm install mammoth
 */
async function extractDocxText(file) {
  const { name, size } = file;
  // TODO: implémenter via mammoth
  // const mammoth = require('mammoth');
  // const result = await mammoth.extractRawText({ buffer: Buffer.from(file.data,'base64') });
  return [{
    type: 'text',
    text: `[Word joint : "${name}" — ${fmtSize(size)}]\n⚠ Extraction Word non encore implémentée.`,
  }];
}

/**
 * extractPptxText — Extraction texte depuis PowerPoint.
 * Futur.
 */
async function extractPptxText(file) {
  const { name, size } = file;
  return [{
    type: 'text',
    text: `[PowerPoint joint : "${name}" — ${fmtSize(size)}]\n⚠ Extraction PowerPoint non encore implémentée.`,
  }];
}

/**
 * transcribeAudio — Transcription audio via Whisper.
 * Futur.
 */
async function transcribeAudio(file) {
  const { name, size } = file;
  return [{
    type: 'text',
    text: `[Audio joint : "${name}" — ${fmtSize(size)}]\n⚠ Transcription audio non encore implémentée.`,
  }];
}

// ── Registre des fonctions (nom → fonction) ───────────────────────────────────
// Ce registre est utilisé par llmClient.js pour router
// handler_name → fonction réelle sans switch/if.
const HANDLER_FUNCTIONS = {
  buildNativeDocument,
  buildNativeImage,
  buildImageUrl,
  buildInlineText,
  extractPdfText,
  extractXlsxText,
  extractDocxText,
  extractPptxText,
  transcribeAudio,
};

/**
 * Exécute un handler par son nom.
 *
 * @param {string} handlerName  — ex: "extractPdfText"
 * @param {Object} file         — { name, mimeType, data, size }
 * @param {string} providerId   — ex: "albert"
 * @returns {Promise<Array>}    — tableau de blocs de contenu
 */
async function runHandler(handlerName, file, providerId) {
  const fn = HANDLER_FUNCTIONS[handlerName];

  if (!fn) {
    console.warn(`[FileHandlers] Handler inconnu : "${handlerName}"`);
    return [{
      type: 'text',
      text: `[Fichier joint : "${file.name}" — handler "${handlerName}" inconnu]`,
    }];
  }

  return fn(file, providerId);
}

// ── Utilitaires ───────────────────────────────────────────────────────────────
function fmtSize(bytes) {
  if (!bytes)           return '';
  if (bytes < 1024)     return `${bytes} o`;
  if (bytes < 1048576)  return `${(bytes / 1024).toFixed(0)} Ko`;
  return `${(bytes / 1048576).toFixed(1)} Mo`;
}

function detectLang(fileName) {
  const ext = fileName.split('.').pop()?.toLowerCase();
  const map = {
    js: 'JavaScript', ts: 'TypeScript', py: 'Python',
    java: 'Java', cs: 'C#', cpp: 'C++', c: 'C',
    sql: 'SQL', sh: 'Shell', json: 'JSON',
    yaml: 'YAML', yml: 'YAML', md: 'Markdown',
    csv: 'CSV', xml: 'XML', html: 'HTML',
  };
  return map[ext] || null;
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  HANDLER_FUNCTIONS,
  runHandler,
  // Export direct des handlers pour tests unitaires
  buildNativeDocument,
  buildNativeImage,
  buildImageUrl,
  buildInlineText,
  extractPdfText,
  extractXlsxText,
  extractDocxText,
  extractPptxText,
  transcribeAudio,
};

/**
 * AI Worker — fileTypes.js
 * Registre des types de fichiers supportés.
 *
 * Structure par type :
 *   label      — libellé affiché à l'utilisateur
 *   mimeTypes  — types MIME reconnus
 *   extensions — extensions de fichier reconnues
 *   handlers   — map nom_handler → nom_fonction dans fileHandlers.js
 *                null = non implémenté (stub futur)
 *
 * Ajout d'un nouveau type :
 *   1. Ajouter une entrée ici avec ses mimeTypes/extensions/handlers
 *   2. Implémenter la fonction dans fileHandlers.js
 *   3. Déclarer la capacité dans providers.js
 */

'use strict';

const FILE_TYPES = {

  pdf: {
    label:      'PDF',
    mimeTypes:  ['application/pdf'],
    extensions: ['.pdf'],
    handlers: {
      native_document: 'buildNativeDocument',  // Claude, Gemini — bloc document natif
      extract_text:    'extractPdfText',        // tous les autres — via pdf-parse
    },
  },

  image: {
    label:      'Image',
    mimeTypes:  ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'],
    extensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'],
    handlers: {
      native_image: 'buildNativeImage',   // Claude, Gemini — bloc image natif
      image_url:    'buildImageUrl',      // OpenAI, Mistral — data URL base64
    },
  },

  text: {
    label:      'Texte / CSV / JSON / Code',
    mimeTypes:  [
      'text/plain', 'text/csv', 'text/markdown',
      'text/html', 'text/xml',
      'application/json', 'application/xml',
      'application/x-yaml',
    ],
    extensions: [
      '.txt', '.csv', '.md', '.markdown',
      '.json', '.yaml', '.yml',
      '.log', '.sql', '.xml', '.html', '.htm',
      '.js', '.ts', '.py', '.java', '.c', '.cpp', '.cs',
      '.sh', '.bat', '.ini', '.env', '.toml',
    ],
    handlers: {
      inline_text: 'buildInlineText',   // universel — injecté dans le prompt
    },
  },

  xlsx: {
    label:      'Excel',
    mimeTypes:  [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/csv',
    ],
    extensions: ['.xlsx', '.xls'],
    handlers: {
      extract_text: 'extractXlsxText',  // futur — via sheetjs/xlsx
    },
  },

  docx: {
    label:      'Word',
    mimeTypes:  [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
    ],
    extensions: ['.docx', '.doc'],
    handlers: {
      extract_text: 'extractDocxText',  // futur — via mammoth
    },
  },

  pptx: {
    label:      'PowerPoint',
    mimeTypes:  [
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.ms-powerpoint',
    ],
    extensions: ['.pptx', '.ppt'],
    handlers: {
      extract_text: 'extractPptxText',  // futur
    },
  },

  zip: {
    label:      'Archive ZIP',
    mimeTypes:  ['application/zip', 'application/x-zip-compressed', 'application/x-zip'],
    extensions: ['.zip'],
    handlers: {},   // pas encore géré
  },

  audio: {
    label:      'Audio',
    mimeTypes:  ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/webm'],
    extensions: ['.mp3', '.wav', '.ogg', '.m4a', '.webm'],
    handlers: {
      transcribe: 'transcribeAudio',  // futur — via Whisper API
    },
  },

};

// ── Résolution du type depuis un fichier ──────────────────────────────────────
/**
 * Identifie le typeId d'un fichier par son mimeType ou son extension.
 *
 * @param {string} mimeType   — ex: "application/pdf"
 * @param {string} fileName   — ex: "document.pdf"
 * @returns {string|null}     — ex: "pdf" | null si inconnu
 */
function resolveFileType(mimeType, fileName) {
  const ext = fileName
    ? '.' + fileName.split('.').pop().toLowerCase()
    : '';

  for (const [typeId, typeDef] of Object.entries(FILE_TYPES)) {
    if (typeDef.mimeTypes.includes(mimeType))  return typeId;
    if (ext && typeDef.extensions.includes(ext)) return typeId;
  }

  // Tentative par préfixe MIME (ex: "text/x-custom" → text)
  if (mimeType.startsWith('text/'))  return 'text';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';

  return null;
}

/**
 * Retourne les extensions acceptées pour un ensemble de typeIds.
 * Utilisé pour construire l'attribut "accept" du file input.
 *
 * @param {string[]} typeIds  — ex: ['pdf', 'text']
 * @returns {string}          — ex: ".pdf,.txt,.csv,.json,..."
 */
function buildAcceptString(typeIds) {
  const extensions = new Set();
  const mimeTypes  = new Set();

  for (const typeId of typeIds) {
    const def = FILE_TYPES[typeId];
    if (!def) continue;
    def.extensions.forEach(e => extensions.add(e));
    def.mimeTypes.forEach(m => mimeTypes.add(m));
  }

  return [...extensions, ...mimeTypes].join(',');
}

/**
 * Retourne le libellé lisible pour un typeId.
 * @param {string} typeId
 * @returns {string}
 */
function getTypeLabel(typeId) {
  return FILE_TYPES[typeId]?.label || typeId;
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = { FILE_TYPES, resolveFileType, buildAcceptString, getTypeLabel };

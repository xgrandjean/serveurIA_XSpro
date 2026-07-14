/**
 * AI Worker — providers.js
 * Registre des capacités de chaque provider IA.
 *
 * Pour chaque type de fichier, indique quel handler utiliser.
 * null = non supporté par ce provider (fichier refusé à l'upload).
 *
 * Les valeurs correspondent aux clés "handlers" dans fileTypes.js.
 */

'use strict';

const PROVIDERS = {

  claude: {
    label:       'Claude (Anthropic)',
    // Détection automatique si "provider" absent du payload
    detectFrom:  ['anthropic.com'],
    capabilities: {
      pdf:   'native_document',  // bloc document natif Anthropic
      image: 'native_image',     // bloc image natif Anthropic
      text:  'inline_text',
      xlsx:  null,               // pas encore
      docx:  null,
      zip:   null,
    },
  },

  gemini: {
    label:       'Gemini (Google)',
    detectFrom:  ['generativelanguage.googleapis.com', 'aiplatform.googleapis.com'],
    capabilities: {
      pdf:   'native_document',  // inline_data base64 natif Gemini
      image: 'native_image',     // inline_data base64 natif Gemini
      text:  'inline_text',
      xlsx:  null,
      docx:  null,
      zip:   null,
    },
  },

  openai: {
    label:       'OpenAI (GPT)',
    detectFrom:  ['api.openai.com'],
    capabilities: {
      pdf:   'extract_text',     // extraction texte serveur via pdf-parse
      image: 'image_url',        // image_url base64 (vision)
      text:  'inline_text',
      xlsx:  null,
      docx:  null,
      zip:   null,
    },
  },

  mistral: {
    label:       'Mistral AI',
    detectFrom:  ['api.mistral.ai'],
    capabilities: {
      pdf:   'extract_text',
      image: 'image_url',        // vision supportée sur certains modèles Mistral
      text:  'inline_text',
      xlsx:  null,
      docx:  null,
      zip:   null,
    },
  },

  albert: {
    label:       'Albert (Etalab)',
    detectFrom:  ['albert.api.etalab.gouv.fr'],
    capabilities: {
      pdf:   'extract_text',     // extraction texte serveur
      image: null,               // non supporté
      text:  'inline_text',
      xlsx:  null,
      docx:  null,
      zip:   null,
    },
  },

};

// ── Résolution du provider ────────────────────────────────────────────────────
/**
 * Retourne la config du provider depuis ia.provider ou par détection sur ia.endpoint.
 * Fallback sur "openai" (format le plus répandu) si inconnu.
 *
 * @param {Object} ia  — { provider?, endpoint }
 * @returns {{ id: string, config: Object }}
 */
function resolveProvider(ia) {
  // 1. Clé explicite
  if (ia.provider && PROVIDERS[ia.provider]) {
    return { id: ia.provider, config: PROVIDERS[ia.provider] };
  }

  // 2. Détection par endpoint
  if (ia.endpoint) {
    for (const [id, config] of Object.entries(PROVIDERS)) {
      if (config.detectFrom?.some(domain => ia.endpoint.includes(domain))) {
        return { id, config };
      }
    }
  }

  // 3. Fallback
  console.warn(`[Providers] Provider inconnu pour endpoint "${ia.endpoint}" — fallback openai`);
  return { id: 'openai', config: PROVIDERS.openai };
}

/**
 * Retourne le handler pour un type de fichier donné et un provider.
 * null = non supporté.
 *
 * @param {string} providerId   — ex: "albert"
 * @param {string} fileTypeId   — ex: "pdf"
 * @returns {string|null}       — ex: "extract_text" | null
 */
function getHandler(providerId, fileTypeId) {
  return PROVIDERS[providerId]?.capabilities?.[fileTypeId] ?? null;
}

/**
 * Retourne la liste des types de fichiers supportés par un provider.
 * Utilisé pour construire l'attribut "accept" du file input.
 *
 * @param {string} providerId
 * @returns {string[]}  — liste des typeIds supportés (ex: ['pdf','text'])
 */
function getSupportedTypes(providerId) {
  const caps = PROVIDERS[providerId]?.capabilities || {};
  return Object.entries(caps)
    .filter(([, handler]) => handler !== null)
    .map(([typeId]) => typeId);
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = { PROVIDERS, resolveProvider, getHandler, getSupportedTypes };

/**
 * AI Worker — viewResolver.js
 *
 * Responsabilité unique : charger le hook vue, appliquer le MANIFEST,
 * et produire un `effectiveWorkerConfig` cohérent stocké dans la session.
 *
 * Consommateurs :
 *   - server.js    → appelé juste après createSession() ; envoie
 *                    effectiveWorkerConfig, modes et selectChoix à l'UI via WS init
 *   - llmClient.js → consomme session.effectiveWorkerConfig, session.viewHook,
 *                    session.modes, session.selectChoix
 *
 * Contrat MANIFEST par champ :
 *   colonnes        : array | function(workerConfig, data) => array | null
 *   regles          : object | null
 *   systemPrompt    : string | null
 *   promptsSuggeres : object | null
 *   prompt          : string | null
 *   modele          : array | null
 *   export          : object | null
 *   editionParActions : boolean | null  — active le contrat update/delete/insert par _id
 *   formatReponse   : string | null    — texte FORMAT DE RÉPONSE par défaut, hérité par les modes
 *   null = garder la valeur fournie par XSpro dans workerConfig.
 *
 * Contrat MODES (optionnel) :
 *   { [modeId]: { label, colonnesUiHidden, colonnesLlmHidden,
 *                 systemPrompt?, regles?, promptsSuggeres?, modele?, formatReponse?,
 *                 editionParActions? } }
 *   Absent ou vide = pas de sélecteur de mode dans l'UI.
 *
 * Contrat SELECT_CHOIX (optionnel) :
 *   { [cle]: { choix: [{ valeur, label }], fallback: { siCondition, alors, sinon } } }
 *   S'applique indépendamment des modes.
 */

'use strict';

const path = require('path');

// ── Chargement du hook vue ────────────────────────────────────────────────────
/**
 * Charge le module views/<viewModule>.js si déclaré dans workerConfig.
 * Invalide le cache require à chaque appel (rechargement en dev sans restart).
 *
 * @param {Object} workerConfig
 * @returns {Object|null}  — module hook vue ou null si absent/erreur
 */
function loadViewHook(workerConfig) {
  const viewModule = workerConfig?.viewModule;
  if (!viewModule) return null;

  try {
    const hookPath = path.join(__dirname, 'views', `${viewModule}.js`);
    delete require.cache[require.resolve(hookPath)];
    const hook = require(hookPath);
    console.log(`[ViewResolver] Hook vue chargé : views/${viewModule}.js`);
    return hook;
  } catch (e) {
    console.warn(`[ViewResolver] Hook vue "${viewModule}" introuvable : ${e.message}`);
    return null;
  }
}

// ── Résolution des colonnes effectives ───────────────────────────────────────
/**
 * Résout MANIFEST.colonnes → array effectif.
 * Cas : null → XSpro | array → tel quel | function(workerConfig, data) → résultat
 * Fallback sur workerConfig.colonnes dans tous les cas d'erreur.
 */
function resolveColonnes(mfColonnes, workerConfig, data) {
  if (mfColonnes === null || mfColonnes === undefined) {
    return workerConfig.colonnes || [];
  }

  if (typeof mfColonnes === 'function') {
    try {
      const result = mfColonnes(workerConfig, data);
      if (result === null || result === undefined) return workerConfig.colonnes || [];
      if (!Array.isArray(result)) {
        console.warn('[ViewResolver] MANIFEST.colonnes() n\'a pas retourné un array — fallback XSpro');
        return workerConfig.colonnes || [];
      }
      return result;
    } catch (e) {
      console.warn(`[ViewResolver] Erreur dans MANIFEST.colonnes() : ${e.message} — fallback XSpro`);
      return workerConfig.colonnes || [];
    }
  }

  if (Array.isArray(mfColonnes)) return mfColonnes;

  console.warn('[ViewResolver] MANIFEST.colonnes : type inattendu — fallback XSpro');
  return workerConfig.colonnes || [];
}

/**
 * Résolution déclarative des colonnes via surchargesColonnes.
 *
 * L'ordre des colonnes suit workerConfig.export.colonnesExport.
 * Chaque champ de colonnesExport est cherché dans workerConfig.colonnes.
 * - Si trouvé : on applique les surcharges définies dans surchargesColonnes[champ]
 * - Si absent  : on génère une définition minimale { champ, cle: champ, libelle: champ }
 *               puis on applique les surcharges
 *
 * @param {Object} surchargesColonnes  — { [champ]: { propriete: valeur, ... } }
 * @param {Object} workerConfig
 * @returns {Array} colonnes résolues
 */
function resolveColonnesDeclaratif(surchargesColonnes, workerConfig) {
  const colonnesSource = workerConfig.colonnes || [];
  const colonnesExport = workerConfig.export?.colonnesExport || [];

  // Si pas de colonnesExport, garder l'ordre source + appliquer surcharges
  if (!colonnesExport.length) {
    return colonnesSource.map(col => {
      const s = surchargesColonnes[col.champ];
      return s ? { ...col, ...s } : col;
    });
  }

  const sourceByChamp = new Map(colonnesSource.map(c => [c.champ, c]));

  return colonnesExport.map(champ => {
    const col = sourceByChamp.get(champ);
    const s   = surchargesColonnes[champ] || {};

    if (col) {
      // Colonne existante + surcharges
      const result = { ...col, ...s };
      // Nettoyer les clés vides (pour ne pas écraser avec undefined)
      for (const k of Object.keys(s)) {
        if (s[k] === undefined) delete result[k];
      }
      return result;
    }

    // Colonne absente → génération automatique
    console.warn(`[ViewResolver] Colonne "${champ}" dans colonnesExport mais absente de workerConfig.colonnes — génération automatique`);
    const fallback = { champ, cle: champ, libelle: champ, ...s };
    for (const k of Object.keys(s)) {
      if (s[k] === undefined) delete fallback[k];
    }
    return fallback;
  });
}

// ── Résolution des champs scalaires du MANIFEST ──────────────────────────────
/**
 * Résout un champ simple (regles, systemPrompt, modele, export) :
 * null/undefined = "pas de surcharge" → garde la valeur XSpro.
 * Toute autre valeur (string, object, array) = surcharge.
 *
 * Pour promptsSuggeres et prompt on conserve `??` (comportement historique).
 * (?? traite null comme nullish, null = pas de surcharge → garde XSpro)
 */
function resolveManifestField(mfValue, xsproValue) {
  if (mfValue === null || mfValue === undefined) return xsproValue;
  return mfValue;
}

// ── Point d'entrée principal ──────────────────────────────────────────────────
/**
 * Charge le hook vue, fusionne le MANIFEST, expose MODES et SELECT_CHOIX.
 * Doit être appelé une seule fois juste après createSession().
 *
 * Stocke sur la session :
 *   session.effectiveWorkerConfig — workerConfig fusionné avec MANIFEST
 *   session.viewHook              — module hook vue (pour les hooks postProcess*)
 *   session.modes                 — MODES du hook vue (ou {} si absent)
 *   session.selectChoix           — SELECT_CHOIX du hook vue (ou {} si absent)
 *
 * @param {Object} session  — session créée par sessionManager
 */
function resolveEffectiveWorkerConfig(session) {
  const { workerConfig, data } = session;

  const viewHook = loadViewHook(workerConfig);
  const mf       = viewHook?.MANIFEST || {};

  // Fusion MANIFEST → effectiveWorkerConfig
  // Si surchargesColonnes est défini → mode déclaratif (prioritaire)
  // Sinon → mode classique (fonction/array/null)
  const effectiveColonnes = mf.surchargesColonnes
    ? resolveColonnesDeclaratif(mf.surchargesColonnes, workerConfig)
    : resolveColonnes(mf.colonnes, workerConfig, data);
  const effectiveRegles       = resolveManifestField(mf.regles,          workerConfig.regles);
  const effectiveSystemPrompt = resolveManifestField(mf.systemPrompt,    workerConfig.systemPrompt);
  const effectivePromptsSugg  = mf.promptsSuggeres ?? workerConfig.promptsSuggeres;
  const effectivePrompt       = mf.prompt          ?? workerConfig.prompt;
  const effectiveModele       = resolveManifestField(mf.modele,          workerConfig.modele);
  const effectiveExport       = resolveManifestField(mf.export,          workerConfig.export);
  // editionParActions : active le contrat update/delete/insert par _id (llmClient.js
  // applyRowActions) au lieu du contrat historique positionnel (parseAndMergeRows).
  // Opt-in par vue ; peut aussi être surchargé par mode (session.modes[id].editionParActions).
  const effectiveEditionParActions = mf.editionParActions ?? workerConfig.editionParActions ?? false;
  // formatReponse : texte "FORMAT DE RÉPONSE" par défaut pour la vue (hérité par les modes
  // qui n'en définissent pas de spécifique) ; sinon fallback générique dans buildSystemPrompt.
  const effectiveFormatReponse = resolveManifestField(mf.formatReponse, workerConfig.formatReponse);

  session.effectiveWorkerConfig = {
    ...workerConfig,
    colonnes:        effectiveColonnes,
    regles:          effectiveRegles,
    systemPrompt:    effectiveSystemPrompt,
    promptsSuggeres: effectivePromptsSugg,
    prompt:          effectivePrompt,
    modele:          effectiveModele,
    export:          effectiveExport,
    editionParActions: effectiveEditionParActions,
    formatReponse:     effectiveFormatReponse,
    champsMultiligne: mf.champsMultiligne ?? workerConfig.champsMultiligne ?? [],
    champsArray:     mf.champsArray ?? workerConfig.champsArray ?? [],
  };

  // Hook vue, modes et selectChoix exposés sur la session
   session.viewHook    = viewHook;
   session.modes       = viewHook?.MODES        || {};
   session.rowStyles   = mf.rowStyles || null;
   
   // Export format depuis le MANIFEST (pour conversion indices→labels dans excelExport)
   session.exportFormat = mf.exportFormat || {};

   // Colonnes dérivées (calculées côté client) — extraites du mode actif
   session.colonnesDerivees = {};
   const modes = viewHook?.MODES || {};
   for (const [modeId, mode] of Object.entries(modes)) {
     if (mode.colonnesDerivees) {
       session.colonnesDerivees[modeId] = mode.colonnesDerivees;
     }
   }

   // SELECT_CHOIX peut être un objet statique ou une fonction(workerConfig, data, xsproPayload)
   const rawSC = viewHook?.SELECT_CHOIX;
   if (typeof rawSC === 'function') {
     try {
       session.selectChoix = rawSC(workerConfig, data, session.xsproPayload) || {};
     } catch (e) {
       console.warn(`[ViewResolver] Erreur dans SELECT_CHOIX() : ${e.message} — fallback {}`);
       session.selectChoix = {};
     }
   } else {
     session.selectChoix = rawSC || {};
   }

   const nbModes = Object.keys(session.modes).length;
   const nbSC    = Object.keys(session.selectChoix).length;
   console.log(
     `[ViewResolver] "${session.contextName}" — `
     + `${effectiveColonnes.length} colonnes, `
     + `${nbModes} mode(s), `
     + `${nbSC} selectChoix, `
     + `hook: ${viewHook ? 'oui' : 'non'}`
   );
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = { resolveEffectiveWorkerConfig, loadViewHook };
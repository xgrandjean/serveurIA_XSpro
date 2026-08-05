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
 *
 * Contrat JSON pairé (optionnel, cf. README-prompts.md) :
 *   views/<viewModule>.json, même dossier que le hook. Porte uniquement la partie
 *   déclarative "prompt" : systemPrompt, regles, promptsSuggeres, formatReponse
 *   (racine + par mode), plus historique (limite de conservation) et slots
 *   (politique de cycle de vie par slot, racine + par mode). Absent = comportement
 *   inchangé, 100% rétrocompatible : seul le MANIFEST/MODES du .js fait foi. Présent
 *   = surcharge les 4 champs prompt du MANIFEST et des MODES correspondants (mêmes
 *   règles de fusion que le reste : null/absent = pas de surcharge, garde le .js).
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// AI_WORKER_ASSETS_DIR : redirection optionnelle vers les assets de l'appli
// (positionnée par XSpro quand le serveur est compilé en .exe). Absente :
// dossier de l'exe si compilé via `pkg`, sinon __dirname (inchangé).
const _exeDir = (typeof process.pkg !== 'undefined') ? path.dirname(process.execPath) : __dirname;
const _assetsRoot = process.env.AI_WORKER_ASSETS_DIR || _exeDir;

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
    const hookPath = path.join(_assetsRoot, 'views', `${viewModule}.js`);
    delete require.cache[require.resolve(hookPath)];
    const hook = require(hookPath);
    console.log(`[ViewResolver] Hook vue chargé : views/${viewModule}.js`);
    return hook;
  } catch (e) {
    console.warn(`[ViewResolver] Hook vue "${viewModule}" introuvable : ${e.message}`);
    return null;
  }
}

// ── Chargement du JSON pairé (paramétrage prompt) ─────────────────────────────
/**
 * Charge views/<viewModule>.json si présent — cf. contrat en tête de fichier et
 * README-prompts.md. Absent ou invalide = null, aucune erreur bloquante : le hook
 * fonctionne alors exactement comme avant l'introduction du JSON pairé.
 *
 * @param {Object} workerConfig
 * @returns {Object|null}
 */
function loadPairedJson(workerConfig) {
  const viewModule = workerConfig?.viewModule;
  if (!viewModule) return null;

  const jsonPath = path.join(_assetsRoot, 'views', `${viewModule}.json`);
  if (!fs.existsSync(jsonPath)) return null;

  try {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    console.log(`[ViewResolver] Paramétrage prompt chargé : views/${viewModule}.json`);
    return parsed;
  } catch (e) {
    console.warn(`[ViewResolver] JSON pairé "${viewModule}.json" invalide, ignoré : ${e.message}`);
    return null;
  }
}

/**
 * Fusionne les 4 champs prompt déclaratifs d'un JSON pairé (racine ou entrée de
 * mode) sur un objet MANIFEST/MODE du .js. Même règle que resolveManifestField :
 * absent/null côté JSON = pas de surcharge, on garde la valeur .js telle quelle.
 *
 * @param {Object} base    — MANIFEST ou entrée MODES[modeId] du .js (jamais muté)
 * @param {Object|null} jsonSection — racine du JSON pairé, ou jsonConfig.modes[modeId]
 * @returns {Object} — copie de base avec les champs prompt éventuellement surchargés
 */
function mergePromptFields(base, jsonSection) {
  if (!jsonSection) return base;
  return {
    ...base,
    systemPrompt:    jsonSection.systemPrompt    ?? base.systemPrompt,
    regles:          jsonSection.regles          ?? base.regles,
    promptsSuggeres: jsonSection.promptsSuggeres ?? base.promptsSuggeres,
    formatReponse:   jsonSection.formatReponse   ?? base.formatReponse,
  };
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

  const viewHook  = loadViewHook(workerConfig);
  const jsonConfig = loadPairedJson(workerConfig);
  // JSON pairé = surcharge des seuls champs prompt déclaratifs (cf. contrat en tête
  // de fichier). Tout le reste du MANIFEST (colonnes, styles, editionParActions...)
  // vient exclusivement du .js, comme avant.
  const mf = mergePromptFields(viewHook?.MANIFEST || {}, jsonConfig);

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
    // Déclare les champs array dont les valeurs sont des indices numériques référençant
    // un autre champ array de la même ligne (ex: { choixCorrect: 'choix' }). Consommé
    // côté client par grid.js (TextareaCellEditor + cellRenderer) pour afficher/éditer
    // le texte résolu tout en stockant/envoyant les indices. Purement déclaratif ici.
    champsIndexRef:  mf.champsIndexRef ?? workerConfig.champsIndexRef ?? {},
  };

  // Hook vue, modes et selectChoix exposés sur la session
   session.viewHook    = viewHook;
   // MODES du .js, avec surcharge des 4 champs prompt par le JSON pairé le cas
   // échéant (jsonConfig.modes[modeId]) — même logique de fusion que le MANIFEST
   // ci-dessus. Le reste d'une entrée MODE (colonnesUiHidden, surchargesColonnes,
   // editionParActions...) vient toujours exclusivement du .js.
   const jsModes = viewHook?.MODES || {};
   session.modes = {};
   for (const [modeId, modeDef] of Object.entries(jsModes)) {
     session.modes[modeId] = mergePromptFields(modeDef, jsonConfig?.modes?.[modeId]);
   }
   session.rowStyles   = mf.rowStyles || null;

   // Politique de cycle de vie du contexte LLM (historique + slots), cf.
   // README-prompts.md §3-4. Purement issue du JSON pairé — pas d'équivalent .js,
   // c'est un concept qui n'existait pas avant son introduction. Absent = null,
   // llmClient.js applique alors les policies par défaut documentées au §4.
   // Fusion racine/mode différée à llmClient.js (qui connaît le mode actif) plutôt
   // que résolue ici, pour rester cohérent avec la façon dont systemPrompt/regles
   // par mode sont déjà surchargés au moment de l'appel (cf. run(), overriddenConfig).
   session.promptPolicy = jsonConfig
     ? {
         historique: jsonConfig.historique || null,
         slotsBase:  jsonConfig.slots || null,
         slotsParMode: Object.fromEntries(
           Object.entries(jsonConfig.modes || {}).map(([modeId, m]) => [modeId, m.slots || null])
         ),
       }
     : null;
   
   // Export format depuis le MANIFEST (pour conversion indices→labels dans excelExport)
   session.exportFormat = mf.exportFormat || {};

   // Mode de revue par pending (opt-in par vue, cf. MANIFEST.revueParPending) : quand actif,
   // llmClient.js (applyRowActions) marque les propositions IA (update/insert/delete) comme
   // "en attente" sur les rows plutôt que de les committer directement — server.js/grid.js
   // exposent alors une UI de validation individuelle/ligne/globale. Absent ou false = comportement
   // historique inchangé (application directe), c'est le cas par défaut pour toutes les vues
   // tant qu'elles n'activent pas ce flag explicitement.
   session.reviewMode = !!mf.revueParPending;

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

   // CHAMPS_RESTREINTS (optionnel, même schéma que SELECT_CHOIX) : { [champ]: { [valeurType]:
   // [valeursAutorisees] } } — permet au client de ne proposer, dans chaque dropdown, que les
   // valeurs non interdites pour le type de la ligne. Purement une restriction du MENU affiché,
   // jamais de la validation (qui reste gérée par validateCellEdit/getInvalidFields).
   const rawCR = viewHook?.CHAMPS_RESTREINTS;
   if (typeof rawCR === 'function') {
     try {
       session.champsRestreints = rawCR(workerConfig, data, session.xsproPayload) || {};
     } catch (e) {
       console.warn(`[ViewResolver] Erreur dans CHAMPS_RESTREINTS() : ${e.message} — fallback {}`);
       session.champsRestreints = {};
     }
   } else {
     session.champsRestreints = rawCR || {};
   }

   // CHAMPS_NON_APPLICABLES (optionnel, même schéma que CHAMPS_RESTREINTS) : { [valeurType]:
   // [champs] } — champs structurellement hors sujet pour ce type de ligne. Contrairement à
   // CHAMPS_RESTREINTS (restreint le MENU d'un dropdown), ceci bloque l'édition ET grise la
   // cellule côté client (public/grid.js) : ne dépend que du champ "type" de la ligne, donc
   // calculable une fois ici plutôt que recalculé à chaque édition côté serveur.
   const rawCNA = viewHook?.CHAMPS_NON_APPLICABLES;
   if (typeof rawCNA === 'function') {
     try {
       session.champsNonApplicables = rawCNA(workerConfig, data, session.xsproPayload) || {};
     } catch (e) {
       console.warn(`[ViewResolver] Erreur dans CHAMPS_NON_APPLICABLES() : ${e.message} — fallback {}`);
       session.champsNonApplicables = {};
     }
   } else {
     session.champsNonApplicables = rawCNA || {};
   }

    const nbModes = Object.keys(session.modes).length;
    const nbSC    = Object.keys(session.selectChoix).length;
    const nbCR    = Object.keys(session.champsRestreints || {}).length;
    console.log(
      `[ViewResolver] "${session.contextName}" — `
      + `${effectiveColonnes.length} colonnes, `
      + `${nbModes} mode(s), `
      + `${nbSC} selectChoix, `
      + `${nbCR} champsRestreints, `
      + `hook: ${viewHook ? 'oui' : 'non'}`
    );
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = { resolveEffectiveWorkerConfig, loadViewHook, loadPairedJson };
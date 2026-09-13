/**
 * AI Worker — mcpChannel.js
 * Canal local de pilotage : permet à un client MCP (Claude) de remplir la grille
 * à la place de l'IA par clé API.
 *
 * L'IDÉE : dans le Worker, l'IA n'est qu'un moyen de PRÉ-remplir la grille.
 * L'utilisateur peut déjà tout saisir à la main puis renvoyer à XSpro. MCP est
 * une TROISIÈME façon de remplir les lignes, à côté de la clé API et de la main.
 * Rien n'est remplacé, rien n'est retiré.
 *
 * Ce fichier porte TOUTE la logique : liste blanche des verbes, garde-fous,
 * traduction _id → rowIndex. La façade MCP (tools/mcp-worker/server.js) ne fait
 * que traduire des outils nommés en appels ici — un client MCP ne peut donc rien
 * faire de plus que ce que ce canal autorise déjà. Même séparation que
 * XSpro/src/agent/agentBridge.js + XSpro/tools/mcp-xspro/server.js.
 *
 * POINT D'ANCRAGE : les verbes d'écriture reproduisent exactement les callbacks
 * donnés à llmClient.run() (cf. server.js, case 'prompt:send') —
 *   onCellUpdate → SM.setCellValue + wsSend('cell:update')
 *   onDone       → SM.setStatus(PAUSED) + wsSend('act:done')
 * llmClient.js n'est pas modifié : il continue de servir le chemin clé API.
 *
 * CE QUE CE CANAL NE FAIT PAS : livrer vers XSpro. Aucun verbe ne touche
 * deliverResult/notifyXSpro. Claude remplit, l'utilisateur relit dans la grille
 * et renvoie lui-même — la validation finale reste humaine.
 */

'use strict';

// ── Garde-fou réseau ──────────────────────────────────────────────────────────
// Le serveur écoute sur toutes les interfaces avec un CORS permissif (cf.
// server.js) : sans ces trois filtres, n'importe quelle page web ouverte chez
// l'utilisateur, ou n'importe quelle machine du réseau, pourrait écrire dans sa
// grille. Chacun ferme un vecteur différent, aucun ne suffit seul.
const IP_LOCALE = /^(?:::1|::ffff:127\.|127\.)/;

const GESTE_CANAL_FERME =
  'Le canal MCP est désactivé dans worker-config.json ("mcp": { "actif": false }). '
  + 'Le réactiver, puis relancer le Worker.';

/**
 * Monte le canal sur l'application Express.
 *
 * À monter AVANT le middleware CORS permissif : ces routes ne doivent jamais
 * recevoir Access-Control-Allow-Origin.
 *
 * @param {Object} app  — application Express
 * @param {Object} deps — { SM, wsSend, actif }
 */
function installMcpChannel(app, deps) {
  const { SM, wsSend } = deps;
  const actif = deps.actif !== false;

  // Statuts dans lesquels une écriture a un sens. Sont exclus :
  //   planning/acting  — l'IA par clé API travaille, deux sources écriraient les
  //                      mêmes lignes (même raisonnement que le refus sur 'rows:move')
  //   delivering       — livraison en cours
  //   done             — la session est livrée : ses lignes sont parties chez XSpro,
  //                      une écriture ne repartirait pas
  //   cancelled        — inatteignable en pratique (session:cancel supprime la session)
  const STATUTS_ECRIVABLES = new Set([
    SM.STATUS.IDLE, SM.STATUS.CONNECTED, SM.STATUS.PAUSED, SM.STATUS.ERROR,
  ]);

  const RAISON_STATUT = {
    [SM.STATUS.PLANNING]:   "l'IA par clé API travaille en ce moment sur cette session — attendre la fin",
    [SM.STATUS.ACTING]:     "l'IA par clé API travaille en ce moment sur cette session — attendre la fin",
    [SM.STATUS.DELIVERING]: 'le résultat est en cours de livraison vers XSpro',
    [SM.STATUS.DONE]:       'cette session est déjà livrée : ses lignes sont parties chez XSpro, une écriture ne repartirait pas',
    [SM.STATUS.CANCELLED]:  'cette session a été annulée',
  };

  // ── Garde ───────────────────────────────────────────────────────────────────
  function garde(req, res, next) {
    if (!actif) return res.status(403).json({ erreur: GESTE_CANAL_FERME });

    // 1. Loopback — ferme le réseau local.
    const ip = req.socket.remoteAddress || '';
    if (!IP_LOCALE.test(ip)) {
      return res.status(403).json({ erreur: 'Canal local uniquement : cet appel ne vient pas de cette machine.' });
    }

    // 2. Aucun en-tête Origin — un navigateur en met TOUJOURS un sur un POST
    //    cross-origin ; curl et Node n'en mettent pas. C'est ce filtre qui ferme
    //    le vecteur « page web ouverte chez l'utilisateur », que le seul filtre
    //    loopback ne bloque pas (une telle page poste depuis 127.0.0.1).
    if (req.headers.origin) {
      return res.status(403).json({ erreur: 'Canal local uniquement : appel refusé (origine navigateur).' });
    }

    // 3. En-tête maison — non listée dans Access-Control-Allow-Headers, donc
    //    inenvoyable en cross-origin : le préflight échoue avant la requête.
    //    Deuxième verrou sur le même vecteur.
    if (req.headers['x-worker-mcp'] !== '1') {
      return res.status(403).json({ erreur: 'En-tête X-Worker-MCP: 1 requise.' });
    }
    next();
  }

  // ── Résolution et garde-fous de session ─────────────────────────────────────
  /**
   * @returns {string|null} le motif du refus, ou null si l'écriture est permise
   */
  function motifRefusEcriture(session) {
    if (session.canal !== 'mcp') {
      return 'Cette session est en mode « clé API » : c\'est l\'IA par clé API qui la remplit. '
        + 'Pour que Claude puisse écrire, basculer le sélecteur « Remplissage » sur « Claude (MCP) » '
        + 'dans l\'en-tête de la grille — ou régler "canalParDefaut": "mcp" dans worker-config.json '
        + 'pour que les nouvelles sessions s\'ouvrent directement ainsi.';
    }
    if (!STATUTS_ECRIVABLES.has(session.status)) {
      return `Écriture impossible (statut « ${session.status} ») : ${RAISON_STATUT[session.status] || 'statut non inscriptible'}.`;
    }
    return null;
  }

  /**
   * @returns {{ session }} ou {{ erreur, statut }}
   */
  function resoudre(args, ecriture) {
    const id = args.sessionId;
    if (!id) return { erreur: 'sessionId requis. Appeler worker_sessions pour la liste.', codeHttp: 400 };

    const session = SM.getSession(id);
    if (!session) {
      return {
        erreur: `Session inconnue : « ${id} ». Elle a pu expirer (2 h sans activité) ou être annulée. `
          + 'Appeler worker_sessions pour la liste des sessions ouvertes.',
        codeHttp: 404,
      };
    }
    if (ecriture) {
      const refus = motifRefusEcriture(session);
      if (refus) return { erreur: refus, codeHttp: 409 };
    }
    return { session };
  }

  // ── Helpers de lecture ──────────────────────────────────────────────────────
  /**
   * Mode par défaut d'une vue — miroir exact de la règle du client
   * (public/grid.js, resoudreModeParDefaut) : un mode déclarant `parDefaut`
   * l'emporte, puis 'standard', puis le premier déclaré.
   */
  function modeParDefaut(modes) {
    const keys = Object.keys(modes || {});
    if (!keys.length) return null;
    return keys.find(k => modes[k]?.parDefaut) || (keys.includes('standard') ? 'standard' : keys[0]);
  }

  function listerModes(session) {
    const modes = session.modes || {};
    const defaut = modeParDefaut(modes);
    return Object.keys(modes).map(id => ({
      id,
      label:           modes[id].label || id,
      description:     modes[id].description || null,
      parDefaut:       id === defaut,
      promptsSuggeres: modes[id].promptsSuggeres || null,
    }));
  }

  /**
   * Colonnes réellement en jeu pour un mode donné — miroir des étapes 2-3 de
   * llmClient.buildPromptPreview : surchargesColonnes fusionnées (indexées par
   * `champ`, pas par `cle`), colonnesLlmHidden et placeholders retirés.
   *
   * Cette duplication est assumée : sans elle, en mode décomposition Claude
   * remplirait des colonnes que le mode interdit au LLM par clé API, et les deux
   * canaux divergeraient. llmClient.js n'expose pas ce calcul et ne doit pas être
   * modifié pour l'exposer.
   */
  function colonnesDuMode(session, modeId) {
    const cfg        = session.effectiveWorkerConfig || {};
    const mode       = modeId ? (session.modes?.[modeId] || null) : null;
    const masquees   = new Set(mode?.colonnesLlmHidden || []);
    const surcharges = mode?.surchargesColonnes || {};

    return (cfg.colonnes || [])
      .map(col => (surcharges[col.champ] ? { ...col, ...surcharges[col.champ] } : col))
      .filter(col => !col.placeholder && !masquees.has(col.cle));
  }

  /**
   * Décrit une colonne pour un modèle : les selectChoix sont FUSIONNÉS dans la
   * colonne (une jointure en moins à faire), et champsArray devient un simple
   * `tableau: true` — c'est là que Claude apprend que `choix`/`choixCorrect`
   * attendent un tableau et non une chaîne.
   */
  function decrireColonnes(session, colonnes) {
    const selectChoix = session.selectChoix  || {};
    const champsArray = new Set(session.effectiveWorkerConfig?.champsArray || []);

    return colonnes.map(col => {
      const d = { cle: col.cle, libelle: col.libelle || col.champ, type: col.type || 'string' };
      if (champsArray.has(col.cle)) d.tableau = true;
      if (col.readOnly)             d.lectureSeule = true;

      const sc = selectChoix[col.cle];
      if (sc?.choix?.length) {
        // `valeur` est ce qui est stocké dans la ligne, `label` ce que la grille
        // affiche. worker_ecrire_cellules accepte les deux et normalise.
        d.choix = sc.choix.map(c => ({ valeur: c.valeur, label: c.label }));
      }
      return d;
    });
  }

  /**
   * Une ligne telle que Claude la voit : _id, les colonnes du mode, et le détail
   * des propositions déjà en attente sur cette ligne (posées par l'IA, par une
   * saisie manuelle ou par un lot MCP précédent).
   */
  function decrireLigne(row, colonnes) {
    const out = { _id: row._id };
    for (const col of colonnes) out[col.cle] = row[col.cle];

    const champs = row.__pendingFields ? Object.keys(row.__pendingFields) : [];
    if (champs.length || row.__pendingInsert || row.__pendingDelete) {
      out._attente = {};
      if (champs.length)        out._attente.champs      = champs;
      if (row.__pendingInsert)  out._attente.insertion   = true;
      if (row.__pendingDelete)  out._attente.suppression = true;
    }
    return out;
  }

  // ── Verbe : sessions ────────────────────────────────────────────────────────
  // Point d'entrée : ce que le Worker a en cours, et ce que XSpro a demandé.
  function verbeSessions() {
    const sessions = SM.listSessions().map(resume => {
      const session = SM.getSession(resume.sessionId);
      if (!session) return null;                      // disparue entre les deux appels

      const refus = motifRefusEcriture(session);
      return {
        sessionId:        resume.sessionId,
        contextName:      resume.contextName,
        statut:           session.status,
        canal:            session.canal || 'api',
        origine:          session.origin || 'xspro',
        lignes:           session.rows.length,
        pendingCount:     SM.countPendingRows(session),
        uiConnectee:      !!(session.ws && session.ws.readyState === 1),
        reviewMode:       !!session.reviewMode,
        ecrivable:        !refus,
        raison:           refus || undefined,
        // Ce que XSpro a demandé en envoyant cette vue.
        demandeXSpro:     session.effectiveWorkerConfig?.prompt || null,
        modes:            listerModes(session),
        creeLe:           resume.createdAt,
        derniereActivite: resume.lastActivityAt,
      };
    }).filter(Boolean);

    return { sessions };
  }

  // ── Verbe : contexte ────────────────────────────────────────────────────────
  // De quoi travailler : les colonnes du mode, les lignes, et le MÊME briefing
  // métier que celui envoyé à l'IA par clé API.
  async function verbeContexte(args) {
    const r = resoudre(args, false);
    if (r.erreur) return r;
    const { session } = r;

    const modes = session.modes || {};
    if (args.mode && !modes[args.mode]) {
      const dispo = Object.keys(modes).join(', ') || 'aucun';
      return { erreur: `Mode inconnu : « ${args.mode} ». Modes de cette vue : ${dispo}.`, codeHttp: 400 };
    }
    const modeId = args.mode || modeParDefaut(modes);

    const colonnes = colonnesDuMode(session, modeId);

    // Pagination : une vue peut porter beaucoup de lignes, et la réponse part
    // dans le contexte d'un modèle.
    const offset = Math.max(0, Number(args.offset) || 0);
    const limite = Math.min(500, Math.max(1, Number(args.limite) || 100));
    const lignes = session.rows.slice(offset, offset + limite).map(row => decrireLigne(row, colonnes));

    const sortie = {
      sessionId:        session.sessionId,
      contextName:      session.contextName,
      statut:           session.status,
      canal:            session.canal || 'api',
      reviewMode:       !!session.reviewMode,
      modeApplique:     modeId,
      modesDisponibles: listerModes(session),
      colonnes:         decrireColonnes(session, colonnes),
      infosParent:      session.data?.infosParent || {},
      infosVue:         session.data?.infosVue    || {},
      lignes,
      pagination:       { offset, limite, total: session.rows.length },
      pendingCount:     SM.countPendingRows(session),
    };

    // Briefing : le system prompt EXACT que recevrait l'IA par clé API pour ce
    // mode (règles métier, format, modèle de lignes). C'est ce qui garantit que
    // les deux canaux travaillent avec les mêmes consignes. On ne prend que
    // `system` : `full[1]` redonne les lignes en CSV, doublon de `lignes`.
    if (args.briefing !== false) {
      const llmClient = require('./llmClient');
      // buildPromptPreview lit session.activeMode (comme le fait l'aperçu de
      // l'UI) : on le positionne puis on le RESTAURE — l'UI s'en sert pour
      // plan:validate, l'écraser silencieusement changerait son prochain envoi.
      const memo = session.activeMode;
      session.activeMode = modeId;
      try {
        const apercu = await llmClient.buildPromptPreview(session, null, 'act', []);
        sortie.briefing = apercu.system;
      } finally {
        session.activeMode = memo;
      }
    }

    return sortie;
  }

  // ── Helpers d'écriture ──────────────────────────────────────────────────────
  // Plafonds : au-delà, la réponse et le temps de traitement deviennent hostiles.
  // Le message dit de découper plutôt que de tronquer en silence.
  const MAX_LIGNES   = 200;
  const MAX_CELLULES = 2000;

  const REFUS_HORS_REVUE =
    'Cette vue n\'est pas en mode revue : une ligne insérée ou supprimée y serait '
    + 'définitive, sans passer par la validation de l\'utilisateur — et une suppression '
    + 'proposée partirait quand même chez XSpro. Utiliser worker_ecrire_cellules sur les '
    + 'lignes existantes, et laisser l\'utilisateur ajouter ou retirer les lignes lui-même.';

  /**
   * Conversion selon le type de colonne — miroir de coerceValueForGrid
   * (public/grid.js) : c'est ce que fait déjà la grille sur une saisie manuelle.
   * Sans cela, MCP stockerait "120" là où une saisie manuelle stocke 120, et XSpro
   * recevrait une chaîne. Une valeur non numérique est laissée INTACTE — au
   * contraire du coerceValue de llmClient (non exporté), qui transforme
   * l'illisible en 0/'' : acceptable pour une réponse de LLM à recoller, pas pour
   * une entrée externe qu'il vaut mieux rapporter telle quelle.
   */
  function coerce(valeur, col) {
    if (valeur === '' || valeur === null || valeur === undefined) return valeur;
    if (Array.isArray(valeur)) return valeur;          // champsArray : choix, choixCorrect
    const type = col?.type;
    if (type === 'decimal' || type === 'number' || type === 'integer') {
      const n = parseFloat(valeur);
      if (!isNaN(n)) return type === 'integer' ? parseInt(valeur, 10) : n;
    }
    return valeur;
  }

  /**
   * Colonne à choix : accepte indifféremment la `valeur` ou le `label`, comme le
   * fait normalizeSelectChoixValue pour le LLM. Résolu AVANT coerce, et non après :
   * un label comme « 35 €/h » sur une colonne numérique donnerait 35 à parseFloat,
   * qui n'est pas l'indice attendu mais le début du libellé.
   *
   * Pas de repli sur scDef.fallback ici : une valeur inconnue est rapportée à
   * l'appelant plutôt que remplacée en silence.
   */
  function resoudreChoix(brut, scDef) {
    for (const e of scDef.choix) if (e.valeur === brut) return { ok: true, valeur: e.valeur };
    const s = String(brut).trim();
    for (const e of scDef.choix) if (String(e.label).trim() === s) return { ok: true, valeur: e.valeur };
    for (const e of scDef.choix) if (String(e.valeur) === s) return { ok: true, valeur: e.valeur };
    return { ok: false };
  }

  /**
   * Prépare les valeurs d'une ligne : colonnes inconnues écartées et RAPPORTÉES
   * (sans cela une faute de frappe créerait un champ fantôme expédié à XSpro),
   * choix résolus, types convertis.
   */
  function preparerValeurs(session, valeurs, id, ignorees) {
    const parCle      = new Map((session.effectiveWorkerConfig?.colonnes || []).map(c => [c.cle, c]));
    const selectChoix = session.selectChoix || {};
    const pretes      = [];

    for (const [cle, brut] of Object.entries(valeurs || {})) {
      const col = parCle.get(cle);
      if (!col) { ignorees.push({ _id: id, cle, raison: 'colonne inconnue dans cette vue' }); continue; }

      const scDef = selectChoix[cle];
      if (scDef?.choix?.length) {
        const r = resoudreChoix(brut, scDef);
        if (!r.ok) {
          const attendus = scDef.choix.map(c => `${JSON.stringify(c.valeur)} (${c.label})`).join(', ');
          ignorees.push({ _id: id, cle, raison: `valeur hors des choix de cette colonne — attendu : ${attendus}` });
          continue;
        }
        pretes.push([cle, r.valeur]);
        continue;
      }
      pretes.push([cle, coerce(brut, col)]);
    }
    return pretes;
  }

  /**
   * Message consolidé par ligne touchée — copie du chemin de saisie manuelle
   * (cf. server.js, case 'cell:edit'). Indispensable : c'est lui qui recopie
   * __pendingFields côté client (onRowValidate) et déclenche donc l'ambre « en
   * attente » ; un cell:update seul ne la fait pas apparaître. Il porte aussi le
   * rouge « à remplir » calculé par le hook vue.
   */
  function envoyerValidation(session, rowIndex) {
    const row = session.rows[rowIndex];
    if (!row) return;

    const hook     = session.viewHook;
    const invalid  = hook?.getInvalidFields?.(row) || [];
    const missing  = hook?.getMissingFields?.(row) || [];
    const combined = Array.from(new Set([...invalid, ...missing]));

    wsSend(session, {
      type:          'cell:validate',
      rowIndex,
      invalidFields: combined,
      pendingFields: session.reviewMode ? { ...(row.__pendingFields || {}) } : {},
      pendingCount:  session.reviewMode ? SM.countPendingRows(session) : undefined,
      message:       null,
    });
  }

  function etatSession(session) {
    return {
      pendingCount: SM.countPendingRows(session),
      uiConnectee:  !!(session.ws && session.ws.readyState === 1),
    };
  }

  // ── Verbe : ecrire ──────────────────────────────────────────────────────────
  // Le point d'ancrage : pour chaque cellule, exactement ce que fait onCellUpdate
  // sur le chemin clé API (cf. server.js, case 'prompt:send').
  function verbeEcrire(args) {
    const r = resoudre(args, true);
    if (r.erreur) return r;
    const { session } = r;

    const lignes = Array.isArray(args.lignes) ? args.lignes : null;
    if (!lignes || !lignes.length) {
      return { erreur: 'args.lignes attendu : [{ _id, valeurs: { cle: valeur, ... } }, ...].', codeHttp: 400 };
    }
    if (lignes.length > MAX_LIGNES) {
      return { erreur: `${lignes.length} lignes en un appel, maximum ${MAX_LIGNES} — découper en plusieurs lots.`, codeHttp: 400 };
    }
    const nbCellules = lignes.reduce((n, l) => n + Object.keys(l?.valeurs || {}).length, 0);
    if (nbCellules > MAX_CELLULES) {
      return { erreur: `${nbCellules} cellules en un appel, maximum ${MAX_CELLULES} — découper en plusieurs lots.`, codeHttp: 400 };
    }

    let cellulesEcrites   = 0;
    const lignesTouchees  = [];
    const ignorees        = [];

    for (const ligne of lignes) {
      const id = ligne?._id;
      // Traduction _id → rowIndex ICI, au moment d'écrire : un « + Ligne » ou un
      // déplacement fait par l'utilisateur entre deux lots est donc sans effet.
      const rowIndex = session.rows.findIndex(row => String(row._id) === String(id));
      if (rowIndex === -1) {
        ignorees.push({ _id: id, raison: '_id introuvable dans cette session' });
        continue;
      }

      const pretes = preparerValeurs(session, ligne.valeurs, id, ignorees);
      for (const [cle, valeur] of pretes) {
        SM.setCellValue(session, rowIndex, cle, valeur);
        wsSend(session, { type: 'cell:update', rowIndex, cle, value: valeur });
        cellulesEcrites++;
      }
      if (pretes.length) {
        lignesTouchees.push(id);
        envoyerValidation(session, rowIndex);
      }
    }

    return { cellulesEcrites, lignesTouchees, ignorees, ...etatSession(session) };
  }

  // ── Verbe : inserer ─────────────────────────────────────────────────────────
  // Réutilise le chemin du bouton manuel « + Ligne » : la ligne arrive marquée
  // __pendingInsert, donc validable ou rejetable dans la grille.
  function verbeInserer(args) {
    const r = resoudre(args, true);
    if (r.erreur) return r;
    const { session } = r;
    if (!session.reviewMode) return { erreur: REFUS_HORS_REVUE, codeHttp: 409 };

    const lignes = Array.isArray(args.lignes) ? args.lignes : null;
    if (!lignes || !lignes.length) {
      return { erreur: 'args.lignes attendu : [{ cle: valeur, ... }, ...].', codeHttp: 400 };
    }
    if (lignes.length > MAX_LIGNES) {
      return { erreur: `${lignes.length} lignes en un appel, maximum ${MAX_LIGNES} — découper en plusieurs lots.`, codeHttp: 400 };
    }

    // `apres` suit la convention de SM.proposeInsertRow, la même que le `_apres` du
    // contrat LLM : un _id, null (en tête) ou 'fin'. Absent = en fin, choix plus
    // prévisible que « en tête » pour un appelant qui n'a rien précisé.
    let apres = args.apres === undefined ? 'fin' : args.apres;
    if (apres !== null && apres !== 'fin') {
      if (!session.rows.some(row => String(row._id) === String(apres))) {
        return { erreur: `apres : _id introuvable (${apres}). Utiliser un _id de worker_contexte, null pour insérer en tête, ou "fin".`, codeHttp: 400 };
      }
      apres = Number(apres);            // proposeInsertRow compare en ===
    }

    const ids      = [];
    const ignorees = [];
    for (const champs of lignes) {
      const pretes = preparerValeurs(session, champs, null, ignorees);
      SM.proposeInsertRow(session, apres, Object.fromEntries(pretes));
      // proposeInsertRow ne rend pas l'_id attribué, mais il vient de consommer
      // exactement un consumeNextId : c'est donc _nextId - 1. Le rendre est
      // indispensable — sans lui, impossible d'écrire dans la ligne qu'on vient
      // de créer.
      const id = session._nextId - 1;
      ids.push(id);
      apres = id;                       // chaînage : préserve l'ordre du lot
    }

    wsSend(session, { type: 'review:sync', rows: session.rows, pendingCount: SM.countPendingRows(session) });
    return { ids, ignorees, ...etatSession(session) };
  }

  // ── Verbe : supprimer ───────────────────────────────────────────────────────
  // Chemin du bouton manuel « ✂️ » : la ligne reste visible, marquée en attente
  // de suppression, jusqu'à ce que l'utilisateur tranche.
  function verbeSupprimer(args) {
    const r = resoudre(args, true);
    if (r.erreur) return r;
    const { session } = r;
    if (!session.reviewMode) return { erreur: REFUS_HORS_REVUE, codeHttp: 409 };

    const ids = Array.isArray(args.ids) ? args.ids : null;
    if (!ids || !ids.length) return { erreur: 'args.ids attendu : [_id, ...].', codeHttp: 400 };

    const connus   = [];
    const ignorees = [];
    for (const id of ids) {
      const row = session.rows.find(r2 => String(r2._id) === String(id));
      if (row) connus.push(row._id);
      else ignorees.push({ _id: id, raison: '_id introuvable dans cette session' });
    }

    SM.proposeDeleteRows(session, connus);
    wsSend(session, { type: 'review:sync', rows: session.rows, pendingCount: SM.countPendingRows(session) });
    return { marquees: connus.length, ignorees, ...etatSession(session) };
  }

  // ── Verbe : terminer ────────────────────────────────────────────────────────
  // L'équivalent de onDone : statut PAUSED (= en attente de relecture humaine) et
  // re-rendu complet de la grille. `session.rows = updatedRows` de onDone est sans
  // objet ici, les écritures ont muté le tableau en place.
  function verbeTerminer(args) {
    const r = resoudre(args, true);
    if (r.erreur) return r;
    const { session } = r;

    SM.setStatus(session, SM.STATUS.PAUSED);
    wsSend(session, {
      type:          'act:done',
      rows:          session.rows,
      pendingCount:  SM.countPendingRows(session),
      // Comme le contrat positionnel : le client recalcule le résumé depuis les
      // marqueurs réellement présents (_resumeDepuisMarqueurs, public/grid.js).
      actionsResume: null,
      rapport:       args.rapport || null,
    });

    return { etat: session.status, lignes: session.rows.length, ...etatSession(session) };
  }

  // ── Table des verbes ────────────────────────────────────────────────────────
  // La façade MCP ne peut appeler que ce qui est déclaré ici.
  const VERBES = {
    sessions:  verbeSessions,
    contexte:  verbeContexte,
    ecrire:    verbeEcrire,
    inserer:   verbeInserer,
    supprimer: verbeSupprimer,
    terminer:  verbeTerminer,
  };

  // ── Route ───────────────────────────────────────────────────────────────────
  // Un seul point d'entrée { verbe, args } plutôt que six routes REST : le
  // garde-fou et la validation d'entrée sont écrits une fois, et ajouter un verbe
  // ne crée pas de route. Même forme que POST /commande côté XSpro.

  // Le préflight doit être intercepté ICI : laissé au middleware CORS permissif
  // de server.js, il répondrait 204 + Access-Control-Allow-Origin: *.
  app.options('/mcp/commande', (req, res) => res.sendStatus(403));

  app.post('/mcp/commande', garde, async (req, res) => {
    const { verbe, args } = req.body || {};
    const fn = VERBES[verbe];
    if (!fn) {
      return res.status(400).json({ erreur: `Verbe inconnu : « ${verbe} ». Verbes : ${Object.keys(VERBES).join(', ')}.` });
    }

    try {
      const sortie = await fn(args || {});
      if (sortie && sortie.erreur) {
        return res.status(sortie.codeHttp || 400).json({ erreur: sortie.erreur });
      }
      res.json({ ok: true, ...sortie });
    } catch (e) {
      console.error(`[MCP] Erreur sur le verbe « ${verbe} » :`, e.message);
      res.status(500).json({ erreur: e.message || 'erreur interne' });
    }
  });

  console.log('[MCP] Canal de pilotage monté → POST /mcp/commande');
}

module.exports = { installMcpChannel };

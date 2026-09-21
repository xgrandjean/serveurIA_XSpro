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

const fs   = require('fs');
const path = require('path');

// ══════════════════════════════════════════════════════════════════════════════
// ── PHASE BÊTA — rapport d'anomalies ─────────────────────────────────────────
//
// Ce qui suit est un instrument de mise au point, pas une fonctionnalité pour
// l'utilisateur. Pendant la bêta, Claude est le seul à voir en vrai ce que XSpro
// envoie réellement au Worker : il est donc bien placé pour signaler ce qui
// cloche — des données qui contredisent la réalité de l'affaire, un libellé de
// colonne qui ne décrit pas son contenu, une règle métier intenable, une valeur
// attendue absente d'une liste de choix.
//
// Ces constats vont dans un journal destiné au DÉVELOPPEUR, jamais dans la
// grille : aucun message WebSocket n'est poussé, et Claude se contente d'une
// phrase disant que le journal a été alimenté. L'utilisateur averti sait qu'il y
// a eu un souci et transmet le fichier ; il n'a pas à lire un diagnostic
// technique au milieu de son devis.
//
// À trancher avant de figer quoi que ce soit : garde-t-on le mécanisme une fois
// la bêta finie, et si oui, que devient le journal — rotation, purge, remontée
// automatique ? En attendant, il se coupe sans toucher au code, par
// worker-config.json → "beta": { "rapportAnomalies": false }.
// ══════════════════════════════════════════════════════════════════════════════

// La phrase EXACTE que Claude doit reprendre dans son rapport, et rien de plus.
// Elle est volontairement sobre : elle avertit sans inquiéter ni expliquer.
const PHRASE_ANOMALIE = 'Rapport d\'activité mis à jour — voir le fichier log correspondant.';

const GRAVITES = ['mineure', 'genante', 'bloquante'];

const CONSIGNE_ANOMALIES = `== SIGNALER CE QUI CLOCHE (phase bêta) ==
Le Worker est en rodage, et tu es le seul à voir en vrai ce que XSpro lui envoie.
Si ce qu'on te donne ne tient pas debout — des données qui contredisent la réalité de l'affaire, un libellé de colonne qui ne décrit pas ce qu'elle contient, une règle impossible à respecter, une valeur attendue qui ne figure dans aucune liste de choix, une colonne dont tu aurais besoin et que le mode masque — appelle worker_signaler_anomalie et décris le fait tel que tu l'as constaté.
Ne t'interromps pas pour autant : signale, puis fais de ton mieux avec ce que tu as.
Ce journal est destiné au développeur du Worker, pas à l'utilisateur. Ne lui explique pas l'anomalie, elle ne le concerne pas — il transmettra le fichier. Si et seulement si tu as signalé au moins une anomalie, ajoute à ton rapport de fin cette phrase, et rien d'autre à ce sujet :
« ${PHRASE_ANOMALIE} »`;

/**
 * Un fichier par jour, à côté de exports/, dans le dossier de données du Worker.
 */
function fichierAnomalies(dataRoot) {
  const d = new Date();
  const jour = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return path.join(dataRoot, 'logs', `anomalies-${jour}.jsonl`);
}

// ── Garde-fou réseau ──────────────────────────────────────────────────────────
// Le serveur écoute sur toutes les interfaces avec un CORS permissif (cf.
// server.js) : sans ces trois filtres, n'importe quelle page web ouverte chez
// l'utilisateur, ou n'importe quelle machine du réseau, pourrait écrire dans sa
// grille. Chacun ferme un vecteur différent, aucun ne suffit seul.
const IP_LOCALE = /^(?:::1|::ffff:127\.|127\.)/;

const GESTE_CANAL_FERME =
  'Le canal MCP est désactivé dans worker-config.json ("mcp": { "actif": false }). '
  + 'Le réactiver, puis relancer le Worker.';

// ── Le briefing ───────────────────────────────────────────────────────────────
// Ce que Claude reçoit comme consignes métier. Deux sources possibles :
//
//   1. le bloc `mcp` du JSON pairé de la vue (views/<vue>.json) — des consignes
//      COURTES, écrites pour ce canal : les règles et les exemples, rien de plus ;
//   2. à défaut, le prompt système de l'IA par clé API, amputé de ce qui ne vaut
//      que pour elle.
//
// Pourquoi deux jeux de prompts. Ceux de la clé API ont été écrits pour un modèle
// de puissance limitée, joignable par une seule requête sans dialogue possible :
// ils sont longs, méfiants, et se terminent par un contrat de réponse en JSON —
// « Réponds UNIQUEMENT avec un tableau JSON valide [...] Pas de texte avant ni
// après ». Par MCP, c'est exactement l'inverse qu'il faut faire : appeler des
// outils, et parler à l'utilisateur. Reprendre ces prompts tels quels revenait à
// donner une consigne fausse et à payer ~8 000 caractères de garde-fous devenus
// sans objet. Les prompts de la clé API restent donc intouchés, et la divergence
// entre les deux jeux est assumée (cf. doc/CANAL_MCP.md).

const MARQUEUR_FORMAT   = '== FORMAT DE RÉPONSE ==';
const MARQUEUR_COLONNES = '== COLONNES ==';

// Écrit une fois pour toutes les vues : la traduction du contrat d'actions du
// chemin clé API en appels d'outils.
const COMMENT_REPONDRE = `== COMMENT RÉPONDRE ==
Tu n'écris pas de JSON : tu remplis la grille avec les outils.
- Modifier des lignes existantes → worker_ecrire_cellules, un seul appel pour tout le lot, en ne posant que les champs que tu changes.
- Ajouter des lignes → worker_inserer_lignes. Le « _apres » des règles est l'argument « apres » : un seul pour tout le lot, les lignes gardant l'ordre où tu les écris.
- Retirer des lignes → worker_supprimer_lignes.
- Quand tu as fini → worker_terminer, dont l'argument « rapport » est l'endroit où t'adresser à l'utilisateur.
Une colonne à choix accepte aussi bien sa « valeur » que son « label ».
Tes écritures sont des propositions : l'utilisateur les valide une à une dans la grille, et c'est lui seul qui renvoie le résultat à XSpro.`;

// Ajouté au repli SEULEMENT : les prompts de la clé API renvoient à un bloc de
// données nommé « DONNÉES ACTUELLES », qui n'existe que sur ce chemin-là. Une vue
// reprise à la main n'emploie plus ce terme, la précision y serait du bruit.
const RAPPEL_DONNEES_ACTUELLES =
  '\n« DONNÉES ACTUELLES », dans les règles ci-dessus, désigne le tableau « lignes » de cette même réponse ; les « _id » y sont les mêmes.';

/**
 * Retire une section `== TITRE ==` et son contenu, jusqu'au titre suivant.
 */
function retirerSection(texte, marqueur) {
  const i = texte.indexOf(marqueur);
  if (i === -1) return texte;
  const j = texte.indexOf('\n== ', i + marqueur.length);
  return j === -1 ? texte.slice(0, i) : texte.slice(0, i) + texte.slice(j + 1);
}

/**
 * Compose le bloc `mcp` de la vue et celui du mode.
 *
 * CHAMP PAR CHAMP, et les règles CONCATÉNÉES (celles de la vue, puis celles du
 * mode) — là où les quatre autres champs prompt se remplacent en bloc. C'est
 * délibéré : la règle du remplacement total oblige à recopier dans chaque mode ce
 * qui vaut pour toute la vue, et c'est précisément ce qui a produit les encarts
 * VOCABULAIRE dupliqués quatre fois dans detailsDevis (~7 500 caractères pour
 * ~2 300 d'information réelle). Ici, la vue porte le commun, le mode porte le
 * spécifique, et rien n'est écrit deux fois.
 */
function composerBlocMcp(racine, duMode) {
  if (!racine && !duMode) return null;
  const listeDe = (r) => (Array.isArray(r) ? r : (r ? [String(r)] : []));
  return {
    mission: duMode?.mission ?? racine?.mission ?? null,
    regles:  [...listeDe(racine?.regles), ...listeDe(duMode?.regles)],
    exemple: duMode?.exemple ?? racine?.exemple ?? null,
  };
}

/**
 * Rend le bloc `mcp` d'une vue : mission, règles, exemple.
 */
function rendreBlocMcp(bloc, session, colonnes) {
  const parts = [];

  if (bloc.mission) parts.push(String(bloc.mission).trim());

  if (bloc.regles.length) {
    parts.push('== RÈGLES ==\n' + bloc.regles.map(r => '- ' + String(r).trim()).join('\n'));
  }

  if (bloc.exemple) {
    const e = typeof bloc.exemple === 'string' ? bloc.exemple.trim() : JSON.stringify(bloc.exemple, null, 2);
    parts.push('== EXEMPLE ==\n' + e);
  }

  // Les lignes-modèle viennent du payload XSpro (data.modele) et non des fichiers
  // de vue, où le champ `modele` est null partout. Projetées sur les colonnes du
  // mode, comme le fait buildSystemPrompt.
  //
  // SERVIES EN ENTIER depuis le 2026-09-21. Elles étaient plafonnées à trois, pour
  // ne pas encombrer de répétitions un LLM peu puissant. Mais le plafond était un
  // slice(0, 3) : il gardait les trois PREMIÈRES, soit sur listeQuestions deux blocs
  // de cours presque identiques et un qcm — jamais une ouverte, une courte ni une
  // selection, c'est-à-dire précisément les types dont les règles sont les plus
  // subtiles (couplage regle/correction, choixCorrect en indices ou en textes). Un
  // jeu d'exemples amputé de ses cas difficiles coûte plus cher qu'il n'économise,
  // et le raisonnement d'origine ne vaut plus pour les modèles d'aujourd'hui.
  //
  // Le titre insiste sur leur nature : servies en entier, ces lignes ressemblent à
  // un vrai questionnaire, et rien ne les distinguerait du contenu de la grille.
  const modele = session.data?.modele;
  if (Array.isArray(modele) && modele.length) {
    const lignes = modele.map((m) => {
      const o = {};
      for (const c of colonnes) o[c.cle] = m[c.cle] === undefined ? '' : m[c.cle];
      return o;
    });
    parts.push(
      '== EXEMPLE DE QUESTIONNAIRE COMPLET ==\n'
      + 'Lignes FICTIVES, servies pour la seule forme : les combinaisons valides de chaque\n'
      + 'type, et la façon de remplir chaque colonne. Elles ne font PAS partie de la grille\n'
      + "et n'ont aucun rapport avec le sujet en cours — les vraies lignes sont dans\n"
      + "« lignes ». Ne jamais les recopier, ni s'y référer comme à du contenu existant.\n"
      + JSON.stringify(lignes, null, 2)
    );
  }

  parts.push(COMMENT_REPONDRE);
  return parts.join('\n\n');
}

/**
 * Repli, pour une vue qui n'a pas encore de bloc `mcp` : le prompt système de
 * l'IA par clé API, amputé de ce qui ne vaut que pour elle. Utilisable tout de
 * suite, sans que personne ait eu à relire quoi que ce soit — mais ce n'est pas
 * l'état visé : une vue reprise à la main dit les choses en trois fois moins.
 */
async function briefingReplie(session, modeId) {
  const llmClient = require('./llmClient');

  // buildPromptPreview lit session.activeMode (comme le fait l'aperçu de l'UI) :
  // on le positionne puis on le RESTAURE — l'UI s'en sert pour plan:validate,
  // l'écraser silencieusement changerait son prochain envoi.
  const memo = session.activeMode;
  session.activeMode = modeId;
  let systeme;
  try {
    const apercu = await llmClient.buildPromptPreview(session, null, 'act', []);
    systeme = apercu.system;
  } finally {
    session.activeMode = memo;
  }

  // 1. Couper le contrat de réponse : il exige du JSON et rien d'autre, soit
  //    l'inverse de ce qu'il faut faire ici. Toujours en dernière position — une
  //    assertion du harnais le vérifie sur chaque vue au repli, pour qu'un futur
  //    remaniement de buildSystemPrompt se voie au test et non à l'usage.
  const iFormat = systeme.indexOf(MARQUEUR_FORMAT);
  if (iFormat !== -1) systeme = systeme.slice(0, iFormat);

  // 2. Retirer la liste des colonnes : worker_contexte la sert déjà, structurée,
  //    avec les types et les valeurs admises de chaque colonne.
  systeme = retirerSection(systeme, MARQUEUR_COLONNES);

  return systeme.trimEnd() + '\n\n' + COMMENT_REPONDRE + RAPPEL_DONNEES_ACTUELLES;
}

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
  const actif            = deps.actif !== false;
  const dataRoot         = deps.dataRoot || __dirname;
  const rapportAnomalies = deps.rapportAnomalies !== false;   // cf. bandeau bêta

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

        // Les mots du briefing, quand ce ne sont pas les labels de la grille
        // (cf. resoudreChoix). Servis ici pour que la liste LUE soit exactement
        // la liste ACCEPTÉE à l'écriture : sans cela, suivre la consigne de la
        // vue échoue, et la lecture ne laisse rien deviner.
        const alias = session.effectiveWorkerConfig?.mcp?.aliasChoix?.[col.cle];
        if (alias && Object.keys(alias).length) d.aussiAcceptes = Object.keys(alias);
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
        modeActif:        session.activeMode || modeParDefaut(session.modes || {}),
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
    // Priorité : un mode demandé par Claude > le mode choisi dans la grille
    // (message WS 'workmode:set', cf. server.js) > le mode par défaut de la vue.
    // Sans le second maillon, un utilisateur qui bascule le sélecteur en cours de
    // session ne verrait JAMAIS son choix reflété — l'outil répondrait toujours le
    // défaut (cf. l'essai de production : « je suis passé en Chiffrage, il continue
    // en Décomposition »).
    const modeId = args.mode || session.activeMode || modeParDefaut(modes);

    const colonnes = colonnesDuMode(session, modeId);

    // Le mode d'ÉCRITURE ne suit PAS args.mode : colonnesEcriture() lit
    // session.activeMode, c'est-à-dire le sélecteur de la grille. Lire en
    // « analyse » pendant que la grille est restée en « creation » sert donc des
    // colonnes que worker_ecrire_cellules écartera — et le refus n'arrivait
    // qu'APRÈS coup, dans « ignorees », une fois le travail composé. Le cas s'est
    // produit : contexte lu en analyse pour ses colonnes annexes (indication,
    // explicationCorrection, consigneIA), qui ne sont pas remplissables en
    // creation. On l'annonce donc avant, avec le geste qui le lève.
    const modeEcriture = session.activeMode || modeParDefaut(modes);
    let avertissementEcriture = null;
    if (modeEcriture !== modeId) {
      const inscriptibles = new Set(colonnesDuMode(session, modeEcriture).map(c => c.cle));
      const horsEcriture  = colonnes.map(c => c.cle).filter(c => !inscriptibles.has(c));
      avertissementEcriture =
        `Lecture en mode « ${modeId} », mais les écritures suivent le sélecteur `
        + `« Mode de travail » de la grille, resté sur « ${modeEcriture} ». `
        + (horsEcriture.length
            ? `worker_ecrire_cellules écartera ces colonnes : ${horsEcriture.join(', ')}. `
            : 'Les colonnes des deux modes coïncident, aucune écriture ne sera perdue. ')
        + 'Geste qui le lève : demander à l\'utilisateur de basculer le sélecteur '
        + `« Mode de travail » de la grille sur « ${modeId} ».`;
    }

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
      // Le mode dont dépendent les ÉCRITURES — pas toujours celui qu'on vient de
      // lire. Servi même sans briefing : une relecture briefing:false est
      // justement ce qui précède une écriture.
      modeInscriptible: modeEcriture,
      modesDisponibles: listerModes(session),
      colonnes:         decrireColonnes(session, colonnes),
      infosParent:      session.data?.infosParent || {},
      infosVue:         session.data?.infosVue    || {},
      lignes,
      pagination:       { offset, limite, total: session.rows.length },
      pendingCount:     SM.countPendingRows(session),
    };

    if (avertissementEcriture) sortie.avertissementEcriture = avertissementEcriture;

    // Briefing : les consignes métier de la vue (cf. en tête de fichier).
    if (args.briefing !== false) {
      const bloc = composerBlocMcp(
        session.effectiveWorkerConfig?.mcp || null,
        (modeId && session.modes?.[modeId]?.mcp) || null,
      );

      if (bloc) {
        sortie.briefing       = rendreBlocMcp(bloc, session, colonnes);
        sortie.briefingSource = 'vue';
      } else {
        sortie.briefing       = await briefingReplie(session, modeId);
        sortie.briefingSource = 'repli';
      }

      // En-tête : rappeler quel mode est appliqué, et pourquoi. C'est là que Claude
      // vérifie que le sélecteur de la grille a été pris en compte — le service déjà
      // reçu ne se met pas à jour tout seul.
      const libelleMode    = modeId ? `« ${modeId} »` : 'aucun';
      const origineMode    = args.mode ? 'mode demandé explicitement' : 'mode sélectionné dans la grille';
      sortie.briefing = `MODE DE TRAVAIL APPLIQUÉ : ${libelleMode} (${origineMode}).`
        + ' Un changement de mode dans la grille ne se reflète ici qu\'après un nouvel'
        + ' appel de worker_contexte — le mode suit le sélecteur.'
        + (avertissementEcriture ? '\n\n⚠️ ÉCRITURE : ' + avertissementEcriture : '')
        + "\n\n" + sortie.briefing;

      // Phase bêta — cf. le bandeau en tête de fichier. Ajouté ici, au seul
      // endroit où le briefing est servi, plutôt que dans chacune des deux
      // sources : le jour où l'on coupe le drapeau, la consigne disparaît des
      // douze combinaisons d'un coup.
      if (rapportAnomalies) sortie.briefing += '\n\n' + CONSIGNE_ANOMALIES;
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
   *
   * En dernier recours, les alias déclarés par la vue (mcp.aliasChoix). Ils
   * existent parce que le briefing d'une vue peut enseigner un vocabulaire qui
   * n'est PAS celui des labels de la grille : sur listeQuestions, la consigne et
   * le libellé de la colonne disent tous deux « qcm, courte, ouverte, selection,
   * cours », là où la grille affiche « Réponse courte », « Texte long », « Liste
   * de choix », « Cours ». Écrire le mot que la consigne enseigne échouait donc,
   * et rien en lecture ne permettait de le prévoir : decrireColonnes() sert
   * exactement la liste que les boucles ci-dessus comparent. Les alias sont
   * déclarés par la vue, jamais devinés, et ne peuvent viser qu'une valeur qui
   * existe déjà dans la liste de choix.
   */
  function resoudreChoix(brut, scDef, alias) {
    for (const e of scDef.choix) if (e.valeur === brut) return { ok: true, valeur: e.valeur };
    const s = String(brut).trim();
    for (const e of scDef.choix) if (String(e.label).trim() === s) return { ok: true, valeur: e.valeur };
    for (const e of scDef.choix) if (String(e.valeur) === s) return { ok: true, valeur: e.valeur };

    if (alias) {
      const cible = Object.prototype.hasOwnProperty.call(alias, s) ? alias[s] : alias[s.toLowerCase()];
      if (cible !== undefined && scDef.choix.some(e => e.valeur === cible)) return { ok: true, valeur: cible };
    }
    return { ok: false };
  }

  /**
   * Les colonnes remplissables MAINTENANT : celles du mode de travail actif de
   * la session — ce que le sélecteur de la grille a choisi. Sans ce filtre,
   * Claude pourrait écrire une colonne de prix alors que la grille tourne en
   * mode Décomposition : la lecture (worker_contexte) ne montre même pas la
   * colonne, mais l'écriture l'aurait acceptée, et les deux canaux divergeraient.
   * Option assumée : le refus est RAPPORTÉ (ignorees), jamais silencieux.
   */
  function colonnesEcriture(session) {
    const modeId = session.activeMode || modeParDefaut(session.modes || {});
    return { modeId: modeId, autorisees: colonnesDuMode(session, modeId) };
  }

  /**
   * Prépare les valeurs d'une ligne : colonnes inconnues écartées et RAPPORTÉES
   * (sans cela une faute de frappe créerait un champ fantôme expédié à XSpro),
   * choix résolus, types convertis. `colonnesPermisees` restreint aux colonnes
   * du mode de travail actif — une clé connue de la vue mais hors mode est
   * rapportée comme telle, pas comme une colonne inconnue.
   */
  function preparerValeurs(session, valeurs, id, ignorees, colonnesPermisees, modeId) {
    const toutes      = new Map((session.effectiveWorkerConfig?.colonnes || []).map(c => [c.cle, c]));
    const parCle      = new Map((colonnesPermisees || session.effectiveWorkerConfig?.colonnes || []).map(c => [c.cle, c]));
    const selectChoix = session.selectChoix || {};
    const pretes      = [];

    for (const [cle, brut] of Object.entries(valeurs || {})) {
      const col = parCle.get(cle);
      if (!col) {
        ignorees.push({ _id: id, cle, raison: toutes.has(cle)
          ? `colonne hors du mode de travail actif « ${modeId} » — elle n'y est pas remplissable`
          : 'colonne inconnue dans cette vue' });
        continue;
      }

      const scDef = selectChoix[cle];
      if (scDef?.choix?.length) {
        const alias = session.effectiveWorkerConfig?.mcp?.aliasChoix?.[cle] || null;
        const r = resoudreChoix(brut, scDef, alias);
        if (!r.ok) {
          const attendus = scDef.choix.map(c => `${JSON.stringify(c.valeur)} (${c.label})`).join(', ');
          const aussi    = alias ? ` — ou l'un de ces mots : ${Object.keys(alias).join(', ')}` : '';
          ignorees.push({ _id: id, cle, raison: `valeur hors des choix de cette colonne — attendu : ${attendus}${aussi}` });
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
    const { modeId: modeEcriture, autorisees } = colonnesEcriture(session);

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

      const pretes = preparerValeurs(session, ligne.valeurs, id, ignorees, autorisees, modeEcriture);
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
    const { modeId: modeEcriture, autorisees } = colonnesEcriture(session);

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
      const pretes = preparerValeurs(session, champs, null, ignorees, autorisees, modeEcriture);
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

  // ── Verbe : anomalie (phase bêta) ───────────────────────────────────────────
  // Cf. le bandeau en tête de fichier. Écrit dans un journal, jamais dans la
  // grille — et n'émet DÉLIBÉRÉMENT aucun wsSend.
  function verbeAnomalie(args) {
    if (!rapportAnomalies) {
      return {
        erreur: 'Le rapport d\'anomalies est coupé sur ce Worker ("beta": { "rapportAnomalies": false } '
          + 'dans worker-config.json). Rien n\'a été consigné.',
        codeHttp: 409,
      };
    }

    // Volontairement sans exigence de canal ni de statut : consigner n'écrit rien
    // dans la grille, et une anomalie peut très bien se constater en simple
    // lecture. La refuser pour une question de canal reviendrait à perdre
    // l'information au moment précis où elle vaut le plus.
    const r = resoudre(args, false);
    if (r.erreur) return r;
    const { session } = r;

    const description = typeof args.description === 'string' ? args.description.trim() : '';
    if (!description) {
      return { erreur: 'args.description attendu : ce que tu as constaté, en clair.', codeHttp: 400 };
    }

    const entree = {
      horodatage:  new Date().toISOString(),
      gravite:     GRAVITES.includes(args.gravite) ? args.gravite : 'genante',
      sessionId:   session.sessionId,
      contextName: session.contextName,
      mode:        args.mode || session.activeMode || null,
      origine:     session.origin || 'xspro',
      canal:       session.canal  || 'api',
      description,
      // Ce sur quoi porte le constat : clés de colonnes, _id de lignes, valeurs
      // fautives. Libre de forme — c'est au développeur de le lire, pas au code.
      elements:    args.elements === undefined ? null : args.elements,
    };

    const fichier = fichierAnomalies(dataRoot);
    try {
      fs.mkdirSync(path.dirname(fichier), { recursive: true });
      fs.appendFileSync(fichier, JSON.stringify(entree) + '\n', 'utf-8');
    } catch (e) {
      return { erreur: `Journal d'anomalies inaccessible : ${e.message}`, codeHttp: 500 };
    }

    console.log(`[MCP] Anomalie consignée (${entree.gravite}) — ${session.contextName} : ${description.slice(0, 120)}`);

    // On rend la phrase exacte à reprendre : Claude n'a pas à la retenir, et elle
    // reste ainsi identique d'une session à l'autre.
    return { consigne: true, journal: fichier, phraseARapporter: PHRASE_ANOMALIE };
  }

  // ── Verbe : terminer ────────────────────────────────────────────────────────
  // L'équivalent de onDone : statut PAUSED (= en attente de relecture humaine) et
  // re-rendu complet de la grille. `session.rows = updatedRows` de onDone est sans
  // objet ici, les écritures ont muté le tableau en place.
  function verbeTerminer(args) {
    const r = resoudre(args, true);
    if (r.erreur) return r;
    const { session } = r;

    // Conservé sur la session, et pas seulement poussé : quand Claude a rempli une
    // grille que personne n'avait ouverte — l'ergonomie même qu'on a voulue —
    // wsSend n'a aucun destinataire et le rapport se perdrait. C'est pourtant là
    // que se dit ce qui a été fait et ce qui reste à vérifier. L'init le rejoue à
    // l'ouverture, comme il rejoue les lignes (cf. server.js).
    session.dernierRapport = args.rapport || null;

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
    anomalie:  verbeAnomalie,
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

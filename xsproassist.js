/**
 * AI Worker — xsproassist.js
 * XSProAssist : le troisième canal de remplissage — un agent autonome, hébergé par le Worker.
 *
 * L'IA par clé API répond en un coup (llmClient.js). Claude, par le canal MCP, est un agent que
 * quelqu'un pilote depuis Claude Code (mcpChannel.js + mcpStdio.js). XSProAssist est ce même
 * agent — les MÊMES outils worker_*, le MÊME briefing que sert worker_contexte, les MÊMES verbes
 * et garde-fous de mcpChannel.js — mais autonome : il reçoit la demande tapée dans la grille,
 * dialogue avec un modèle « ordinaire » par appels d'outils (format chat completions, comme
 * XSpro/tools/xsproassist/assistant.js pour la salle d'attente), et clôt par worker_terminer.
 * Ses écritures sont des propositions, comme celles des deux autres canaux : l'utilisateur relit
 * dans la grille et livre lui-même. Aucun chemin d'ici ne touche deliverResult.
 *
 * Le modèle est celui du bloc `ia` de la session — la clé que XSpro a prêtée, ou celle de
 * standalone/ia-config.json. Un modèle qui ne sait pas appeler d'outils est dit tel quel, dans le
 * fil de la grille : pas de repli silencieux sur la clé API.
 *
 * Chaque traitement tient un journal (journalTraitement.js, la même forme que pour la clé API)
 * — appels au modèle, appels d'outils et refus, relances, conclusion et durée — poussé en direct
 * vers la grille (journal:etape) et rejoué à l'ouverture. C'est ce qui permet de comparer ce
 * canal à la clé API sur des faits (scripts/comparer-canaux.js).
 *
 * Ce module ne connaît ni Express ni la WebSocket : tout lui est donné (creerAssistant), et un
 * test le fait tourner avec un faux modèle (scripts/test-xsproassist.js). Il vit à la RACINE
 * pour la même raison que mcpStdio.js : `pkg` ne suit que le graphe de require de server.js.
 */

'use strict';

const Journal = require('./journalTraitement');

const CANAL = 'assist';
const NOM   = 'XSProAssist';

// Un remplissage demande plus d'allers-retours qu'une déclaration de la salle d'attente (8 tours
// dans XSpro) : relire une page de lignes, écrire un lot, corriger ce qui a été écarté, conclure.
const MAX_TOURS             = 12;
const MAX_RELANCES          = 2;
const TAILLE_RESULTAT_OUTIL = 30000;   // au-delà, un résultat d'outil est tronqué avant d'aller au modèle
const LIGNES_CONTEXTE       = 200;     // lignes servies d'emblée ; la suite par worker_contexte
const MAX_TOKENS            = 4096;    // un tour = des appels d'outils, ou un rapport : jamais un tableau entier

// Les outils que le modèle reçoit — worker_sessions n'en est pas : la session est imposée.
// `description` remplace celle de la façade quand elle parle à un client MCP qui ouvre lui-même
// la session ; ici le briefing est déjà dans la consigne système.
const OUTILS_DU_MODELE = {
  worker_contexte: {
    description:
      'Relit les lignes de la grille, avec leur _id et les propositions déjà en attente — les '
    + 'lignes suivantes (offset, limite), ou l\'état après tes écritures. Les colonnes et le '
    + 'briefing te sont déjà donnés : cet outil ne les répète pas.',
  },
  worker_ecrire_cellules:   {},
  worker_inserer_lignes:    {},
  worker_supprimer_lignes:  {},
  worker_terminer:          {},
  worker_signaler_anomalie: { beta: true },
};

const OUTILS_ECRITURE = new Set(['worker_ecrire_cellules', 'worker_inserer_lignes', 'worker_supprimer_lignes']);

// ── L'historique d'une session ────────────────────────────────────────────────
// Aucun modèle ne se souvient de rien : la clé API rejoue ses tours (llmTurns) devant chaque
// demande, et XSProAssist fait de même — la demande passée et ce qu'il en a fait (les lignes
// écrites, son rapport), jamais le détail des appels d'outils. La limite est celle que la vue
// déclare pour la clé API (historique.limite en tours, cf. views/README-prompts_1.md §7bis),
// 15 tours à défaut ; « Nouvelle tâche » et « Reset » l'effacent (server.js, sessionManager.js).
const HISTORIQUE_TOURS_DEFAUT = 15;
const HISTORIQUE_MAX          = 50;     // ce qui est gardé sur la session, au-delà de la limite rejouée

function limiteHistorique(session) {
  const l = session.promptPolicy && session.promptPolicy.historique && session.promptPolicy.historique.limite;
  return l && l.type === 'tours' && Number.isFinite(l.valeur) ? Math.max(0, l.valeur) : HISTORIQUE_TOURS_DEFAUT;
}

function historiqueARejouer(session) {
  const tous   = Array.isArray(session.historiqueAssist) ? session.historiqueAssist : [];
  const limite = limiteHistorique(session);
  return limite ? tous.slice(-limite) : [];
}

function memoriser(session, entree) {
  if (!Array.isArray(session.historiqueAssist)) session.historiqueAssist = [];
  session.historiqueAssist.push(entree);
  if (session.historiqueAssist.length > HISTORIQUE_MAX) {
    session.historiqueAssist.splice(0, session.historiqueAssist.length - HISTORIQUE_MAX);
  }
}

/**
 * Les outils au format « chat completions », sans `sessionId` : il est imposé à chaque appel,
 * le modèle n'a pas à le connaître, et ne peut donc pas en inventer un autre.
 *
 * @param {Array}  OUTILS       — la liste de mcpStdio.js
 * @param {Object} [options]    — { anomalies: false } retire l'outil de la phase bêta
 */
function outilsPourModele(OUTILS, { anomalies = true } = {}) {
  return OUTILS
    .filter((o) => OUTILS_DU_MODELE[o.name] && (anomalies || !OUTILS_DU_MODELE[o.name].beta))
    .map((o) => {
      const schema = o.inputSchema || { type: 'object', properties: {} };
      const properties = { ...(schema.properties || {}) };
      delete properties.sessionId;
      const required = (schema.required || []).filter((r) => r !== 'sessionId');
      const parameters = { ...schema, properties };
      if (required.length) parameters.required = required; else delete parameters.required;
      return {
        type: 'function',
        function: {
          name:        o.name,
          description: OUTILS_DU_MODELE[o.name].description || o.description,
          parameters,
        },
      };
    });
}

/**
 * Ce qu'on dit au modèle : qui il est, comment il répond, puis le briefing de la vue — le même
 * texte que worker_contexte sert à Claude (mission, règles, exemple, correspondance des outils,
 * et la consigne de la phase bêta si elle est active).
 */
function consigneSysteme(contextName, briefing) {
  return [
    `Tu es ${NOM}, l'assistant de XSpro qui pré-remplit la grille « ${contextName} » du AI Worker.`,
    'L\'utilisateur a écrit une demande dans la grille ; tu la réalises UNIQUEMENT par appels d\'outils,',
    'et tu termines TOUJOURS par worker_terminer, dont le « rapport » est ton seul message à',
    'l\'utilisateur : ce que tu as fait, les choix faits, ce qu\'il doit vérifier.',
    '',
    'Tes écritures sont des PROPOSITIONS : l\'utilisateur les valide ou les rejette une à une dans la',
    'grille, et lui seul renvoie le résultat à XSpro. Rien ne part sans lui.',
    '',
    'Le contexte t\'est donné avec la demande : les colonnes du mode de travail (type, valeurs',
    'admises), les lignes avec leur _id, les informations de l\'affaire. worker_contexte relit les',
    'lignes — les suivantes, ou l\'état après une écriture.',
    '',
    'Règles :',
    '- Les lignes se désignent par leur _id, jamais par leur position.',
    '- Un seul appel pour tout un lot ; ne poser que les champs que tu changes ; une colonne à choix',
    '  reçoit une de ses « valeur » (son « label » est accepté aussi).',
    '- Ne jamais inventer une valeur : ce que ni la demande ni les données ne donnent reste vide.',
    '- Un outil rapporte ce qu\'il a écarté (« ignorees ») et pourquoi : corrige, puis rappelle-le.',
    '- Une demande impossible, ambiguë ou hors de ta portée : n\'écris rien, et dis pourquoi dans le',
    '  rapport de worker_terminer.',
    '',
    'Consignes de la vue :',
    briefing || '(aucune consigne propre à cette vue)',
  ].join('\n');
}

/**
 * Le message de l'utilisateur : sa demande, puis le contexte en JSON — ce que worker_contexte
 * rend, moins le briefing (déjà dans la consigne système).
 */
function texteDemande(contexte, demande) {
  const { briefing, briefingSource, ...reste } = contexte || {};
  return [
    `Demande de l'utilisateur : « ${demande || '(aucun texte — voir les fichiers joints)'} »`,
    '',
    'Contexte (JSON) :',
    JSON.stringify(reste),
  ].join('\n');
}

function borner(texte) {
  return texte.length > TAILLE_RESULTAT_OUTIL ? texte.slice(0, TAILLE_RESULTAT_OUTIL) + '\n[… résultat tronqué]' : texte;
}

function argumentsDe(appel) {
  const brut = appel && appel.function ? appel.function.arguments : null;
  if (brut === undefined || brut === null || brut === '') return {};
  if (typeof brut === 'object') return brut;
  try { return JSON.parse(brut); } catch (e) { return { __illisible: String(e.message) }; }
}

// Une ligne par appel d'outil, pour le journal — ce qui a été fait, en chiffres.
function resumeOutil(nom, args, r) {
  const ecartees = Array.isArray(r.ignorees) && r.ignorees.length ? `, ${r.ignorees.length} valeur(s) écartée(s)` : '';
  switch (nom) {
    case 'worker_ecrire_cellules':   return `${r.cellulesEcrites || 0} cellule(s) dans ${(r.lignesTouchees || []).length} ligne(s)${ecartees}`;
    case 'worker_inserer_lignes':    return `${(r.ids || []).length} ligne(s) insérée(s)${ecartees}`;
    case 'worker_supprimer_lignes':  return `${r.marquees || 0} ligne(s) marquée(s) à supprimer${ecartees}`;
    case 'worker_terminer':          return args && args.rapport ? 'rapport remis' : 'sans rapport';
    case 'worker_contexte':          return `${(r.lignes || []).length} ligne(s) relue(s)`;
    case 'worker_signaler_anomalie': return 'anomalie consignée';
    default:                         return 'ok';
  }
}

// Le journal est aussi la trace « dernier envoi » de la grille, qui affiche des messages texte :
// un appel d'outil et son résultat y deviennent lisibles.
function transcriptionLisible(messages) {
  return messages.map((m) => {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      const appels = m.tool_calls.map((a) => `${a.function && a.function.name}(${typeof a.function.arguments === 'string' ? a.function.arguments : JSON.stringify(a.function.arguments)})`);
      return { role: m.role, content: [m.content, ...appels.map((a) => `[appel d'outil] ${a}`)].filter(Boolean).join('\n') };
    }
    if (m.role === 'tool') return { role: m.role, content: `[résultat de ${m.name}] ${m.content}` };
    if (Array.isArray(m.content)) {
      return { role: m.role, content: m.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n') };
    }
    return { role: m.role, content: m.content };
  });
}

/**
 * L'appel HTTP au modèle, au format chat completions avec outils — le même corps que XSpro
 * envoie pour son propre XSProAssist. Distinct de llmClient.callLLM, qui ne rend qu'un texte et
 * impose le mode JSON : ici c'est le message entier qu'il faut, appels d'outils compris.
 *
 * @returns {{ ok: true, message, finish_reason, modele, usage } | { ok: false, status?, error, cause?, modele }}
 */
async function appelerModeleHttp({ ia, messages, tools }) {
  const modele = (ia && ia.model) || null;
  if (!ia || !ia.endpoint || !ia.apiKey) {
    return { ok: false, error: 'aucune clé API pour cette session (bloc « ia » vide)', cause: 'auth', modele };
  }
  // Même délai que le mode ACT de la clé API : un tour peut relire et écrire beaucoup.
  const timeoutMs  = Math.max((ia.timeoutMs || 30000) * 4, 120000);
  const controller = new AbortController();
  const minuteur   = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(ia.endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ia.apiKey}` },
      body:    JSON.stringify({ model: ia.model, messages, tools, tool_choice: 'auto', temperature: 0.2, max_tokens: MAX_TOKENS }),
      signal:  controller.signal,
    });
    const texte = await response.text();
    let json = null;
    try { json = texte ? JSON.parse(texte) : null; } catch (_) { /* pas du JSON */ }
    if (!response.ok) {
      const detail = (json && json.error && (json.error.message || json.error)) || texte.slice(0, 300);
      return { ok: false, status: response.status, error: `HTTP ${response.status} — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}`, modele };
    }
    const choix = json && json.choices && json.choices[0];
    if (!choix || !choix.message) return { ok: false, status: response.status, error: 'réponse sans message', modele };
    return { ok: true, message: choix.message, finish_reason: choix.finish_reason || null, modele, usage: json.usage || null };
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, error: `délai dépassé (${timeoutMs / 1000} s)`, cause: 'timeout', modele };
    const detail = e && e.cause ? ` (${e.cause.code || e.cause.message})` : '';
    return { ok: false, error: `erreur réseau : ${e && e.message}${detail}`, cause: 'network', modele };
  } finally {
    clearTimeout(minuteur);
  }
}

/**
 * @param {Object}   deps
 * @param {Object}   deps.SM             sessionManager.js
 * @param {Object}   deps.verbes         la table des verbes de mcpChannel.js (installMcpChannel)
 * @param {Array}    deps.outils         la liste OUTILS de mcpStdio.js
 * @param {function} deps.wsSend         (session, message) → pousse vers la grille
 * @param {function} [deps.appelerModele]  async ({ ia, messages, tools }) — appelerModeleHttp par défaut
 * @param {function} [deps.contenuUtilisateur] async (texte, files, providerId) — llmClient.buildUserContent
 * @param {function} [deps.providerDe]   (ia) → id du provider, pour router les fichiers joints
 * @param {boolean}  [deps.rapportAnomalies]  la phase bêta (worker_signaler_anomalie)
 * @param {function} [deps.journal]      une ligne de journal (console)
 * @param {function} [deps.maintenant]   l'horloge (les tests la remplacent)
 */
function creerAssistant({ SM, verbes, outils, wsSend, appelerModele = appelerModeleHttp, contenuUtilisateur = null,
                          providerDe = null, rapportAnomalies = true, journal = () => {}, maintenant = Date.now }) {
  const tools = outilsPourModele(outils, { anomalies: rapportAnomalies });
  const verbeDe = new Map(outils.filter((o) => OUTILS_DU_MODELE[o.name]).map((o) => [o.name, o.verbe]));
  const nomsOutils = tools.map((t) => t.function.name);

  const contenu = async (texte, files, ia) => {
    if (!files || !files.length || !contenuUtilisateur) return texte;
    const providerId = providerDe ? providerDe(ia) : 'openai';
    return contenuUtilisateur(texte, files, providerId);
  };

  // Un appel d'outil du modèle, exécuté par le verbe du canal — avec la session imposée, et le
  // briefing jamais redemandé (il est dans la consigne système). Le verbe applique ses propres
  // garde-fous (canal de la session, statut, mode de travail, colonnes) : l'assistant ne peut
  // rien de plus qu'un client MCP.
  async function executer(nom, args, session) {
    const verbe = verbeDe.get(nom);
    if (!verbe || !nomsOutils.includes(nom)) {
      return { erreur: `outil « ${nom} » inconnu — outils : ${nomsOutils.join(', ')}` };
    }
    const imposes = { ...args, sessionId: session.sessionId };
    if (nom === 'worker_contexte') imposes.briefing = false;
    if (nom === 'worker_contexte' && imposes.limite === undefined) imposes.limite = LIGNES_CONTEXTE;
    try {
      return await verbes[verbe](imposes, CANAL);
    } catch (e) {
      return { erreur: `erreur interne de ${nom} : ${e && e.message}` };
    }
  }

  /**
   * Traite une demande sur une session dont le canal est `assist`. Le statut est celui de
   * l'appelant (ACTING pendant, cf. server.js) ; ici on écrit par les verbes et on conclut.
   *
   * @returns {{ issue: 'terminee'|'sansConclusion'|'injoignable'|'erreur', conclu: boolean, motif?, mesures, modele, rapport? }}
   *   `conclu` : worker_terminer a été appelé (act:done est parti vers la grille).
   */
  async function traiter(session, { demande = '', files = [], activeMode = null } = {}) {
    const j = Journal.ouvrir(session,
      { canal: CANAL, modele: (session.ia && session.ia.model) || null, modeTravail: activeMode || session.activeMode || null, demande },
      { notifier: (ligne) => wsSend(session, { type: 'journal:etape', etape: ligne }), maintenant });
    const etape = j.etape;
    const mesures = { tours: 0, appelsOutils: 0, refusOutils: 0, relances: 0, cellulesEcrites: 0, inserees: 0, supprimees: 0 };
    let modele = j.journal.modele;
    let messages = [];
    let rapport = null;
    let ecritures = false;
    const idsInseres = [];

    const conclure = (issue, motif = null, extra = {}) => {
      const fin = j.fin(issue, motif, { ...mesures, cellules: mesures.cellulesEcrites });
      // Ce qui entre dans l'historique : un traitement conclu, ou qui a écrit — pas un échec
      // sans suite, qui n'apprendrait rien au tour suivant.
      if (issue === 'terminee' || (issue === 'sansConclusion' && ecritures)) {
        const fait = [];
        if (mesures.cellulesEcrites) fait.push(`${mesures.cellulesEcrites} cellule(s) écrite(s)`);
        if (mesures.inserees)        fait.push(`${mesures.inserees} ligne(s) insérée(s)${idsInseres.length ? ` (_id ${idsInseres.join(', ')})` : ''}`);
        if (mesures.supprimees)      fait.push(`${mesures.supprimees} ligne(s) marquée(s) à supprimer`);
        memoriser(session, {
          demande:    String(demande || '').slice(0, 1000),
          reponse:    [fait.length ? `Fait : ${fait.join(', ')}.` : 'Rien n\'a été écrit.', rapport || ''].filter(Boolean).join('\n'),
          horodatage: maintenant(),
        });
      }
      session.dernierEnvoi = {
        messages:   transcriptionLisible(messages),
        reponse:    rapport || motif || '',
        modele,
        mode:       CANAL,
        horodatage: maintenant(),
      };
      journal(`${session.sessionId} : ${issue}${motif ? ` — ${motif}` : ''} (${fin.dureeMs} ms, ${mesures.tours} tour(s), ${mesures.appelsOutils} outil(s))`);
      return { issue, motif, mesures, modele, rapport, ...extra };
    };

    // 1. Le contexte, par le même verbe que Claude — briefing compris.
    const ctx = await verbes.contexte({ sessionId: session.sessionId, ...(activeMode ? { mode: activeMode } : {}), limite: LIGNES_CONTEXTE }, CANAL);
    if (!ctx || ctx.erreur) {
      etape({ evenement: 'debut', modele });
      return conclure('erreur', `contexte impossible : ${(ctx && ctx.erreur) || 'sans réponse'}`, { conclu: false });
    }
    j.journal.modeTravail = ctx.modeApplique || j.journal.modeTravail;
    const rejoues = historiqueARejouer(session);
    etape({ evenement: 'debut', modele, modeTravail: ctx.modeApplique || null, lignes: ctx.pagination ? ctx.pagination.total : (ctx.lignes || []).length,
            briefingSource: ctx.briefingSource || null, historises: rejoues.length * 2 });

    // La consigne, l'historique rejoué comme un dialogue (cf. historiqueARejouer), la demande.
    const systeme = consigneSysteme(session.contextName, ctx.briefing);
    messages = [
      { role: 'system', content: systeme },
      ...rejoues.flatMap((h) => [
        { role: 'user',      content: `Demande précédente : « ${h.demande} »` },
        { role: 'assistant', content: h.reponse },
      ]),
      { role: 'user',   content: await contenu(texteDemande(ctx, demande), files, session.ia) },
    ];

    let relances = 0;
    let dernierRefus = null;

    for (let tour = 1; tour <= MAX_TOURS; tour++) {
      const debutAppel  = maintenant();
      const tailleEnvoi = JSON.stringify(messages).length;
      const r = await appelerModele({ ia: session.ia, messages, tools });
      mesures.tours = tour;
      const appels = r && r.ok && r.message && Array.isArray(r.message.tool_calls) ? r.message.tool_calls : [];
      const jetons = r && r.usage && Number(r.usage.total_tokens) ? Number(r.usage.total_tokens) : null;
      etape({ evenement: 'modele', tour, dureeMs: maintenant() - debutAppel, ok: !!(r && r.ok), appels: appels.length, tailleEnvoi,
              ...(r && r.ok && r.message ? { tailleReponse: JSON.stringify(r.message).length } : {}),
              ...(jetons ? { jetons } : {}),
              ...(r && r.status !== undefined ? { status: r.status } : {}),
              ...(r && r.finish_reason ? { finish_reason: r.finish_reason } : {}) });

      if (!r || !r.ok) {
        modele = (r && r.modele) || modele;
        j.modele(modele);
        const detail = (r && (r.error || r.status)) || 'sans réponse';
        const motif = r && r.status === 400
          ? `le modèle ${modele || ''} a refusé la requête avec outils (${detail}). S'il ne sait pas appeler d'outils, ${NOM} ne peut pas travailler avec lui : basculer « Remplissage » sur « Clé API », ou changer de modèle.`
          : `modèle injoignable : ${detail}`;
        return conclure('injoignable', motif, { conclu: false, status: r && r.status, cause: (r && r.cause) || (r && r.status === 400 ? 'bad_request' : 'http_error') });
      }

      modele = r.modele || modele;
      j.modele(modele);
      const message = r.message || {};
      messages.push({ role: 'assistant', content: typeof message.content === 'string' ? message.content : (message.content ? JSON.stringify(message.content) : ''),
                      ...(appels.length ? { tool_calls: appels } : {}) });

      if (!appels.length) {
        // Le modèle parle au lieu d'agir : une relance qui rappelle le dernier refus, deux fois au
        // plus, puis on note qu'il n'a pas conclu.
        if (relances < MAX_RELANCES) {
          relances++;
          mesures.relances++;
          etape({ evenement: 'relance' });
          messages.push({ role: 'user', content: [
            'Ne réponds pas par du texte : agis par un appel d\'outil.',
            dernierRefus ? `Le dernier appel de ${dernierRefus.nom} a été refusé : « ${dernierRefus.message} ». Fais ce que ce message demande, puis rappelle l'outil.` : '',
            'Quand tu as fini, ou si la demande ne peut pas être satisfaite, appelle worker_terminer avec ton rapport.',
          ].filter(Boolean).join(' ') });
          continue;
        }
        break;
      }

      for (const appel of appels) {
        const nom  = appel.function && appel.function.name;
        const args = argumentsDe(appel);
        const resultat = args.__illisible
          ? { erreur: `arguments JSON illisibles : ${args.__illisible}` }
          : await executer(nom, args, session);
        const ok = !(resultat && resultat.erreur);
        mesures.appelsOutils++;
        if (!ok) {
          mesures.refusOutils++;
          dernierRefus = { nom, message: String(resultat.erreur).slice(0, 300) };
        } else {
          if (nom === 'worker_ecrire_cellules')  mesures.cellulesEcrites += Number(resultat.cellulesEcrites) || 0;
          if (nom === 'worker_inserer_lignes')   { mesures.inserees += (resultat.ids || []).length; idsInseres.push(...(resultat.ids || [])); }
          if (nom === 'worker_supprimer_lignes') mesures.supprimees      += Number(resultat.marquees) || 0;
          if (OUTILS_ECRITURE.has(nom) && (mesures.cellulesEcrites || mesures.inserees || mesures.supprimees)) ecritures = true;
        }
        etape({ evenement: 'outil', nom, ok, resume: ok ? resumeOutil(nom, args, resultat) : null, ...(ok ? {} : { erreur: String(resultat.erreur).slice(0, 300) }) });
        journal(`${session.sessionId} : ${nom} → ${ok ? resumeOutil(nom, args, resultat) : `refus : ${String(resultat.erreur).slice(0, 120)}`}`);
        messages.push({ role: 'tool', tool_call_id: appel.id, name: nom, content: borner(JSON.stringify(ok ? resultat : { erreur: resultat.erreur })) });

        if (ok && nom === 'worker_terminer') {
          rapport = args.rapport || null;
          return conclure('terminee', null, { conclu: true });
        }
      }
    }

    // Sans conclusion : le modèle n'a jamais appelé worker_terminer. S'il a écrit, la grille
    // porte ses propositions : on clôt à sa place, en le disant, pour que l'utilisateur les
    // relise avec un rapport honnête. Sinon, rien n'a changé et c'est un échec à annoncer.
    const dernier = [...messages].reverse().find((m) => m.role === 'assistant' && m.content);
    const motif = `${NOM} n'a pas conclu${dernier ? ` : ${String(dernier.content).slice(0, 200)}` : ''}`;
    if (ecritures) {
      rapport = `⚠ ${motif}\nLes propositions déjà posées dans la grille restent à relire.`;
      const fin = await verbes.terminer({ sessionId: session.sessionId, rapport }, CANAL);
      const conclu = !(fin && fin.erreur);
      return conclure('sansConclusion', motif, { conclu });
    }
    return conclure('sansConclusion', motif, { conclu: false });
  }

  return { traiter, tools, consigneSysteme, CANAL, NOM };
}

module.exports = {
  creerAssistant, appelerModeleHttp, outilsPourModele, consigneSysteme, texteDemande, transcriptionLisible,
  historiqueARejouer, limiteHistorique,
  CANAL, NOM, MAX_TOURS, MAX_RELANCES, LIGNES_CONTEXTE, HISTORIQUE_TOURS_DEFAUT,
};

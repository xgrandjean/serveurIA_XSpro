/**
 * AI Worker — scripts/test-mcpWorker.js
 *
 * Vérifie le canal MCP sans client MCP : on parle à la façade
 * (tools/mcp-worker/server.js) en JSON-RPC sur son entrée standard, exactement
 * comme le ferait Claude.
 *
 * Trois choses comptent ici :
 *   - le protocole est respecté (sinon le client refuse le serveur en bloc) ;
 *   - stdout ne contient QUE des messages JSON-RPC — une seule ligne parasite
 *     et le client considère la sortie comme corrompue ;
 *   - les garde-fous du canal tiennent (mcpChannel.js) : une page web ne doit
 *     pas pouvoir écrire dans la grille de l'utilisateur.
 *
 *   node scripts/test-mcpWorker.js          protocole + garde-fous
 *   node scripts/test-mcpWorker.js --e2e    + un aller-retour complet sur une
 *                                           vraie session (lance un Worker au
 *                                           besoin, n'ouvre aucun navigateur)
 */

'use strict';

const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');
const http      = require('http');

const RACINE  = path.join(__dirname, '..');
const FACADE  = path.join(RACINE, 'tools', 'mcp-worker', 'server.js');
const PAYLOAD = path.join(RACINE, 'standalone', 'standalone-payload-detailsDevis.json');
// Mémoire du dernier canal choisi (cf. server.js). Le harnais la manipule, donc
// il la restaure — même nom de fichier, même dossier de données.
const CANAL_FILE = path.join(RACINE, '.worker-canal.json');
const E2E     = process.argv.includes('--e2e');

let PORT = 8888;
try { PORT = JSON.parse(fs.readFileSync(path.join(RACINE, 'worker-config.json'), 'utf8')).port || 8888; } catch (_) {}

let reussis = 0;
let echoues = 0;

function verifier(nom, condition, detail) {
    if (condition) { reussis++; console.log('  PASS  ' + nom); }
    else { echoues++; console.log('  FAIL  ' + nom + (detail ? '  → ' + String(detail).slice(0, 300) : '')); }
}

function titre(t) { console.log(''); console.log(t); }

// ── Client de la façade ───────────────────────────────────────────────────────
// La façade reste ouverte entre les appels : l'aller-retour complet a besoin du
// résultat d'un outil pour composer l'appel suivant.
function ouvrirFacade() {
    const proc = spawn(process.execPath, [FACADE], { stdio: ['pipe', 'pipe', 'pipe'] });
    const etat = { illisibles: 0, reponses: [], stderr: '' };
    const enAttente = new Map();
    let tampon = '';
    let prochainId = 1;

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (bloc) => {
        tampon += bloc;
        let i;
        while ((i = tampon.indexOf('\n')) !== -1) {
            const ligne = tampon.slice(0, i).trim();
            tampon = tampon.slice(i + 1);
            if (!ligne) continue;
            let m;
            try { m = JSON.parse(ligne); } catch (_) { etat.illisibles++; continue; }
            etat.reponses.push(m);
            const resoudre = enAttente.get(m.id);
            if (resoudre) { enAttente.delete(m.id); resoudre(m); }
        }
    });
    proc.stderr.on('data', (d) => { etat.stderr += d; });

    function notifier(method, params) {
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    }
    function appeler(method, params) {
        const id = prochainId++;
        return new Promise((resolve, reject) => {
            const minuteur = setTimeout(() => reject(new Error('pas de réponse à ' + method)), 25000);
            enAttente.set(id, (m) => { clearTimeout(minuteur); resolve(m); });
            proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
    }
    function outil(nom, args) { return appeler('tools/call', { name: nom, arguments: args || {} }); }
    function fermer() { try { proc.stdin.end(); proc.kill(); } catch (_) {} }

    return { etat, notifier, appeler, outil, fermer };
}

// Le contenu utile d'un tools/call : la façade renvoie du texte, qui est du JSON
// quand le canal a répondu.
function donnees(rep) {
    const t = rep && rep.result && rep.result.content && rep.result.content[0]
        ? rep.result.content[0].text : '';
    try { return JSON.parse(t); } catch (_) { return null; }
}
function texte(rep) {
    return rep && rep.result && rep.result.content && rep.result.content[0]
        ? rep.result.content[0].text : '';
}

// ── Appels HTTP directs (garde-fous) ──────────────────────────────────────────
function requete(options, corps) {
    return new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: PORT, ...options }, (res) => {
            let d = '';
            res.on('data', (c) => { d += c; });
            res.on('end', () => resolve({ code: res.statusCode, entetes: res.headers, corps: d }));
        });
        req.setTimeout(5000, () => { req.destroy(); resolve({ code: 0 }); });
        req.on('error', (e) => resolve({ code: 0, erreur: e.code }));
        if (corps) req.write(corps);
        req.end();
    });
}

function workerJoignable() {
    return requete({ method: 'HEAD', path: '/view-config/' }).then((r) => r.code === 200);
}

function attendre(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ══════════════════════════════════════════════════════════════════════════════
(async () => {
    console.log('Façade testée : ' + path.relative(process.cwd(), FACADE));

    // ── Phase 1 — protocole ──────────────────────────────────────────────────
    titre('Protocole');
    const f = ouvrirFacade();

    const init = await f.appeler('initialize', {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' },
    });
    f.notifier('notifications/initialized');
    const liste    = await f.appeler('tools/list');
    const pong     = await f.appeler('ping');
    const inconnu  = await f.appeler('tools/call', { name: 'outil_qui_nexiste_pas', arguments: {} });
    const methode  = await f.appeler('methode/inconnue');

    verifier('stdout ne contient que du JSON-RPC', f.etat.illisibles === 0,
        f.etat.illisibles + ' ligne(s) illisible(s)');
    verifier('initialize annonce la capacité « tools »',
        !!(init.result && init.result.capabilities && init.result.capabilities.tools),
        JSON.stringify(init.result));
    verifier('initialize reprend la version demandée par le client',
        init.result && init.result.protocolVersion === '2024-11-05',
        init.result && String(init.result.protocolVersion));
    verifier('le serveur se nomme',
        !!(init.result && init.result.serverInfo && init.result.serverInfo.name === 'ai-worker'),
        init.result && JSON.stringify(init.result.serverInfo));
    verifier('la notification « initialized » ne reçoit AUCUNE réponse',
        !f.etat.reponses.some((x) => x.id === undefined || x.id === null),
        JSON.stringify(f.etat.reponses.filter((x) => x.id === undefined || x.id === null)));

    const outils = (liste.result && liste.result.tools) || [];
    verifier('tools/list renvoie des outils', outils.length === 7, 'n=' + outils.length);
    verifier('chaque outil a un nom, une description et un schéma',
        outils.every((o) => o.name && o.description && o.inputSchema),
        outils.filter((o) => !(o.name && o.description && o.inputSchema)).map((o) => o.name).join(','));
    verifier('les noms sont tous préfixés « worker_ »',
        outils.every((o) => /^worker_/.test(o.name)),
        outils.map((o) => o.name).filter((n) => !/^worker_/.test(n)).join(','));

    // Ce que le modèle lit avant de décider d'appeler : les outils qui touchent la
    // grille doivent dire qu'ils n'envoient rien à XSpro, sans quoi un modèle
    // prudent hésitera — ou pire, un modèle pressé croira avoir livré.
    const ecriture = outils.filter((o) => /ecrire|inserer|supprimer|terminer/.test(o.name));
    verifier('les outils qui touchent la grille annoncent que rien ne part vers XSpro',
        ecriture.length === 4 && ecriture.every((o) => /XSpro/.test(o.description)),
        ecriture.filter((o) => !/XSpro/.test(o.description)).map((o) => o.name).join(','));
    const ecrireCellules = outils.find((o) => o.name === 'worker_ecrire_cellules');
    verifier('« écrire » annonce que c\'est une proposition soumise à l\'utilisateur',
        !!(ecrireCellules && /PROPOSITION/.test(ecrireCellules.description)),
        ecrireCellules ? 'description sans mention' : 'outil absent');
    const anomalie = outils.find((o) => o.name === 'worker_signaler_anomalie');
    verifier('« signaler une anomalie » annonce qu\'il n\'écrit rien dans la grille',
        !!(anomalie && /BÊTA/.test(anomalie.description) && /RIEN dans la grille/.test(anomalie.description)),
        anomalie ? 'description sans mention' : 'outil absent');

    const contexte = outils.find((o) => o.name === 'worker_contexte');
    verifier('« contexte » renvoie vers le briefing avant d\'écrire',
        !!(contexte && /BRIEFING/.test(contexte.description)),
        contexte ? 'description sans mention' : 'outil absent');

    verifier('ping répond', !!(pong.result));
    verifier('un outil inconnu est refusé proprement',
        !!(inconnu.error && /inconnu/i.test(inconnu.error.message)), JSON.stringify(inconnu));
    verifier('une méthode non gérée renvoie une erreur JSON-RPC',
        !!(methode.error && methode.error.code === -32601), JSON.stringify(methode));

    // ── Worker éteint : le message doit donner le geste ───────────────────────
    const joignable = await workerJoignable();
    if (!joignable) {
        titre('Quand le Worker est éteint');
        const rep = await f.outil('worker_sessions', {});
        const t   = texte(rep);
        verifier('l\'appel répond au lieu de planter', !!rep.result, JSON.stringify(rep));
        verifier('le message explique le geste à faire (npm start)',
            /npm start/.test(t), JSON.stringify(t).slice(0, 200));
        verifier('le message ne montre pas un code réseau brut',
            !/^ECONNREFUSED/.test(t.trim()), JSON.stringify(t).slice(0, 120));
        verifier('l\'appel est marqué comme une erreur', rep.result.isError === true, String(rep.result.isError));
    } else {
        console.log('  (un Worker tourne sur le port ' + PORT + ' : phase « éteint » sautée)');
    }
    f.fermer();

    // ── Phase 2 — garde-fous du canal ────────────────────────────────────────
    titre('Garde-fous du canal');
    if (!joignable) {
        console.log('  (Worker éteint : phase sautée — la relancer avec un Worker en marche)');
    } else {
        const corps = JSON.stringify({ verbe: 'sessions' });
        const base  = { method: 'POST', path: '/mcp/commande', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corps) } };

        const sansEntete = await requete(base, corps);
        verifier('sans l\'en-tête X-Worker-MCP → refusé', sansEntete.code === 403, 'HTTP ' + sansEntete.code);

        const avecOrigin = await requete({ ...base, headers: { ...base.headers, 'X-Worker-MCP': '1', Origin: 'https://exemple.test' } }, corps);
        verifier('avec une origine navigateur → refusé', avecOrigin.code === 403, 'HTTP ' + avecOrigin.code);

        // L'assertion qui protège d'une future réorganisation des middlewares : si
        // le canal passait APRÈS le CORS permissif de server.js, le préflight
        // répondrait 204 + Access-Control-Allow-Origin, et une page web pourrait
        // alors envoyer l'en-tête maison.
        const preflight = await requete({ method: 'OPTIONS', path: '/mcp/commande', headers: { Origin: 'https://exemple.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-worker-mcp' } });
        verifier('le préflight est refusé', preflight.code === 403, 'HTTP ' + preflight.code);
        verifier('le préflight ne porte AUCUN Access-Control-Allow-Origin',
            !preflight.entetes['access-control-allow-origin'],
            String(preflight.entetes && preflight.entetes['access-control-allow-origin']));

        // Témoin : le CORS permissif existe toujours pour les routes historiques.
        const temoin = await requete({ method: 'OPTIONS', path: '/process', headers: { Origin: 'https://exemple.test' } });
        verifier('témoin — /process garde son CORS permissif',
            temoin.entetes && temoin.entetes['access-control-allow-origin'] === '*',
            'HTTP ' + temoin.code);

        const bonEntete = await requete({ ...base, headers: { ...base.headers, 'X-Worker-MCP': '1' } }, corps);
        verifier('avec l\'en-tête et sans origine → accepté', bonEntete.code === 200, 'HTTP ' + bonEntete.code);

        const verbeInconnu = await requete({ ...base, headers: { ...base.headers, 'X-Worker-MCP': '1', 'Content-Length': Buffer.byteLength('{"verbe":"pirater"}') } }, '{"verbe":"pirater"}');
        verifier('un verbe hors liste blanche est refusé', verbeInconnu.code === 400, 'HTTP ' + verbeInconnu.code);
    }

    // ── Phase 3 — aller-retour complet ───────────────────────────────────────
    if (E2E) await allerRetour(joignable);

    // ── Phase 4 — branchement Claude (portées user + application de bureau) ──
    // claudeConfig.js travaillant sur des fichiers TEMPORAIRES uniquement, la
    // phase tourne toujours : aucun réglage réel du poste n'est touché.
    await verifierBranchementClaude();

    console.log('');
    console.log('Outils exposés : ' + outils.map((o) => o.name).join(', '));
    console.log('');
    console.log(reussis + ' PASS, ' + echoues + ' FAIL');
    process.exit(echoues === 0 ? 0 : 1);
})().catch((e) => {
    console.error('');
    console.error('Le harnais s\'est interrompu : ' + (e && e.message));
    process.exit(1);
});

// ══════════════════════════════════════════════════════════════════════════════
// Aller-retour complet sur une vraie session.
async function allerRetour(dejaJoignable) {
    titre('Aller-retour complet');

    // Un Worker déjà en marche fait autorité : le relancer échouerait sur le
    // verrou .worker.lock (sortie en code 0) ou sur le port déjà pris.
    let worker = null;
    if (!dejaJoignable) {
        worker = spawn(process.execPath, [path.join(RACINE, 'server.js')], {
            cwd: RACINE,
            // Aucun navigateur ne doit s'ouvrir : on passe par POST /process, pas
            // par --standalone (dont l'ouverture n'est pas conditionnelle).
            env: { ...process.env, AI_WORKER_DISABLE_AUTO_OPEN: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        for (let i = 0; i < 40 && !(await workerJoignable()); i++) await attendre(250);
        if (!(await workerJoignable())) {
            verifier('un Worker peut être lancé pour le test', false, 'injoignable après 10 s');
            try { worker.kill(); } catch (_) {}
            return;
        }
        console.log('  (Worker lancé pour le test)');
    } else {
        console.log('  (le Worker déjà en marche est réutilisé)');
    }

    const exportsAvant = listerExports();

    // Le test bascule le canal, ce qui écrit la mémoire du dernier choix de
    // l'utilisateur. On la rend telle qu'on l'a trouvée : un test ne doit pas
    // changer le réglage de qui le lance.
    const memoireAvant = (() => {
        try { return fs.readFileSync(CANAL_FILE, 'utf8'); } catch (_) { return null; }
    })();

    try {
        // 1. Une session, par le vrai point d'entrée de XSpro.
        const payload = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8'));
        delete payload._origin;
        payload.sessionId = 'detailsDevis_test_' + Date.now();
        const corpsP = JSON.stringify(payload);
        const rp = await requete({ method: 'POST', path: '/process', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpsP) } }, corpsP);
        verifier('POST /process accepte la session', rp.code === 200, 'HTTP ' + rp.code);

        const f = ouvrirFacade();
        await f.appeler('initialize', { protocolVersion: '2024-11-05', capabilities: {} });

        // 2. La session démarre sur le canal par défaut : l'écriture est refusée
        //    tant que l'utilisateur n'a pas choisi « Claude (MCP) ».
        const avant = donnees(await f.outil('worker_sessions', {}));
        const moi   = avant && avant.sessions.find((s) => s.sessionId === payload.sessionId);
        verifier('worker_sessions voit la session', !!moi, JSON.stringify(avant).slice(0, 200));
        verifier('worker_sessions rapporte ce que XSpro a demandé',
            !!(moi && moi.demandeXSpro), moi && String(moi.demandeXSpro));

        if (moi && moi.canal === 'api') {
            const refus = await f.outil('worker_ecrire_cellules', {
                sessionId: payload.sessionId, lignes: [{ _id: 1, valeurs: { designation: 'ne doit pas passer' } }],
            });
            verifier('en canal « clé API », l\'écriture est refusée',
                refus.result.isError === true && /Remplissage/.test(texte(refus)), texte(refus).slice(0, 160));
        }

        // 3. Bascule du canal — par le même message que le sélecteur de la grille.
        const ws = await connecterUI(payload.sessionId);
        verifier('l\'UI reçoit le canal dans « init »', ws.init && typeof ws.init.canal === 'string',
            ws.init && String(ws.init.canal));
        const bascule = await ws.basculer('mcp');
        verifier('la bascule de canal est confirmée par le serveur', bascule === 'mcp', String(bascule));

        // 4. Le contexte : colonnes du mode, lignes, consignes métier.
        const ctx = donnees(await f.outil('worker_contexte', { sessionId: payload.sessionId }));
        verifier('worker_contexte donne des colonnes', !!(ctx && ctx.colonnes && ctx.colonnes.length),
            ctx && JSON.stringify(ctx.colonnes));
        verifier('les colonnes à choix portent leurs valeurs admises',
            !!(ctx && ctx.colonnes.some((c) => Array.isArray(c.choix) && c.choix.length)),
            ctx && ctx.colonnes.map((c) => c.cle).join(','));
        verifier('les lignes portent un _id', !!(ctx && ctx.lignes.every((l) => l._id !== undefined)),
            ctx && JSON.stringify(ctx.lignes[0]));
        verifier('le briefing porte les consignes métier de la vue',
            !!(ctx && typeof ctx.briefing === 'string' && ctx.briefing.length > 1000
               && /== RÈGLES ==|== RÈGLES DE CONSTRUCTION/.test(ctx.briefing)),
            ctx && 'briefing = ' + (ctx.briefing ? ctx.briefing.length : 0) + ' caractères');

        // 4b. Non-régression du chemin clé API : worker_contexte emprunte
        //     buildPromptPreview en positionnant session.activeMode, puis le
        //     restaure. Si la restauration sautait, l'aperçu de l'UI — qui partage
        //     cette fonction — partirait sur le mauvais mode.
        const apercu = await ws.apercu('chiffrage');
        verifier('l\'aperçu de prompt de l\'UI répond toujours après un appel MCP',
            !!(apercu && apercu.system && apercu.full), JSON.stringify(apercu).slice(0, 160));

        // 4c. Le mode de travail suit le sélecteur de la grille. Sans le message
        //     WS 'workmode:set', un utilisateur qui bascule le mode en cours de
        //     session ne verrait JAMAIS son choix reflété — l'outil répondrait
        //     toujours le mode par défaut de la vue.
        const modesDispo = ((ctx && ctx.modesDisponibles) || []).map((m) => m.id);
        const modeVue    = ctx && ctx.modeApplique;
        const autre      = modesDispo.find((m) => m !== modeVue);
        if (autre) {
            // Repartir d'un serveur qui n'a rien reçu de la grille.
            await ws.changerMode(null);
            const retombe = donnees(await f.outil('worker_contexte', { sessionId: payload.sessionId, briefing: false }));
            verifier('sans choix de la grille, worker_contexte retombe sur le mode par défaut de la vue',
                !!(retombe && retombe.modeApplique === modeVue),
                retombe && String(retombe.modeApplique));

            // Un changement de sélecteur se reflète ensuite SANS que Claude le précise.
            await ws.changerMode(autre);
            const apresChange = donnees(await f.outil('worker_contexte', { sessionId: payload.sessionId, briefing: false }));
            verifier('le mode choisi dans la grille s\'applique sans que Claude le précise',
                !!(apresChange && apresChange.modeApplique === autre),
                apresChange && String(apresChange.modeApplique));

            // Équivalence de contenu : le mode de la grille sert exactement les
            // mêmes colonnes que ce mode demandé explicitement.
            const avecExplicite = donnees(await f.outil('worker_contexte', { sessionId: payload.sessionId, mode: autre, briefing: false }));
            verifier('le mode de la grille sert les mêmes colonnes que le mode demandé explicitement',
                !!(apresChange && avecExplicite
                    && JSON.stringify((apresChange.colonnes || []).map((c) => c.cle))
                       === JSON.stringify((avecExplicite.colonnes || []).map((c) => c.cle))),
                apresChange && (apresChange.colonnes || []).map((c) => c.cle).join(','));

            // Un mode explicite reste prioritaire sur le choix de la grille.
            const expliciteAutre = donnees(await f.outil('worker_contexte', { sessionId: payload.sessionId, mode: modeVue, briefing: false }));
            verifier('un mode explicite reste prioritaire sur le choix de la grille',
                !!(expliciteAutre && expliciteAutre.modeApplique === modeVue),
                expliciteAutre && String(expliciteAutre.modeApplique));

            // worker_sessions le rapporte, pour que Claude le voie d'emblée.
            const sessions2 = donnees(await f.outil('worker_sessions', {}));
            const moi2      = sessions2 && sessions2.sessions.find((x) => x.sessionId === payload.sessionId);
            verifier('worker_sessions expose le mode actif choisi dans la grille',
                !!(moi2 && moi2.modeActif === autre),
                moi2 && String(moi2.modeActif));

            // Les écritures respectent le mode : une colonne du mode par défaut qui
            // n'est pas remplissable dans le mode actif est refusée ET rapportée.
            const horsMode = (ctx.colonnes || []).filter((c) => c.cle
                && !(apresChange.colonnes || []).some((c2) => c2.cle === c.cle));
            const cible = (apresChange.lignes || [])[0];
            if (horsMode.length && cible) {
                const cleTestee = horsMode[0].cle;
                const refuse = donnees(await f.outil('worker_ecrire_cellules', {
                    sessionId: payload.sessionId,
                    lignes: [{ _id: cible._id, valeurs: { [cleTestee]: 'x' } }],
                }));
                const ignoree = ((refuse && refuse.ignorees) || []).find((i) => i.cle === cleTestee);
                verifier('une colonne hors du mode actif est refusée ET rapportée',
                    !!ignoree, JSON.stringify(refuse && refuse.ignorees).slice(0, 200));
            }

            // Revenir à l'état « la grille n'a rien choisi » : les étapes suivantes
            // écrivent les colonnes du mode par défaut de la vue.
            await ws.changerMode(null);
        } else {
            console.log('  (vue à un seul mode : phase « mode » sautée)');
        }

        // 5. Insertion, puis écriture dans la ligne qu'on vient de créer.
        const ins = donnees(await f.outil('worker_inserer_lignes', {
            sessionId: payload.sessionId, apres: 'fin',
            lignes: [{ niveauListe: 3, designation: 'Ligne de test' }],
        }));
        verifier('worker_inserer_lignes rend les _id créés', !!(ins && ins.ids && ins.ids.length === 1),
            JSON.stringify(ins));
        const idNeuf = ins && ins.ids && ins.ids[0];

        const ecr = donnees(await f.outil('worker_ecrire_cellules', {
            sessionId: payload.sessionId,
            lignes: [
                { _id: 1, valeurs: { designation: 'Chapitre revu', colonneInexistante: 'x' } },
                { _id: idNeuf, valeurs: { quantiteTotale: '120', unite: 'ml' } },
                { _id: 99999, valeurs: { designation: 'ligne fantôme' } },
            ],
        }));
        verifier('worker_ecrire_cellules écrit dans plusieurs lignes d\'un coup',
            !!(ecr && ecr.cellulesEcrites === 3), JSON.stringify(ecr));
        verifier('une colonne inconnue est ignorée ET rapportée',
            !!(ecr && ecr.ignorees.some((i) => i.cle === 'colonneInexistante')), JSON.stringify(ecr && ecr.ignorees));
        verifier('un _id introuvable est ignoré ET rapporté',
            !!(ecr && ecr.ignorees.some((i) => i._id === 99999)), JSON.stringify(ecr && ecr.ignorees));

        // 6. Relecture : la valeur est posée, et typée comme à la saisie manuelle.
        const relu  = donnees(await f.outil('worker_contexte', { sessionId: payload.sessionId, briefing: false }));
        const neuve = relu && relu.lignes.find((l) => l._id === idNeuf);
        verifier('la valeur écrite est bien dans la session', !!(neuve && neuve.unite === 'ml'), JSON.stringify(neuve));
        verifier('"120" est stocké en NOMBRE, comme à la saisie manuelle',
            !!(neuve && neuve.quantiteTotale === 120), neuve && (typeof neuve.quantiteTotale + ' ' + neuve.quantiteTotale));
        verifier('les propositions en attente sont visibles', relu && relu.pendingCount > 0, relu && String(relu.pendingCount));

        // 7. L'UI a tout reçu en direct, sans rechargement.
        verifier('l\'UI a reçu les cellules en direct', ws.recus['cell:update'] >= 3, JSON.stringify(ws.recus));
        verifier('l\'UI a reçu la validation par ligne (l\'ambre « en attente »)',
            ws.recus['cell:validate'] >= 1, JSON.stringify(ws.recus));

        // 8. Suppression, puis fin de lot.
        const sup = donnees(await f.outil('worker_supprimer_lignes', { sessionId: payload.sessionId, ids: [2] }));
        verifier('worker_supprimer_lignes marque la ligne', !!(sup && sup.marquees === 1), JSON.stringify(sup));

        const fin = donnees(await f.outil('worker_terminer', {
            sessionId: payload.sessionId, rapport: 'Essai automatique.',
        }));
        verifier('worker_terminer met la session en attente de relecture',
            !!(fin && fin.etat === 'paused'), JSON.stringify(fin));
        await attendre(300);
        verifier('l\'UI a reçu la fin de lot', ws.recus['act:done'] >= 1, JSON.stringify(ws.recus));

        // Le rapport doit survivre à une grille restée fermée : c'est le scénario
        // même qu'on a voulu — Claude prépare, l'utilisateur découvre ensuite. Une
        // UI neuve doit le retrouver dans son 'init'.
        const ws2 = await connecterUI(payload.sessionId);
        verifier('le rapport est rejoué à l\'ouverture de la grille',
            !!(ws2.init && /Essai automatique/.test(ws2.init.rapport || '')),
            ws2.init && String(ws2.init.rapport));
        ws2.fermer();

        // 9. Le point capital : RIEN n'est parti.
        verifier('aucun export n\'a été produit — rien n\'est parti vers XSpro',
            listerExports().length === exportsAvant.length,
            'avant ' + exportsAvant.length + ', après ' + listerExports().length);

        // 10. Le rapport d'anomalies (phase bêta) : un journal pour le
        //     développeur, et RIEN dans la grille.
        const wsAvant = JSON.stringify(ws.recus);
        const journalAvant = lignesJournal();
        const ano = donnees(await f.outil('worker_signaler_anomalie', {
            sessionId: payload.sessionId,
            gravite: 'mineure',
            description: 'Essai automatique du harnais — cette entrée est attendue.',
            elements: { origine: 'test-mcpWorker' },
        }));
        verifier('worker_signaler_anomalie consigne dans le journal',
            !!(ano && ano.consigne === true && ano.journal), JSON.stringify(ano));
        verifier('l\'outil rend la phrase exacte à reprendre dans le rapport',
            !!(ano && /Rapport d'activité mis à jour/.test(ano.phraseARapporter || '')),
            ano && String(ano.phraseARapporter));
        verifier('le journal a bien gagné une ligne',
            lignesJournal() === journalAvant + 1, `avant ${journalAvant}, après ${lignesJournal()}`);
        await attendre(200);
        verifier('signaler une anomalie ne pousse RIEN vers la grille',
            JSON.stringify(ws.recus) === wsAvant, JSON.stringify(ws.recus));

        // 11. Les consignes servies sur TOUTES les vues.
        await verifierBriefings(f);

        // 12. Ce que XSpro annonce, et ce que le Worker en fait.
        await verifierNegociationCanal(f);

        ws.fermer();
        f.fermer();
    } finally {
        try {
            if (memoireAvant === null) fs.unlinkSync(CANAL_FILE);
            else fs.writeFileSync(CANAL_FILE, memoireAvant);
        } catch (_) { /* rien à restaurer */ }
        if (worker) { try { worker.kill(); } catch (_) {} }
    }
}

// ── La négociation du canal avec XSpro ────────────────────────────────────────
// Deux micro-règles du contrat /process (cf. XSpro/src/aiView/aiQuery.js) :
// marqueur « canal: mcp » présent → on force ; absent → on garde le dernier canal
// CHOISI PAR L'UTILISATEUR, sans s'aligner sur 'api'. Et un forçage ne fait jamais
// mémoire : il vaut pour sa session seule.
async function verifierNegociationCanal(f) {
    titre('Négociation du canal avec XSpro');

    const payload = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8'));
    delete payload._origin;

    async function creer(suffixe, avecMarqueur) {
        const p = { ...payload, sessionId: `canal_${suffixe}_${Date.now()}` };
        if (avecMarqueur) { p.ia = null; p.canal = 'mcp'; }    // ce que XSpro envoie sans clé à prêter
        const corps = JSON.stringify(p);
        await requete({ method: 'POST', path: '/process', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corps) } }, corps);
        const s = donnees(await f.outil('worker_sessions', {}));
        return (s.sessions || []).find((x) => x.sessionId === p.sessionId);
    }
    const memoire = () => {
        try { return JSON.parse(fs.readFileSync(CANAL_FILE, 'utf8')).canal; } catch (_) { return null; }
    };

    // Le choix se pose par le VRAI geste — le sélecteur de la grille. Écrire le
    // fichier à la main ne suffirait pas : le Worker le lit une fois au démarrage,
    // et c'est la variable en mémoire qui fait foi ensuite.
    const memoireInitiale = memoire();
    async function choisir(sessionId, canal) {
        const ws = await connecterUI(sessionId);
        const obtenu = await ws.basculer(canal);
        ws.fermer();
        return obtenu;
    }

    const reglage = await creer('reglage', false);
    await choisir(reglage.sessionId, 'api');
    verifier('le choix de l\'utilisateur est écrit sur disque', memoire() === 'api', 'mémoire = ' + memoire());

    const force = await creer('force', true);
    verifier('le marqueur de XSpro force le canal MCP',
        !!(force && force.canal === 'mcp'), force && force.canal);
    verifier('la session forcée est inscriptible sans aucune bascule manuelle',
        !!(force && force.ecrivable === true), force && force.raison);
    verifier('un forçage ne touche PAS la mémoire du choix utilisateur',
        memoire() === 'api', 'mémoire = ' + memoire());

    const suivante = await creer('suivante', false);
    verifier('sans marqueur, on reprend le choix de l\'utilisateur',
        !!(suivante && suivante.canal === 'api'), suivante && suivante.canal);

    // Et l'inverse : l'utilisateur a choisi MCP, XSpro envoie une session avec clé.
    await choisir(suivante.sessionId, 'mcp');
    const avecCle = await creer('aveccle', false);
    verifier('une session avec clé API ne ramène PAS le Worker sur « api »',
        !!(avecCle && avecCle.canal === 'mcp'), avecCle && avecCle.canal);

    // Remettre le Worker dans l'état trouvé — le fichier ET la variable en
    // mémoire, que seul le vrai geste remet en place.
    if (memoireInitiale) await choisir(avecCle.sessionId, memoireInitiale);
}

// ── Les briefings, sur les six vues ───────────────────────────────────────────
// Ce que Claude reçoit comme consignes métier. Deux invariants comptent :
//   - le contrat de réponse de l'IA par clé API (« Réponds UNIQUEMENT avec un
//     tableau JSON valide... ») ne doit JAMAIS arriver ici, il dit l'inverse de ce
//     qu'il faut faire ;
//   - la correspondance avec les outils doit toujours être là.
// Le premier protège d'une dérive silencieuse : si un futur remaniement de
// buildSystemPrompt renommait la section, le repli cesserait de la couper sans
// que rien ne le signale. C'est ce test qui doit échouer, pas le canal.
async function verifierBriefings(f) {
    titre('Briefings');

    const MARQUEUR_FORMAT   = '== FORMAT DE RÉPONSE ==';
    const MARQUEUR_COLONNES = '== COLONNES ==';
    const dossier = path.join(RACINE, 'standalone');
    const fichiers = fs.readdirSync(dossier).filter((n) => /^standalone-payload-/.test(n));

    let deLaVue = 0;
    let duRepli = 0;
    const fautifs = [];
    const tailles = [];

    for (let i = 0; i < fichiers.length; i++) {
        const payload = JSON.parse(fs.readFileSync(path.join(dossier, fichiers[i]), 'utf8'));
        delete payload._origin;                       // vue telle qu'une session XSpro la voit
        payload.sessionId = `${payload.contextName}_brief_${i}_${Date.now()}`;
        const corps = JSON.stringify(payload);
        const rp = await requete({ method: 'POST', path: '/process', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corps) } }, corps);
        if (rp.code !== 200) { fautifs.push(`${payload.contextName} : POST /process ${rp.code}`); continue; }

        const base  = donnees(await f.outil('worker_contexte', { sessionId: payload.sessionId, briefing: false }));
        const modes = ((base && base.modesDisponibles) || []).map((m) => m.id);

        for (const mode of (modes.length ? modes : [undefined])) {
            const c  = donnees(await f.outil('worker_contexte', { sessionId: payload.sessionId, mode }));
            const b  = (c && c.briefing) || '';
            const ou = `${payload.contextName}/${mode || '—'}`;

            if (c && c.briefingSource === 'vue') deLaVue++; else duRepli++;
            tailles.push(b.length);

            if (b.includes(MARQUEUR_FORMAT))           fautifs.push(`${ou} : porte encore le FORMAT DE RÉPONSE`);
            if (/Réponds UNIQUEMENT/.test(b))          fautifs.push(`${ou} : dit encore de répondre en JSON`);
            if (b.includes(MARQUEUR_COLONNES))         fautifs.push(`${ou} : reprend la liste des colonnes, déjà servie structurée`);
            if (!b.includes('== COMMENT RÉPONDRE ==')) fautifs.push(`${ou} : sans la correspondance des outils`);
            if (!b.trim())                             fautifs.push(`${ou} : briefing vide`);
        }
    }

    verifier('aucun briefing ne porte le contrat de réponse de la clé API', fautifs.length === 0, fautifs.join(' | '));
    verifier('les deux vues reprises servent leurs consignes courtes', deLaVue === 4, `vue=${deLaVue}, repli=${duRepli}`);
    verifier('les vues non reprises passent par le repli', duRepli > 0, `repli=${duRepli}`);
    verifier('aucun briefing ne dépasse 8 000 caractères',
        tailles.every((t) => t <= 8000), 'max = ' + Math.max(...tailles));

    console.log('  (' + tailles.length + ' briefings, de ' + Math.min(...tailles) + ' à ' + Math.max(...tailles) + ' caractères)');
}

// Journal d'anomalies du jour (phase bêta) — même nom que celui construit par
// mcpChannel.js, pour compter ses lignes avant et après.
function lignesJournal() {
    const d = new Date();
    const jour = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    try {
        return fs.readFileSync(path.join(RACINE, 'logs', `anomalies-${jour}.jsonl`), 'utf8')
            .split('\n').filter((l) => l.trim()).length;
    } catch (_) { return 0; }
}

function listerExports() {
    try { return fs.readdirSync(path.join(RACINE, 'exports')); } catch (_) { return []; }
}

// Se connecte comme le ferait la grille, pour observer ce que le canal pousse et
// pour basculer le canal (ce message n'existe que sur la WebSocket).
function connecterUI(sessionId) {
    const WebSocket = require('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?sessionId=${sessionId}`);
    const recus = {};
    let init = null;
    let attenteCanal = null;
    let attenteApercu = null;

    return new Promise((resolve, reject) => {
        const minuteur = setTimeout(() => reject(new Error('pas de message « init » de la WebSocket')), 10000);
        ws.on('message', (raw) => {
            let m;
            try { m = JSON.parse(raw); } catch (_) { return; }
            recus[m.type] = (recus[m.type] || 0) + 1;
            if (m.type === 'init') {
                init = m;
                clearTimeout(minuteur);
                resolve({
                    init, recus,
                    basculer: (canal) => new Promise((res) => {
                        attenteCanal = res;
                        ws.send(JSON.stringify({ type: 'canal:set', canal }));
                        setTimeout(() => res(null), 5000);
                    }),
                    apercu: (activeMode) => new Promise((res) => {
                        attenteApercu = res;
                        ws.send(JSON.stringify({ type: 'prompt:preview', prompt: 'essai', mode: 'act', files: [], activeMode }));
                        setTimeout(() => res(null), 8000);
                    }),
                    changerMode: (modeId) => {
                        // Le message qui relie le sélecteur de la grille au canal MCP
                        // (cf. server.js, 'workmode:set'). Pas de réponse dédiée : le
                        // prochain worker_contexte le reflète.
                        ws.send(JSON.stringify({ type: 'workmode:set', activeMode: modeId }));
                        return Promise.resolve(true);
                    },
                    fermer: () => { try { ws.close(); } catch (_) {} },
                });
            }
            if (m.type === 'canal' && attenteCanal) { const r = attenteCanal; attenteCanal = null; r(m.canal); }
            if (m.type === 'prompt:preview' && attenteApercu) { const r = attenteApercu; attenteApercu = null; r(m); }
        });
        ws.on('error', (e) => { clearTimeout(minuteur); reject(e); });
    });
}

// Phase branchement Claude — vérifie claudeConfig.js (portées « user » et
// application de bureau) sur des fichiers TEMPORAIRES uniquement : aucun réglage
// réel du poste n'est touché. CLAUDE_CONFIG_DIR et CLAUDE_APP_CONFIG_PATH sont
// posés pour la durée de la phase puis restaurés.
async function verifierBranchementClaude() {
    titre('Branchement Claude (portées user et application de bureau)');
    const os = require('os');
    const ClaudeConfig = require('../claudeConfig');

    const tmp     = fs.mkdtempSync(path.join(os.tmpdir(), 'test-claudeConfig-'));
    const appFile = path.join(tmp, 'claude_desktop_config.json');
    const avant = {
        CLAUDE_CONFIG_DIR:      process.env.CLAUDE_CONFIG_DIR,
        CLAUDE_APP_CONFIG_PATH: process.env.CLAUDE_APP_CONFIG_PATH,
    };
    process.env.CLAUDE_CONFIG_DIR      = tmp;
    process.env.CLAUDE_APP_CONFIG_PATH = appFile;

    try {
        // Une configuration d'application préexistante avec d'autres clés — comme
        // celle qu'une vraie installation porte avant toute inscription.
        fs.writeFileSync(appFile, JSON.stringify(
            { coworkUserFilesPath: 'C:\\\\x', preferences: { a: 1 } }, null, 2));

        const e0 = ClaudeConfig.etat();
        verifier('l\'état lit la configuration user du dossier temporaire',
            !!(e0 && e0.chemin === path.join(tmp, '.claude.json')), e0 && String(e0.chemin));
        verifier('l\'état repère la configuration de l\'application de bureau',
            Array.isArray(e0.application) && e0.application.length === 1,
            e0 && JSON.stringify(e0.application).slice(0, 120));

        const r = ClaudeConfig.brancher();
        verifier('brancher() réussit', !!(r && r.ok), r && r.message);

        const usr = JSON.parse(fs.readFileSync(path.join(tmp, '.claude.json'), 'utf8'));
        const app = JSON.parse(fs.readFileSync(appFile, 'utf8'));
        verifier('l\'entrée user contient worker', !!(usr.mcpServers && usr.mcpServers.worker));
        verifier('l\'application de bureau contient worker', !!(app.mcpServers && app.mcpServers.worker));
        verifier('les clés existantes de l\'application sont préservées',
            app.coworkUserFilesPath === 'C:\\\\x' && app.preferences && app.preferences.a === 1);

        const e1 = ClaudeConfig.etat();
        verifier('l\'état rapporte l\'application de bureau branchée',
            Array.isArray(e1.application) && e1.application[0].branche === true,
            e1 && JSON.stringify(e1.application).slice(0, 120));

        const d = ClaudeConfig.debrancher();
        const usr2 = JSON.parse(fs.readFileSync(path.join(tmp, '.claude.json'), 'utf8'));
        const app2 = JSON.parse(fs.readFileSync(appFile, 'utf8'));
        verifier('debrancher() réussit', !!(d && d.ok), d && d.message);
        verifier('debrancher() retire worker de la portée user',
            !(usr2.mcpServers && usr2.mcpServers.worker));
        verifier('debrancher() retire worker de l\'application de bureau',
            !(app2.mcpServers && app2.mcpServers.worker));
        verifier('l\'application reste un JSON valide après débranchement', !!app2.preferences);
    } finally {
        if (avant.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = avant.CLAUDE_CONFIG_DIR;
        if (avant.CLAUDE_APP_CONFIG_PATH === undefined) delete process.env.CLAUDE_APP_CONFIG_PATH;
        else process.env.CLAUDE_APP_CONFIG_PATH = avant.CLAUDE_APP_CONFIG_PATH;
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
}

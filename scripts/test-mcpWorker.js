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
    verifier('tools/list renvoie des outils', outils.length === 6, 'n=' + outils.length);
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
        verifier('le briefing est celui de l\'IA à clé API',
            !!(ctx && typeof ctx.briefing === 'string' && ctx.briefing.length > 1000),
            ctx && 'briefing = ' + (ctx.briefing ? ctx.briefing.length : 0) + ' caractères');

        // 4b. Non-régression du chemin clé API : worker_contexte emprunte
        //     buildPromptPreview en positionnant session.activeMode, puis le
        //     restaure. Si la restauration sautait, l'aperçu de l'UI — qui partage
        //     cette fonction — partirait sur le mauvais mode.
        const apercu = await ws.apercu('chiffrage');
        verifier('l\'aperçu de prompt de l\'UI répond toujours après un appel MCP',
            !!(apercu && apercu.system && apercu.full), JSON.stringify(apercu).slice(0, 160));

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

        // 9. Le point capital : RIEN n'est parti.
        verifier('aucun export n\'a été produit — rien n\'est parti vers XSpro',
            listerExports().length === exportsAvant.length,
            'avant ' + exportsAvant.length + ', après ' + listerExports().length);

        ws.fermer();
        f.fermer();
    } finally {
        if (worker) { try { worker.kill(); } catch (_) {} }
    }
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
                    fermer: () => { try { ws.close(); } catch (_) {} },
                });
            }
            if (m.type === 'canal' && attenteCanal) { const r = attenteCanal; attenteCanal = null; r(m.canal); }
            if (m.type === 'prompt:preview' && attenteApercu) { const r = attenteApercu; attenteApercu = null; r(m); }
        });
        ws.on('error', (e) => { clearTimeout(minuteur); reject(e); });
    });
}

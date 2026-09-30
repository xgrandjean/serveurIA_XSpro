/**
 * AI Worker — scripts/comparer-canaux.js
 *
 * Compare, sur les MÊMES demandes et la MÊME grille, l'IA par clé API et XSProAssist — sur
 * des faits : le journal de chaque traitement (journalTraitement.js) et ce qui est retenu
 * dans la grille. Le script lance SON PROPRE Worker, sur un port à lui (8899), sans ouverture
 * de navigateur et avec ses propres fichiers d'état : un Worker déjà en marche n'est jamais
 * réutilisé — en mode standalone il ouvre un onglet à chaque session créée, et cet onglet
 * s'approprie la WebSocket de la session, si bien qu'un client de mesure n'en reçoit plus rien.
 * Pour chaque couple demande × canal : une session (POST /process, comme XSpro), la bascule et
 * la demande par la WebSocket comme la grille, la fin attendue, le journal relu, et ce qui est
 * retenu dans la grille. Puis le tableau, et logs/comparaison-<horodatage>.json.
 *
 *   node scripts/comparer-canaux.js --ia=<fichier> [--modele=<nom>] [--demandes=1,3] [--canaux=api,assist] [--port=8899]
 *   node scripts/comparer-canaux.js --simuler      [mêmes options]
 *
 * <fichier> : un bloc « ia » ({ apiKey, endpoint, model, provider, timeoutMs }), une charge
 * d'essai standalone-payload-*.json (son bloc « ia » est pris), ou le parametresAi.json de
 * XSpro, dont config_or (puis config_hf) est pris comme le fait AI:getWorkerIaConfig. Par
 * défaut standalone/ia-config.json. La clé n'est jamais imprimée.
 *
 * --simuler : pas de modèle réel — un « Albert idéal » servi par HTTP, qui suit les consignes
 * à la lettre et répond sans délai, dans le contrat que chaque canal attend (le tableau ou
 * l'objet du FORMAT DE RÉPONSE pour la clé API, des appels d'outils pour XSProAssist). Il
 * montre ce que coûte chaque chemin quand le modèle fait tout juste — pas ce que vaut un vrai
 * modèle. Sans --simuler, CE SCRIPT APPELLE UN VRAI MODÈLE : chaque ligne a coûté des appels.
 */

'use strict';

const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');
const os        = require('os');
const http      = require('http');
const WebSocket = require('ws');
const Journal   = require('../journalTraitement');

const RACINE  = path.join(__dirname, '..');
const PAYLOAD = path.join(RACINE, 'standalone', 'standalone-payload-detailsDevis.json');
const args    = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true]; }));
const PORT    = Number(args.port) || 8899;

// ── Les demandes ──────────────────────────────────────────────────────────────
// La même grille de 7 lignes (deux chapitres, un sous-chapitre, quatre lignes de détail), en
// mode Décomposition puis Chiffrage. L'« attendu » est ce qu'un lecteur vérifie à l'œil.
const DEMANDES = [
    {
        id: 1, mode: 'decomposition',
        texte: 'Ajoute sous le SECOND CHAPITRE un sous-chapitre « Éclairage » avec deux lignes de détail : fourniture et pose de 3 luminaires LED (unité U), et câblage en 3G1,5 (unité m, quantité 25).',
        attendu: '3 lignes ajoutées après le second chapitre : un sous-chapitre, deux lignes de détail avec unité et quantité ; rien de modifié.',
    },
    {
        id: 2, mode: 'decomposition',
        texte: 'Renomme le sous-chapitre « Sous-chapitre exemple » en « Gros œuvre », et passe la quantité de la ligne « Ligne de détail — fourniture et pose » à 55.',
        attendu: '2 cellules modifiées (une désignation, une quantité) ; rien d\'ajouté.',
    },
    {
        id: 3, mode: 'decomposition',
        texte: 'Voici le descriptif : « Lot électricité — chambre : 3 prises de courant 16 A, 2 points d\'allumage va-et-vient, 1 luminaire plafond. Salle de bain : 1 prise rasoir, 1 point lumineux étanche. » Crée un chapitre « LOT ÉLECTRICITÉ » avec un sous-chapitre par pièce et une ligne de détail par ouvrage, quantités comprises, à la fin du devis.',
        attendu: '8 lignes ajoutées en fin : 1 chapitre, 2 sous-chapitres, 5 lignes de détail avec quantités 3, 2, 1, 1, 1 ; hiérarchie sans saut de niveau.',
    },
    {
        id: 4, mode: 'chiffrage',
        texte: 'Chiffre les lignes de détail existantes : « fourniture et pose » 12 € de matériel et 0,5 h de pose par unité ; « fourniture seule » 8 € et pas de pose ; « main d\'œuvre seule » 1,5 h de pose ; la ligne sous-traitée reste sous-traitée.',
        attendu: 'prix et heures posés sur 3 lignes, taux horaire à 1 dès qu\'il y a des heures, rien sur la ligne sous-traitée ni sur les chapitres.',
    },
];

// ── Le modèle simulé : un « Albert idéal », qui suit les consignes à la lettre ──
// Une réponse par demande, dans le vocabulaire de la grille (les libellés de niveauListe sont
// ceux du FORMAT DE RÉPONSE et de worker_contexte). La clé API reçoit ce que son FORMAT DE
// RÉPONSE demande — un tableau d'actions, ou l'objet { rapport, actions } — ; XSProAssist reçoit
// une écriture par outil puis worker_terminer. Rien n'est « compris » : c'est un dictionnaire.
const CHAPITRE = '▶ ◇ ○';
const SOUS_CHAPITRE = '○ ◆ ○';
const DETAIL = '○ ○ ●';
const SIMULATION = {
    1: {
        inserts: [
            { _apres: 7, niveauListe: SOUS_CHAPITRE, designation: 'Éclairage' },
            { _apres: 7, niveauListe: DETAIL, designation: 'Fourniture et pose de 3 luminaires LED', unite: 'U', quantiteTotale: 3 },
            { _apres: 7, niveauListe: DETAIL, designation: 'Câblage en 3G1,5', unite: 'm', quantiteTotale: 25 },
        ],
        rapport: 'Sous-chapitre « Éclairage » et ses deux lignes de détail ajoutés à la suite du SECOND CHAPITRE.',
    },
    2: {
        updates: [{ _id: 2, designation: 'Gros œuvre' }, { _id: 3, quantiteTotale: 55 }],
        rapport: 'Sous-chapitre renommé « Gros œuvre », quantité de la fourniture et pose passée à 55.',
    },
    3: {
        inserts: [
            { _apres: 'fin', niveauListe: CHAPITRE, designation: 'LOT ÉLECTRICITÉ' },
            { _apres: 'fin', niveauListe: SOUS_CHAPITRE, designation: 'Chambre' },
            { _apres: 'fin', niveauListe: DETAIL, designation: 'Prise de courant 16 A', unite: 'U', quantiteTotale: 3 },
            { _apres: 'fin', niveauListe: DETAIL, designation: 'Point d\'allumage va-et-vient', unite: 'U', quantiteTotale: 2 },
            { _apres: 'fin', niveauListe: DETAIL, designation: 'Luminaire plafond', unite: 'U', quantiteTotale: 1 },
            { _apres: 'fin', niveauListe: SOUS_CHAPITRE, designation: 'Salle de bain' },
            { _apres: 'fin', niveauListe: DETAIL, designation: 'Prise rasoir', unite: 'U', quantiteTotale: 1 },
            { _apres: 'fin', niveauListe: DETAIL, designation: 'Point lumineux étanche', unite: 'U', quantiteTotale: 1 },
        ],
        rapport: 'Chapitre LOT ÉLECTRICITÉ créé en fin de devis : Chambre (3 ouvrages) et Salle de bain (2 ouvrages), quantités reprises du descriptif.',
    },
    4: {
        updates: [
            { _id: 3, prixAchatUnitaire: 12, heuresUnitaire: 0.5, tauxHoraire: 1 },
            { _id: 5, prixAchatUnitaire: 8, heuresUnitaire: 0, tauxHoraire: 0 },
            { _id: 7, heuresUnitaire: 1.5, tauxHoraire: 1 },
        ],
        rapport: 'Trois lignes chiffrées ; la ligne sous-traitée et les chapitres n\'ont pas été touchés.',
    },
};

function demandeDe(texte) {
    return DEMANDES.find((d) => texte.includes(d.texte.slice(0, 60)));
}

function modeleSimule() {
    const appels = [];
    const srv = http.createServer((req, res) => {
        let corps = '';
        req.on('data', (c) => { corps += c; });
        req.on('end', () => {
            let body = {};
            try { body = JSON.parse(corps); } catch (_) { /* illisible */ }
            const messages = body.messages || [];
            const systeme  = messages[0] && typeof messages[0].content === 'string' ? messages[0].content : '';
            const dernierUtilisateur = [...messages].reverse().find((m) => m.role === 'user');
            const texte = dernierUtilisateur ? (typeof dernierUtilisateur.content === 'string' ? dernierUtilisateur.content : JSON.stringify(dernierUtilisateur.content)) : '';
            const d = demandeDe(texte);
            const s = d && SIMULATION[d.id];
            appels.push({ canal: Array.isArray(body.tools) ? 'assist' : 'api', demande: d && d.id });
            const jetons = Math.round(JSON.stringify(messages).length / 4);
            const reponse = (message, finish_reason) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ model: body.model, choices: [{ message, finish_reason }], usage: { total_tokens: jetons } }));
            };
            if (!s) return reponse({ role: 'assistant', content: 'Demande inconnue du modèle simulé.' }, 'stop');

            if (Array.isArray(body.tools)) {
                // XSProAssist : une écriture, puis la conclusion une fois son résultat reçu.
                const dejaEcrit = messages.some((m) => m.role === 'tool');
                if (dejaEcrit) {
                    return reponse({ role: 'assistant', content: '', tool_calls: [{ id: 'sim_fin', type: 'function', function: { name: 'worker_terminer', arguments: JSON.stringify({ rapport: s.rapport }) } }] }, 'tool_calls');
                }
                const appel = s.inserts
                    ? { name: 'worker_inserer_lignes', arguments: JSON.stringify({ apres: s.inserts[0]._apres, lignes: s.inserts.map(({ _apres, ...champs }) => champs) }) }
                    : { name: 'worker_ecrire_cellules', arguments: JSON.stringify({ lignes: s.updates.map(({ _id, ...valeurs }) => ({ _id, valeurs })) }) };
                return reponse({ role: 'assistant', content: '', tool_calls: [{ id: 'sim_ecr', type: 'function', function: appel }] }, 'tool_calls');
            }

            // Clé API : le contrat que le FORMAT DE RÉPONSE demande.
            const actions = s.inserts
                ? s.inserts.map((l) => ({ _action: 'insert', ...l }))
                : s.updates.map((l) => ({ _action: 'update', ...l }));
            const contratTableau = /tableau JSON/i.test(systeme) && !/"rapport"/.test(systeme);
            const contenu = contratTableau ? JSON.stringify(actions) : JSON.stringify({ rapport: s.rapport, actions });
            return reponse({ role: 'assistant', content: contenu }, 'stop');
        });
    });
    return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
        url: `http://127.0.0.1:${srv.address().port}/v1/chat/completions`, appels,
        fermer: () => { try { srv.close(); } catch (_) {} },
    })));
}

// ── Le bloc « ia » ────────────────────────────────────────────────────────────
function chargerIa(fichier) {
    const raw = JSON.parse(fs.readFileSync(fichier, 'utf8'));
    // Une charge d'essai complète (standalone-payload-*.json) : son bloc « ia ».
    if (raw.ia && raw.ia.endpoint) return raw.ia;
    if (raw.config_or || raw.config_hf) {
        const cfg = raw.config_or && raw.config_or.START ? raw.config_or : (raw.config_hf && raw.config_hf.START ? raw.config_hf : null);
        if (!cfg) throw new Error('aucun canal IA actif dans ' + fichier);
        const endpoint = cfg.OR_ENDPOINT || cfg.HF_ENDPOINT || '';
        return {
            apiKey: cfg.OPENAI_API_KEY || cfg.HF_API_KEY || '', endpoint,
            model: cfg.NOM_DU_MODELE || cfg.HF_MODEL || '',
            provider: /albert/.test(endpoint) ? 'albert' : (/mistral\.ai/.test(endpoint) ? 'mistral' : 'openai'),
            timeoutMs: cfg.REQUEST_TIMEOUT_MS || 30000, maxPromptLength: cfg.MAX_PROMPT_LENGTH || 25000,
        };
    }
    if (!raw.apiKey || !raw.endpoint) throw new Error('bloc ia sans apiKey/endpoint dans ' + fichier);
    return raw;
}

// ── Un Worker à soi : port dédié, pas de navigateur, état à part ──────────────
function preparerAssets(port) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comparaison-canaux-'));
    for (const d of ['public', 'views']) fs.cpSync(path.join(RACINE, d), path.join(dir, d), { recursive: true });
    const cfg = JSON.parse(fs.readFileSync(path.join(RACINE, 'worker-config.json'), 'utf8'));
    cfg.port = port;
    cfg.autoOpenUI = false;
    fs.writeFileSync(path.join(dir, 'worker-config.json'), JSON.stringify(cfg, null, 2));
    return dir;
}

// ── HTTP et WebSocket, comme la grille ────────────────────────────────────────
function requete(options, corps) {
    return new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: PORT, ...options }, (res) => {
            let d = '';
            res.on('data', (c) => { d += c; });
            res.on('end', () => resolve({ code: res.statusCode, corps: d }));
        });
        req.setTimeout(5000, () => { req.destroy(); resolve({ code: 0 }); });
        req.on('error', (e) => resolve({ code: 0, erreur: e.code }));
        if (corps) req.write(corps);
        req.end();
    });
}
const joignable = () => requete({ method: 'HEAD', path: '/view-config/' }).then((r) => r.code === 200);
const attendre  = (ms) => new Promise((r) => setTimeout(r, ms));

function connecter(sessionId) {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?sessionId=${sessionId}`);
    const messages = [];
    const attentes = [];
    return new Promise((resolve, reject) => {
        const minuteur = setTimeout(() => reject(new Error('pas de message init')), 10000);
        ws.on('message', (raw) => {
            let m; try { m = JSON.parse(raw); } catch (_) { return; }
            messages.push(m);
            for (let i = attentes.length - 1; i >= 0; i--) if (attentes[i].types.includes(m.type)) attentes.splice(i, 1)[0].res(m);
            if (m.type === 'init') {
                clearTimeout(minuteur);
                resolve({
                    init: m, messages,
                    envoyer: (msg) => ws.send(JSON.stringify(msg)),
                    attendre: (types, ms) => new Promise((res) => { attentes.push({ types: [].concat(types), res }); setTimeout(() => res(null), ms); }),
                    fermer: () => { try { ws.close(); } catch (_) {} },
                });
            }
        });
        ws.on('error', (e) => { clearTimeout(minuteur); reject(e); });
    });
}

// ── Ce qui est retenu dans la grille, lisible ─────────────────────────────────
function retenu(rowsApres) {
    const ajoutees = rowsApres.filter((r) => r.__pendingInsert).map((r) => `[${JSON.stringify(r.niveauListe)}] ${r.designation || ''}${r.unite ? ` [${r.unite}]` : ''}${r.quantiteTotale !== undefined && r.quantiteTotale !== '' ? ` ×${r.quantiteTotale}` : ''}`);
    const modifiees = [];
    for (const r of rowsApres) {
        if (!r.__pendingFields) continue;
        for (const [cle, ancienne] of Object.entries(r.__pendingFields)) {
            modifiees.push(`_id ${r._id} ${cle} : ${JSON.stringify(ancienne)} → ${JSON.stringify(r[cle])}`);
        }
    }
    const supprimees = rowsApres.filter((r) => r.__pendingDelete).map((r) => `_id ${r._id} ${r.designation || ''}`);
    return { ajoutees, modifiees, supprimees, nb: { ajoutees: ajoutees.length, cellules: modifiees.length, supprimees: supprimees.length } };
}

// ── Un traitement ─────────────────────────────────────────────────────────────
async function jouer(demande, canal, ia, payloadBase) {
    const p = { ...payloadBase, sessionId: `comparaison_${demande.id}_${canal}_${Date.now()}`, ia };
    const corps = JSON.stringify(p);
    const rp = await requete({ method: 'POST', path: '/process', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corps) } }, corps);
    if (rp.code !== 200) return { demande: demande.id, canal, issue: `POST /process ${rp.code}` };

    const ws = await connecter(p.sessionId);
    ws.envoyer({ type: 'canal:set', canal });
    const c = await ws.attendre('canal', 5000);
    if (!c || c.canal !== canal) { ws.fermer(); return { demande: demande.id, canal, issue: 'bascule refusée' }; }
    ws.envoyer({ type: 'workmode:set', activeMode: demande.mode });

    const debut = Date.now();
    const attenteFin = ws.attendre(['act:done', 'error'], 300000);
    ws.envoyer({ type: 'prompt:send', prompt: demande.texte, mode: 'act', files: [], activeMode: demande.mode });
    const fin = await attenteFin;
    // La ligne « fin » du journal suit act:done de quelques millisecondes.
    for (let i = 0; i < 10 && !ws.messages.some((m) => m.type === 'journal:etape' && m.etape.evenement === 'fin'); i++) await attendre(200);
    const dureeMesureeMs = Date.now() - debut;
    ws.fermer();

    // Le journal et les lignes, tels qu'une grille rouverte les reçoit.
    const ws2 = await connecter(p.sessionId);
    const journal   = ws2.init.journal;
    const rowsApres = ws2.init.rows || [];
    ws2.fermer();

    const m = Journal.mesuresDe(journal) || {};
    return {
        demande: demande.id, canal, modele: m.modele, mode: demande.mode,
        issue: fin ? (fin.type === 'error' ? `erreur : ${fin.message}` : m.issue) : 'sans fin (délai)',
        dureeMs: m.dureeMs, dureeMesureeMs, tours: m.tours, dureeModeleMs: m.dureeModeleMs,
        jetons: m.jetons, envoiCar: m.envoiCar, reponseCar: m.reponseCar, coupee: m.coupee,
        relances: m.relances, appelsOutils: m.appelsOutils, refusOutils: m.refusOutils,
        declarees: m.declarees, sansEffet: m.sansEffet, avertissements: m.avertissements,
        rapport: fin && fin.rapport ? String(fin.rapport) : null,
        retenu: retenu(rowsApres),
        journal,
    };
}

// ══════════════════════════════════════════════════════════════════════════════
(async () => {
    const simuler = !!args.simuler;
    let fauxModele = null;
    let ia;
    if (simuler) {
        fauxModele = await modeleSimule();
        ia = { apiKey: 'simulation', endpoint: fauxModele.url, model: 'albert-simule', provider: 'albert', timeoutMs: 30000, maxPromptLength: 25000 };
    } else {
        const fichierIa = args.ia && args.ia !== true ? path.resolve(String(args.ia)) : path.join(RACINE, 'standalone', 'ia-config.json');
        ia = chargerIa(fichierIa);
        if (args.modele && args.modele !== true) ia = { ...ia, model: String(args.modele) };   // un autre modèle du même fournisseur
    }
    const canaux   = (args.canaux ? String(args.canaux).split(',') : ['api', 'assist']).map((c) => c.trim());
    const ids      = args.demandes ? String(args.demandes).split(',').map((n) => Number(n)) : DEMANDES.map((d) => d.id);
    const demandes = DEMANDES.filter((d) => ids.includes(d.id));

    console.log(`Modèle : ${ia.model} (${ia.provider || '?'})${simuler ? ' — SIMULÉ, réponses idéales sans délai' : ' — ' + ia.endpoint}`);
    console.log(`Demandes : ${demandes.map((d) => d.id).join(', ')} × canaux : ${canaux.join(', ')} — Worker dédié sur le port ${PORT}`);

    const payloadBase = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8'));
    delete payloadBase._origin;

    if (await joignable()) {
        console.error(`Le port ${PORT} est déjà pris par un Worker : choisir un autre port (--port=…).`);
        if (fauxModele) fauxModele.fermer();
        process.exit(1);
    }
    const assets = preparerAssets(PORT);
    const worker = spawn(process.execPath, [path.join(RACINE, 'server.js')], {
        cwd: RACINE,
        env: { ...process.env, AI_WORKER_ASSETS_DIR: assets, AI_WORKER_DATA_DIR: assets, AI_WORKER_DISABLE_AUTO_OPEN: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (let i = 0; i < 40 && !(await joignable()); i++) await attendre(250);
    if (!(await joignable())) {
        console.error('Worker injoignable après 10 s');
        try { worker.kill(); } catch (_) {}
        if (fauxModele) fauxModele.fermer();
        process.exit(1);
    }

    const resultats = [];
    try {
        for (const d of demandes) {
            for (const canal of canaux) {
                process.stdout.write(`\n▶ demande ${d.id} (${d.mode}) par ${canal}… `);
                let r;
                try { r = await jouer(d, canal, ia, payloadBase); }
                catch (e) { r = { demande: d.id, canal, issue: `harnais : ${e.message}` }; }
                console.log(r.issue, r.dureeMs !== undefined && r.dureeMs !== null ? `(${(r.dureeMs / 1000).toFixed(1)} s)` : '');
                if (r.retenu) {
                    if (r.retenu.ajoutees.length)   console.log('   ajoutées   : ' + r.retenu.ajoutees.join(' | '));
                    if (r.retenu.modifiees.length)  console.log('   modifiées  : ' + r.retenu.modifiees.join(' | '));
                    if (r.retenu.supprimees.length) console.log('   supprimées : ' + r.retenu.supprimees.join(' | '));
                    if (!r.retenu.ajoutees.length && !r.retenu.modifiees.length && !r.retenu.supprimees.length) console.log('   (rien de retenu)');
                }
                if (r.rapport) console.log('   rapport    : ' + r.rapport.replace(/\s+/g, ' ').slice(0, 300));
                resultats.push(r);
            }
        }
    } finally {
        try { worker.kill(); } catch (_) {}
        if (fauxModele) fauxModele.fermer();
        try { fs.rmSync(assets, { recursive: true, force: true }); } catch (_) {}
    }

    const s = (ms) => (ms === null || ms === undefined ? '' : (ms / 1000).toFixed(1));
    const k = (n) => (n ? Math.round(n / 1000) + ' k' : '');
    console.log('\nAttendu, par demande :');
    demandes.forEach((d) => console.log(`  ${d.id}. ${d.attendu}`));
    console.log('');
    console.table(resultats.map((r) => ({
        demande: r.demande, canal: r.canal, issue: String(r.issue).slice(0, 28),
        'durée s': s(r.dureeMs), 'modèle s': s(r.dureeModeleMs), appels: r.tours === undefined ? '' : r.tours,
        jetons: r.jetons || '', 'envoi car.': k(r.envoiCar), relances: r.relances === undefined ? '' : r.relances,
        outils: r.appelsOutils === undefined ? '' : `${r.appelsOutils}${r.refusOutils ? ` (${r.refusOutils} refus)` : ''}`,
        ajoutées: r.retenu ? r.retenu.nb.ajoutees : '', 'cellules modif.': r.retenu ? r.retenu.nb.cellules : '', supprimées: r.retenu ? r.retenu.nb.supprimees : '',
        'déclaré/sans effet': r.declarees ? `${r.declarees.inserees}+${r.declarees.modifiees}-${r.declarees.supprimees}${r.sansEffet ? ` / ${r.sansEffet}` : ''}` : '',
        coupée: r.coupee ? 'OUI' : '',
    })));

    const dossier = path.join(RACINE, 'logs');
    fs.mkdirSync(dossier, { recursive: true });
    const sortie = path.join(dossier, `comparaison-${simuler ? 'simulee-' : ''}${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(sortie, JSON.stringify({ modele: ia.model, endpoint: simuler ? '(simulation)' : ia.endpoint, simule: simuler, demandes, resultats }, null, 2), 'utf8');
    console.log(`\nDétail complet (journaux, lignes) : ${path.relative(RACINE, sortie)}`);
    process.exit(0);
})().catch((e) => {
    console.error('La comparaison s\'est interrompue : ' + (e && e.stack));
    process.exit(1);
});

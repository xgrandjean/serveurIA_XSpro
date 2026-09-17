/**
 * AI Worker — mcpStdio.js
 *
 * Façade MCP du canal de remplissage : elle donne à Claude (ou à tout client MCP)
 * des outils nommés, et les traduit en appels au canal local du Worker.
 *
 * Ce fichier ne fait QUE traduire. Toute la logique, la liste blanche des verbes
 * et les garde-fous vivent dans le Worker (mcpChannel.js) : un client MCP ne peut
 * donc rien faire de plus que ce que le canal autorise déjà.
 *
 * Aucune dépendance : le protocole MCP est du JSON-RPC 2.0 sur stdin/stdout, une
 * ligne par message. Installer un SDK pour cela aurait ajouté un arbre de paquets
 * à un projet qui n'en demande pas.
 *
 * ⚠ stdout est réservé aux messages du protocole. Tout le reste va sur stderr,
 *   sinon le client considère la sortie comme corrompue.
 *
 * Ce module vit à la RACINE, et non plus sous tools/, pour une seule raison :
 * `pkg` ne suit que le graphe de require de server.js. Être requis par lui est
 * la seule façon de partir dans serveurIA.exe — donc d'exister chez l'utilisateur,
 * qui n'a ni le dépôt ni Node. Le déplacer sous tools/ le retirerait du build
 * sans aucun message d'erreur : la façade redeviendrait réservée aux développeurs.
 *
 * Deux points d'entrée, même code :
 *   serveurIA.exe --mcp              chez l'utilisateur (cf. server.js)
 *   node tools/mcp-worker/server.js  dans le dépôt (wrapper de trois lignes)
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const VERSION_PROTOCOLE = '2024-11-05';
const PORT_DEFAUT       = 8888;
const DELAI_MS          = 10000;

const GESTE_DEMARRAGE =
    'Le AI Worker ne tourne pas, ou il écoute sur un autre port.\n'
  + 'Le lancer depuis le dossier du Worker :  npm start\n'
  + '— ou ouvrir la grille depuis XSpro, qui démarre serveurIA.exe lui-même.';

// ── Découverte du port ────────────────────────────────────────────────────────
// Relu à chaque appel : le Worker peut avoir été relancé sur un autre port entre
// deux outils. Il n'y a pas de négociation de port côté XSpro — la valeur est
// fixe dans worker-config.json, recopié tel quel dans les assets livrés.
//
// Quatre dispositions, essayées dans cet ordre. La façade est lancée par le
// client MCP, jamais par XSpro : elle n'hérite d'aucun environnement et ne peut
// rien présumer de son voisinage.
//   1. AI_WORKER_ASSETS_DIR, si d'aventure l'environnement de XSpro a été hérité ;
//   2. à côté du point d'entrée — le dépôt (`node server.js`), ou un exe posé
//      dans le dossier de ses assets ;
//   3. <exe>/serveurIA-data/ — la disposition historique : XSpro copie l'exe et
//      les assets dans le même dossier userData (cf. XSpro/src/ipc/ipcAI.js,
//      _ensureServeurIAAssets) ;
//   4. <userData>/serveurIA-data/ — la disposition réellement déployée : l'exe
//      vit dans <userData>/XSpro/workspace/config et les assets (donc
//      worker-config.json) deux niveaux au-dessus. Sans ce repli, un port
//      configuré "port": 8889 serait silencieusement ignoré et toute la façade
//      retomberait sur 8888.
//
// La version précédente cherchait `__dirname/../../worker-config.json` — hérité
// de l'époque où ce fichier vivait sous tools/mcp-worker/. Depuis la racine, cela
// résout vers C:\worker-config.json (et /worker-config.json sous pkg) : le port
// configuré n'était JAMAIS lu, et tout retombait sur 8888 sans rien dire.
function racinesConfig() {
    const base = (typeof process.pkg !== 'undefined') ? path.dirname(process.execPath) : __dirname;
    const racines = [];
    if (process.env.AI_WORKER_ASSETS_DIR) racines.push(process.env.AI_WORKER_ASSETS_DIR);
    racines.push(base, path.join(base, 'serveurIA-data'));
    racines.push(path.join(path.dirname(path.dirname(base)), 'serveurIA-data'));
    return racines;
}

function portsCandidats() {
    let configure = null;
    for (const racine of racinesConfig()) {
        try {
            const raw = JSON.parse(fs.readFileSync(path.join(racine, 'worker-config.json'), 'utf8'));
            if (Number.isInteger(raw.port)) { configure = raw.port; break; }
        } catch (_) { /* fichier absent ou illisible : racine suivante */ }
    }

    return configure && configure !== PORT_DEFAUT ? [configure, PORT_DEFAUT] : [PORT_DEFAUT];
}

// ── Appel du canal ────────────────────────────────────────────────────────────
let _portConnu = null;

function appelerPort(port, verbe, args) {
    return new Promise((resolve) => {
        const corps = JSON.stringify({ verbe, args: args || {} });
        const req = http.request({
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/mcp/commande',
            headers: {
                // Le canal refuse tout appel sans cette en-tête : elle n'est pas
                // listée dans Access-Control-Allow-Headers, donc inenvoyable par
                // une page web (cf. mcpChannel.js).
                'X-Worker-MCP': '1',
                Host: '127.0.0.1:' + port,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(corps),
            },
        }, (res) => {
            let d = '';
            res.on('data', (c) => { d += c; });
            res.on('end', () => {
                let j = null;
                try { j = JSON.parse(d); } catch (_) { /* réponse non JSON */ }
                resolve({ code: res.statusCode, json: j });
            });
        });

        req.setTimeout(DELAI_MS, () => {
            req.destroy();
            resolve({ code: 0, erreur: 'delai' });
        });
        req.on('error', (e) => resolve({ code: 0, erreur: e.code || e.message }));
        req.write(corps);
        req.end();
    });
}

async function appeler(verbe, args) {
    const ports     = portsCandidats();
    const candidats = _portConnu ? [_portConnu].concat(ports.filter((p) => p !== _portConnu)) : ports;

    let dernierEchec = null;
    for (const port of candidats) {
        const r = await appelerPort(port, verbe, args);

        if (r.code === 0) {
            if (r.erreur === 'delai') {
                return { ok: false, message:
                    'Le Worker ne répond pas (délai dépassé). Il est peut-être occupé par un '
                    + 'traitement en cours : réessayer dans un moment.' };
            }
            dernierEchec = r.erreur;
            continue;                       // port suivant
        }

        _portConnu = port;

        if (r.code === 403) {
            // Canal désactivé, ou appel jugé non local : le canal explique lui-même.
            return { ok: false, message: (r.json && r.json.erreur) || 'Canal refusé.' };
        }
        if (r.code !== 200) {
            return { ok: false, message: (r.json && r.json.erreur) || ('Erreur HTTP ' + r.code) };
        }
        return { ok: true, data: r.json };
    }

    return { ok: false, message:
        GESTE_DEMARRAGE + (dernierEchec ? '\n(' + dernierEchec + ')' : '') };
}

// ── Outils exposés ────────────────────────────────────────────────────────────
// Les descriptions sont écrites pour être lues par un modèle : elles disent ce
// que l'outil fait ET ce qu'il ne garantit pas.
const RIEN = { type: 'object', properties: {} };

const SESSION_ID = {
    type: 'string',
    description: 'Numéro de session, tel que worker_sessions le donne.',
};

const OUTILS = [
    {
        name: 'worker_sessions',
        description:
            'Les grilles actuellement ouvertes dans le AI Worker, avec ce que XSpro a demandé '
          + 'pour chacune, les modes de travail disponibles, et si elle est inscriptible. '
          + 'À appeler en premier : les autres outils ont besoin d\'un sessionId. Une session '
          + 'dont « canal » vaut "api" est remplie par l\'IA à clé API et refusera toute '
          + 'écriture tant que l\'utilisateur n\'a pas basculé le sélecteur « Remplissage » '
          + 'sur « Claude (MCP) » dans la grille.',
        inputSchema: RIEN,
        verbe: 'sessions',
    },
    {
        name: 'worker_contexte',
        description:
            'Tout ce qu\'il faut pour remplir une grille : les colonnes du mode de travail '
          + '(avec leur type et, le cas échéant, les seules valeurs admises), les lignes avec '
          + 'leur _id, les informations de l\'affaire, et le « briefing » — les règles métier '
          + 'de la vue et les exemples, suivis de la correspondance entre ces règles et les '
          + 'outils. LIRE LE BRIEFING AVANT D\'ÉCRIRE : les règles d\'une vue ne se devinent '
          + 'pas. L\'appeler une fois par session, puis le rappeler avec briefing:false pour '
          + 'relire seulement les lignes.',
        inputSchema: {
            type: 'object',
            properties: {
                sessionId: SESSION_ID,
                mode: {
                    type: 'string',
                    description: 'Mode de travail (ex. "decomposition", "chiffrage"). Par défaut, le mode sélectionné dans la grille par l\'utilisateur (worker_sessions le rapporte). Le mode détermine les colonnes autorisées ET les consignes. Si l\'utilisateur change de mode dans la grille en cours de route, rappeler worker_contexte (briefing:false) : le mode suit le sélecteur.',
                },
                offset:   { type: 'integer', description: 'Première ligne à lire (0 = la première).' },
                limite:   { type: 'integer', description: 'Nombre de lignes (1 à 500, 100 par défaut).' },
                briefing: { type: 'boolean', description: 'Inclure les consignes métier (vrai par défaut). Les mettre à false pour une relecture courte.' },
            },
            required: ['sessionId'],
        },
        verbe: 'contexte',
    },
    {
        name: 'worker_ecrire_cellules',
        description:
            'Écrit des valeurs dans la grille — plusieurs lignes et plusieurs colonnes en un '
          + 'seul appel, préférer un gros lot à des appels unitaires. Les lignes se désignent '
          + 'par leur _id, jamais par leur position. Les clés de colonne et les types viennent '
          + 'de worker_contexte : une colonne integer/decimal attend un nombre, une colonne à '
          + 'choix attend une de ses « valeur » (son « label » est aussi accepté), une colonne '
          + 'tableau:true attend un tableau. Les colonnes inconnues et les _id introuvables '
          + 'sont ignorés et listés dans la réponse — la relire. Rien n\'est vérifié sur le '
          + 'fond : c\'est une PROPOSITION, que l\'utilisateur valide ou rejette ligne par '
          + 'ligne dans la grille. Rien n\'est envoyé à XSpro.',
        inputSchema: {
            type: 'object',
            properties: {
                sessionId: SESSION_ID,
                lignes: {
                    type: 'array',
                    description: 'Les lignes à remplir, 200 au plus (2000 cellules au total).',
                    items: {
                        type: 'object',
                        properties: {
                            _id:     { type: 'integer', description: 'L\'_id de la ligne, tel que worker_contexte le donne.' },
                            valeurs: { type: 'object',  description: 'Les cellules à poser : { cleDeColonne: valeur, ... }.' },
                        },
                        required: ['_id', 'valeurs'],
                    },
                },
            },
            required: ['sessionId', 'lignes'],
        },
        verbe: 'ecrire',
    },
    {
        name: 'worker_inserer_lignes',
        description:
            'Ajoute des lignes à la grille, au même titre que le bouton « + Ligne » : elles '
          + 'arrivent en attente, et l\'utilisateur les garde ou les rejette. Renvoie les _id '
          + 'attribués — s\'en servir pour compléter ensuite ces lignes avec '
          + 'worker_ecrire_cellules. Les lignes du lot se suivent dans l\'ordre donné. '
          + 'Rien n\'est envoyé à XSpro : c\'est l\'utilisateur qui livrera, après relecture.',
        inputSchema: {
            type: 'object',
            properties: {
                sessionId: SESSION_ID,
                apres: {
                    description: 'Où insérer : l\'_id de la ligne après laquelle placer le lot, null pour insérer en tête, "fin" pour ajouter à la fin (défaut).',
                },
                lignes: {
                    type: 'array',
                    description: 'Les lignes à créer, chacune sous la forme { cleDeColonne: valeur, ... }.',
                    items: { type: 'object' },
                },
            },
            required: ['sessionId', 'lignes'],
        },
        verbe: 'inserer',
    },
    {
        name: 'worker_supprimer_lignes',
        description:
            'Marque des lignes comme à supprimer, au même titre que le bouton « ✂️ » : elles '
          + 'restent visibles, barrées, jusqu\'à ce que l\'utilisateur tranche. Rien n\'est '
          + 'perdu tant qu\'il n\'a pas validé, et rien n\'est envoyé à XSpro.',
        inputSchema: {
            type: 'object',
            properties: {
                sessionId: SESSION_ID,
                ids: {
                    type: 'array',
                    description: 'Les _id des lignes concernées.',
                    items: { type: 'integer' },
                },
            },
            required: ['sessionId', 'ids'],
        },
        verbe: 'supprimer',
    },
    {
        name: 'worker_terminer',
        description:
            'Clôt le travail sur une session : la grille se redessine entièrement et passe en '
          + 'attente de relecture par l\'utilisateur. À appeler une fois le remplissage fini. '
          + 'Le « rapport » s\'affiche dans la grille comme un message : y dire ce qui a été '
          + 'fait, et ce dont on n\'est pas sûr. Ceci n\'envoie RIEN à XSpro — c\'est '
          + 'l\'utilisateur qui, après relecture, appuie lui-même sur « Valider et exporter ».',
        inputSchema: {
            type: 'object',
            properties: {
                sessionId: SESSION_ID,
                rapport: {
                    type: 'string',
                    description: 'Quelques phrases pour l\'utilisateur : ce qui a été rempli, les choix faits, les points à vérifier.',
                },
            },
            required: ['sessionId'],
        },
        verbe: 'terminer',
    },
    {
        name: 'worker_signaler_anomalie',
        description:
            'PHASE BÊTA — consigne, dans un journal destiné au développeur du Worker, quelque '
          + 'chose qui ne tient pas debout dans ce qu\'on t\'a donné : des données qui '
          + 'contredisent la réalité de l\'affaire, un libellé de colonne qui ne décrit pas ce '
          + 'qu\'elle contient, une règle impossible à respecter, une valeur attendue absente '
          + 'd\'une liste de choix, une colonne dont tu aurais besoin et que le mode masque. '
          + 'N\'écrit RIEN dans la grille et n\'interrompt rien : signale, puis continue avec ce '
          + 'que tu as. Ce journal ne s\'adresse pas à l\'utilisateur — ne lui explique pas '
          + 'l\'anomalie ; ajoute seulement à ton rapport de fin la phrase que cet outil te rend '
          + 'dans « phraseARapporter », et rien d\'autre à ce sujet.',
        inputSchema: {
            type: 'object',
            properties: {
                sessionId:   SESSION_ID,
                description: {
                    type: 'string',
                    description: 'Ce que tu as constaté, en clair, et en quoi cela cloche. Écris-le pour quelqu\'un qui n\'a pas la session sous les yeux.',
                },
                gravite: {
                    type: 'string',
                    enum: ['mineure', 'genante', 'bloquante'],
                    description: 'mineure : gênant mais sans effet sur le résultat. genante (défaut) : il a fallu contourner. bloquante : le travail demandé n\'est pas faisable en l\'état.',
                },
                elements: {
                    description: 'Facultatif : ce sur quoi porte le constat — clés de colonnes, _id de lignes, valeurs fautives. Forme libre.',
                },
                mode: { type: 'string', description: 'Mode de travail concerné, si la question s\'y rapporte.' },
            },
            required: ['sessionId', 'description'],
        },
        verbe: 'anomalie',
    },
];

const PAR_NOM = {};
OUTILS.forEach((o) => { PAR_NOM[o.name] = o; });

// ── Protocole ─────────────────────────────────────────────────────────────────
function ecrire(message) {
    process.stdout.write(JSON.stringify(message) + '\n');
}

function repondre(id, resultat) {
    ecrire({ jsonrpc: '2.0', id, result: resultat });
}

function repondreErreur(id, code, message) {
    ecrire({ jsonrpc: '2.0', id, error: { code, message } });
}

async function traiter(msg) {
    // Une notification n'a pas d'id : on ne répond jamais.
    const estNotification = msg.id === undefined || msg.id === null;

    switch (msg.method) {
        case 'initialize':
            return repondre(msg.id, {
                protocolVersion: (msg.params && msg.params.protocolVersion) || VERSION_PROTOCOLE,
                capabilities: { tools: {} },
                serverInfo: { name: 'ai-worker', version: '1.0.0' },
            });

        case 'notifications/initialized':
        case 'initialized':
            return;                                   // rien à répondre

        case 'tools/list':
            return repondre(msg.id, {
                tools: OUTILS.map((o) => ({
                    name: o.name,
                    description: o.description,
                    inputSchema: o.inputSchema,
                })),
            });

        case 'tools/call': {
            const nom = msg.params && msg.params.name;
            const outil = PAR_NOM[nom];
            if (!outil) return repondreErreur(msg.id, -32602, 'Outil inconnu : ' + nom);

            const r = await appeler(outil.verbe, (msg.params && msg.params.arguments) || {});

            return repondre(msg.id, {
                content: [{
                    type: 'text',
                    text: r.ok ? JSON.stringify(r.data, null, 2) : r.message,
                }],
                isError: !r.ok,
            });
        }

        case 'ping':
            return repondre(msg.id, {});

        default:
            if (estNotification) return;
            return repondreErreur(msg.id, -32601, 'Méthode non gérée : ' + msg.method);
    }
}

// ── Boucle de lecture ─────────────────────────────────────────────────────────
// Rien ne démarre à l'import : les deux points d'entrée appellent demarrer().
function demarrer() {
    let tampon = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (bloc) => {
        tampon += bloc;
        let i;
        while ((i = tampon.indexOf('\n')) !== -1) {
            const ligne = tampon.slice(0, i).trim();
            tampon = tampon.slice(i + 1);
            if (!ligne) continue;

            let msg;
            try {
                msg = JSON.parse(ligne);
            } catch (e) {
                process.stderr.write('[mcp-worker] ligne illisible ignorée\n');
                continue;
            }
            // Une erreur sur un message ne doit jamais tuer le serveur.
            Promise.resolve(traiter(msg)).catch((e) => {
                process.stderr.write('[mcp-worker] ' + (e && e.message) + '\n');
                if (msg.id !== undefined && msg.id !== null) {
                    repondreErreur(msg.id, -32603, (e && e.message) || 'erreur interne');
                }
            });
        }
    });

    process.stdin.on('end', () => process.exit(0));
    process.stderr.write('[mcp-worker] prêt (' + OUTILS.length + ' outils)\n');
}

module.exports = { demarrer };

/**
 * AI Worker — claudeConfig.js
 *
 * Branche la façade MCP du Worker dans la configuration de Claude Code, pour que
 * l'utilisateur n'ait aucune commande à taper.
 *
 * Pourquoi ce module existe. Le canal MCP ne se voit pas : la grille affiche un
 * numéro de session, l'utilisateur le donne à Claude — et si Claude n'a pas la
 * façade, il ne se passe RIEN. Pas d'erreur, pas de message : Claude reçoit un
 * numéro dont il ne peut rien faire. Le premier essai de production s'est arrêté
 * exactement là. Un bouton qui inscrit la façade, et qui dit où on en est, coûte
 * moins cher que l'explication qu'il faudrait donner sans lui.
 *
 * Ce qu'il écrit : la clé `mcpServers.worker` de `~/.claude.json` — la portée
 * « user » de Claude Code, celle qui vaut quelle que soit la fenêtre ouverte.
 * C'est le même fichier, et la même entrée, que `claude mcp add -s user`.
 *
 * Ce qu'il ne fait pas : toucher au reste du fichier. Il est relu, modifié à un
 * seul endroit, sauvegardé à côté, puis réécrit par un renommage atomique. Si
 * Claude tourne pendant l'opération, il peut réécrire le fichier de son côté et
 * emporter l'entrée : c'est pourquoi `etat()` existe, et pourquoi le message
 * invite à ouvrir une session NEUVE — c'est à son ouverture que Claude lit.
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const NOM_SERVEUR = 'worker';

// CLAUDE_CONFIG_DIR déplace le dossier entier ; sans elle, c'est le profil.
function cheminConfig() {
    return path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
}

// Ce que Claude devra lancer. Deux dispositions, et le Worker est le seul à
// savoir dans laquelle il tourne :
//   - exe compilé (pkg)   → lui-même, avec --mcp (le cas de l'utilisateur) ;
//   - dépôt (node server) → le point d'entrée du dépôt, avec le node courant.
function commandeFacade() {
    if (typeof process.pkg !== 'undefined') {
        return { command: process.execPath, args: ['--mcp'] };
    }
    return { command: process.execPath, args: [path.join(__dirname, 'tools', 'mcp-worker', 'server.js')] };
}

// La même chose en une ligne à taper — pour qui préfère la commande, et pour le
// cas où l'écriture échoue (fichier verrouillé, poste d'entreprise, etc.).
function commandeLisible() {
    const { command, args } = commandeFacade();
    const cite = (s) => (/\s/.test(s) ? '"' + s + '"' : s);
    return 'claude mcp add -s user ' + NOM_SERVEUR + ' -- ' + cite(command) + ' ' + args.map(cite).join(' ');
}

// Comparaison de chemins : Windows ne distingue pas la casse, et l'entrée a pu
// être écrite à la main.
function memeChemin(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function memeCommande(entree, attendu) {
    if (!entree || !memeChemin(entree.command, attendu.command)) return false;
    const args = Array.isArray(entree.args) ? entree.args : [];
    if (args.length !== attendu.args.length) return false;
    return args.every((a, i) => (String(a).startsWith('--') ? a === attendu.args[i] : memeChemin(a, attendu.args[i])));
}

/**
 * Où en est le branchement, sans rien modifier.
 *
 * @returns {{branche:boolean, entreePresente:boolean, configPresente:boolean,
 *            obsolete:boolean, illisible:boolean, chemin:string, commande:string}}
 */
function etat() {
    const chemin  = cheminConfig();
    const attendu = commandeFacade();
    const commun  = { chemin: chemin, commande: commandeLisible() };

    let config;
    try {
        config = JSON.parse(fs.readFileSync(chemin, 'utf8'));
    } catch (e) {
        // Fichier absent : Claude Code n'a jamais tourné sur ce poste, ou n'y est
        // pas installé. Illisible : on ne touchera à rien, et on le dira.
        return Object.assign({}, commun, {
            branche: false, entreePresente: false, configPresente: false,
            obsolete: false, illisible: e.code !== 'ENOENT',
        });
    }

    const entree = config && config.mcpServers ? config.mcpServers[NOM_SERVEUR] : null;
    return Object.assign({}, commun, {
        branche:        memeCommande(entree, attendu),
        entreePresente: !!entree,
        configPresente: true,
        // Inscrit, mais sur un autre exécutable : XSpro a été réinstallé ailleurs,
        // ou l'entrée vient d'un dépôt. Le bouton propose alors de corriger.
        obsolete:       !!entree && !memeCommande(entree, attendu),
        illisible:      false,
    });
}

// Sauvegarde : ce fichier ne nous appartient pas. Écrite UNE SEULE FOIS, au premier
// geste de XSpro sur ce poste — elle garde donc la configuration telle qu'elle était
// avant que nous y touchions. La réécrire à chaque branchement en ferait l'état
// d'avant le dernier clic, c'est-à-dire presque rien : au troisième aller-retour,
// elle ne contiendrait plus que nos propres écritures.
function sauvegarderUneFois(chemin, brut) {
    if (brut === null) return;                       // il n'y avait pas de fichier à sauver
    const sauvegarde = chemin + '.avant-xspro';
    try {
        if (!fs.existsSync(sauvegarde)) fs.writeFileSync(sauvegarde, brut);
    } catch (_) { /* non bloquant : une sauvegarde manquante n'empêche pas d'agir */ }
}

/**
 * Inscrit la façade. Idempotent : réécrire une entrée déjà juste ne change rien.
 *
 * @returns {{ok:boolean, message:string}} message destiné à l'utilisateur.
 */
function brancher() {
    const chemin  = cheminConfig();
    const attendu = commandeFacade();

    let config = {};
    let brut   = null;
    try {
        brut   = fs.readFileSync(chemin, 'utf8');
        config = JSON.parse(brut);
    } catch (e) {
        if (e.code !== 'ENOENT') {
            return { ok: false, message:
                'La configuration de Claude existe mais ne peut pas être lue (' + (e.code || e.message)
                + "). Rien n'a été modifié — reste la commande à taper." };
        }
        // Absente : on la crée. Claude Code y ajoutera ses propres clés à son
        // premier démarrage ; une configuration qui ne porte que mcpServers lui va.
    }

    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        return { ok: false, message:
            "La configuration de Claude n'a pas la forme attendue. Rien n'a été modifié." };
    }

    sauvegarderUneFois(chemin, brut);

    config.mcpServers = config.mcpServers || {};
    config.mcpServers[NOM_SERVEUR] = { command: attendu.command, args: attendu.args };

    // Renommage atomique : une coupure au mauvais moment ne laisse pas un fichier
    // à moitié écrit à la place de la configuration de l'utilisateur.
    const provisoire = chemin + '.xspro-tmp';
    try {
        fs.writeFileSync(provisoire, JSON.stringify(config, null, 2));
        fs.renameSync(provisoire, chemin);
    } catch (e) {
        try { fs.unlinkSync(provisoire); } catch (_) { /* déjà parti */ }
        return { ok: false, message:
            "L'inscription a échoué (" + (e.code || e.message) + "). Rien n'a été modifié — "
            + 'reste la commande à taper.' };
    }

    // Contrôle de relecture : si Claude tournait et a réécrit le fichier entre
    // temps, mieux vaut le dire que laisser croire que c'est fait.
    if (!etat().branche) {
        return { ok: false, message:
            "L'inscription a été écrite puis n'a pas été retrouvée : Claude tournait sans doute "
            + 'et a réécrit sa configuration. Fermer Claude, réessayer — ou taper la commande.' };
    }

    return { ok: true, message:
        "Claude est branché. Ouvrir une fenêtre Claude NEUVE pour qu'il le voie : "
        + "sa configuration est lue à l'ouverture, pas en cours de route." };
}

/**
 * Retire l'inscription. C'est la réponse à « peut-on revenir en arrière ».
 *
 * @returns {{ok:boolean, message:string}}
 */
function debrancher() {
    const chemin = cheminConfig();

    let brut, config;
    try {
        brut   = fs.readFileSync(chemin, 'utf8');
        config = JSON.parse(brut);
    } catch (e) {
        if (e.code === 'ENOENT') {
            return { ok: true, message: "Rien à débrancher : Claude n'a aucune configuration sur ce poste." };
        }
        return { ok: false, message:
            'La configuration de Claude existe mais ne peut pas être lue (' + (e.code || e.message)
            + "). Rien n'a été modifié." };
    }

    if (!config || typeof config !== 'object' || !config.mcpServers || !config.mcpServers['worker']) {
        return { ok: true, message: 'Rien à débrancher : aucune inscription « worker » dans la configuration de Claude.' };
    }

    sauvegarderUneFois(chemin, brut);
    delete config.mcpServers['worker'];

    const provisoire = chemin + '.xspro-tmp';
    try {
        fs.writeFileSync(provisoire, JSON.stringify(config, null, 2));
        fs.renameSync(provisoire, chemin);
    } catch (e) {
        try { fs.unlinkSync(provisoire); } catch (_) { /* déjà parti */ }
        return { ok: false, message:
            'Le débranchement a échoué (' + (e.code || e.message) + "). Rien n'a été modifié." };
    }

    // Même contrôle qu'au branchement : le disque fait foi, pas notre intention.
    if (etat().entreePresente) {
        return { ok: false, message:
            "L'inscription a été retirée puis retrouvée : Claude tournait sans doute et a réécrit "
            + 'sa configuration. Fermer Claude, puis recommencer.' };
    }

    return { ok: true, message:
        'Claude est débranché. Les grilles ne pourront plus être remplies par lui.\n\n'
        + "Une fenêtre Claude déjà ouverte garde ses outils jusqu'à sa fermeture : la configuration "
        + "n'est relue qu'à l'ouverture." };
}

module.exports = { etat: etat, brancher: brancher, debrancher: debrancher, cheminConfig: cheminConfig,
                   commandeLisible: commandeLisible, NOM_SERVEUR: NOM_SERVEUR };

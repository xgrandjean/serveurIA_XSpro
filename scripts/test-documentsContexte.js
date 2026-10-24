/**
 * AI Worker — scripts/test-documentsContexte.js
 *
 * Les documents de contexte joints par XSpro (champ `documents` du POST /process) : le
 * parcours complet d'un chapitre en cours de rédaction, par exemple. Ce que l'utilisateur
 * joignait à la main par 📎, XSpro le joint lui-même — et il doit partir à CHAQUE appel,
 * sur les trois canaux.
 *
 * Ce qu'il protège :
 *   - la session garde les documents, normalisés, et la copie brute (xsproPayload, qui part
 *     au navigateur) ne les porte plus ;
 *   - fichiersDeSession les met devant les pièces jointes à la main ;
 *   - le résumé (pastille, worker_contexte) ne contient jamais le texte ;
 *   - le prompt les contient, et le plafond fichiers.maxCaracteres coupe en le disant ;
 *   - worker_documents les sert par tranches, et worker_contexte les annonce.
 *
 *   node scripts/test-documentsContexte.js
 */

'use strict';

const path = require('path');
const RACINE = path.join(__dirname, '..');

const SM          = require(path.join(RACINE, 'sessionManager.js'));
const llmClient   = require(path.join(RACINE, 'llmClient.js'));
const fileHandlers = require(path.join(RACINE, 'fileHandlers.js'));
const { installMcpChannel } = require(path.join(RACINE, 'mcpChannel.js'));

let ok = true;
const verifier = (cond, nom) => { console.log((cond ? 'PASS' : 'FAIL') + ' - ' + nom); if (!cond) ok = false; };

const parcours = JSON.stringify({ type: 'parcours', chapitres: [{ numero: 1, titre: 'Ohm', questions: ['U = R × I ?'] }] });
const document = { name: 'parcours-P100.json', mimeType: 'application/json', data: Buffer.from(parcours).toString('base64'), libelle: 'Parcours complet' };

(async () => {
    // ── Session ──────────────────────────────────────────────────────────────────
    const session = SM.createSession({
        sessionId: 'essai-documents-' + Date.now(), contextName: 'formulaireListeQuestions',
        data: { lignes: [{ contenu: 'q1' }] }, workerConfig: { colonnes: [{ cle: 'contenu' }] },
        documents: [document, { name: '', data: 'x' }, { name: 'sans-donnees.json' }],
    });
    verifier(session.documents.length === 1, 'session : les documents invalides sont écartés');
    verifier(session.documents[0].caracteres === parcours.length && session.documents[0].size > 0, 'session : taille et caractères calculés');
    verifier(session.xsproPayload.documents === undefined, 'session : la copie brute (navigateur) ne porte pas les documents');
    verifier(SM.createSession({ sessionId: 'essai-sans-' + Date.now(), contextName: 'x', data: {} }).documents.length === 0,
             'session sans documents : liste vide');

    const joint = { name: 'joint.txt', mimeType: 'text/plain', data: Buffer.from('à la main').toString('base64') };
    const tous = SM.fichiersDeSession(session, [joint]);
    verifier(tous.length === 2 && tous[0].name === 'parcours-P100.json' && tous[1].name === 'joint.txt',
             'fichiersDeSession : les documents de la session, puis ceux joints à la main');

    const resume = SM.resumeDocuments(session, 10);
    verifier(resume.length === 1 && resume[0].nom === 'parcours-P100.json' && resume[0].libelle === 'Parcours complet',
             'résumé : nom et libellé');
    verifier(!JSON.stringify(resume).includes('Ohm') && resume[0].tronque === true, 'résumé : jamais le texte, coupé au-delà du plafond');

    // ── Prompt ───────────────────────────────────────────────────────────────────
    const blocs = await llmClient.buildUserContent('DEMANDE', SM.fichiersDeSession(session, []), 'openai');
    const texte = JSON.stringify(blocs);
    verifier(texte.includes('parcours-P100.json') && texte.includes('Ohm'), 'prompt : le document est injecté en texte');

    fileHandlers.reglerMaxCaracteres(20);
    const coupe = JSON.stringify(await llmClient.buildUserContent('DEMANDE', SM.fichiersDeSession(session, []), 'openai'));
    verifier(coupe.includes('tronqué à 20 caractères') && !coupe.includes('U = R'), 'prompt : le plafond coupe, et le dit');
    fileHandlers.reglerMaxCaracteres(60000);

    // ── Canal MCP ────────────────────────────────────────────────────────────────
    const app = { options() {}, post() {} };
    const { verbes } = installMcpChannel(app, { SM, wsSend() {}, dataRoot: path.join(require('os').tmpdir(), 'essai-documents') });

    const liste = await verbes.documents({ sessionId: session.sessionId });
    verifier(Array.isArray(liste.documents) && liste.documents[0].nom === 'parcours-P100.json', 'worker_documents sans nom : la liste');

    const t1 = await verbes.documents({ sessionId: session.sessionId, nom: 'parcours-P100.json', longueur: 1000 });
    verifier(t1.contenu === parcours && t1.suite === null && t1.total === parcours.length, 'worker_documents : tout tient en une tranche');

    const t2 = await verbes.documents({ sessionId: session.sessionId, nom: 'parcours-P100.json', debut: 10, longueur: 1000 });
    verifier(t2.contenu === parcours.slice(10) && t2.debut === 10, 'worker_documents : reprise à « debut »');

    const inconnu = await verbes.documents({ sessionId: session.sessionId, nom: 'autre.json' });
    verifier(inconnu.erreur && inconnu.codeHttp === 404 && inconnu.erreur.includes('parcours-P100.json'), 'worker_documents : un nom inconnu est refusé, la liste dite');

    const ctx = await verbes.contexte({ sessionId: session.sessionId, briefing: false });
    verifier(Array.isArray(ctx.documents) && ctx.documents[0].nom === 'parcours-P100.json' && !JSON.stringify(ctx.documents).includes('Ohm'),
             'worker_contexte : annonce les documents, sans leur contenu');

    // ── Retrait ──────────────────────────────────────────────────────────────────
    verifier(SM.retirerDocument(session, 'parcours-P100.json') === true && SM.fichiersDeSession(session, []).length === 0,
             'retrait : le document ne part plus');
    const ctx2 = await verbes.contexte({ sessionId: session.sessionId, briefing: false });
    verifier(ctx2.documents === undefined, 'worker_contexte : plus rien à annoncer');

    console.log(ok ? '\nTOUS LES TESTS PASSENT' : '\nÉCHEC');
    process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

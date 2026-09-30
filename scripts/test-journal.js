/**
 * AI Worker — scripts/test-journal.js
 *
 * Le journal du chemin clé API (journalTraitement.js, tenu par llmClient.run) avec un FAUX
 * `fetch` : aucun appel réseau, aucune clé consommée. Ce qui compte —
 *   - le journal a la même forme que celui de XSProAssist (mesuresDe rend les mêmes colonnes) ;
 *   - il dit ce qui a été retenu contre ce que le modèle déclarait ;
 *   - une correction JSON, une réponse coupée, un modèle injoignable, un mode JSON replié,
 *     un plan : chacun laisse sa trace, et l'erreur remontée nomme la cause.
 *
 *   node scripts/test-journal.js        (npm run test:journal)
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const RACINE  = path.join(__dirname, '..');
const PAYLOAD = path.join(RACINE, 'standalone', 'standalone-payload-detailsDevis.json');

const SM                               = require('../sessionManager');
const { resolveEffectiveWorkerConfig } = require('../viewResolver');
const llmClient                        = require('../llmClient');
const Journal                          = require('../journalTraitement');

let reussis = 0;
let echoues = 0;
function verifier(nom, condition, detail) {
    if (condition) { reussis++; console.log('  PASS  ' + nom); }
    else { echoues++; console.log('  FAIL  ' + nom + (detail ? '  → ' + String(detail).slice(0, 300) : '')); }
}
function titre(t) { console.log(''); console.log(t); }

if (!fs.existsSync(PAYLOAD)) {
    console.log(`Charge d'essai absente : ${path.relative(RACINE, PAYLOAD)} — ce test a besoin d'une charge standalone (cf. .gitignore).`);
    process.exit(1);
}

// ── Le faux fetch : une suite de réponses, servies dans l'ordre ──────────────────
let scenario = [];
let envois   = [];
global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    envois.push({ url, body });
    const r = scenario.shift();
    if (r === undefined) throw new Error('scénario épuisé');
    const rep = typeof r === 'function' ? r(body) : r;
    if (rep.reject) { const e = new Error(rep.reject); e.name = rep.name || 'TypeError'; throw e; }
    return {
        ok: rep.status < 400, status: rep.status,
        json: async () => rep.json,
        text: async () => (typeof rep.json === 'string' ? rep.json : JSON.stringify(rep.json)),
    };
};
const completion = (content, extra = {}) => ({
    status: 200,
    json: { choices: [{ message: { content }, finish_reason: extra.finish_reason || 'stop' }], usage: { total_tokens: extra.jetons || 123 } },
});
const http = (status, message) => ({ status, json: { error: { message } } });

const payloadBase = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8'));
delete payloadBase._origin;
let compteur = 0;
function nouvelleSession(modele) {
    const payload = { ...payloadBase, sessionId: `journal_test_${Date.now()}_${++compteur}` };
    const session = SM.createSession(payload);
    session.origin = 'xspro';
    session.canal  = 'api';
    // Le cache du mode JSON est par endpoint::modèle : un modèle par scénario, pour que les
    // scénarios ne s'influencent pas.
    session.ia = { ...session.ia, model: modele || `faux-${compteur}` };
    resolveEffectiveWorkerConfig(session);
    SM.setStatus(session, SM.STATUS.ACTING);
    return session;
}

async function lancer(session, prompt, mode = 'act', activeMode = null) {
    session.activeMode = activeMode;
    const etapes = [];
    let done = null;
    let plan = null;
    let erreur = null;
    try {
        await llmClient.run(session, prompt, mode, {
            onPlan:       (p) => { plan = p; },
            onCellUpdate: (i, cle, v) => SM.setCellValue(session, i, cle, v),
            onDone:       (rows, meta) => { session.rows = rows; done = { rows, meta }; },
            onEtape:      (e) => etapes.push(e),
        }, []);
    } catch (e) { erreur = e; }
    return { etapes, done, plan, erreur, journal: session.journalTraitement };
}

// ══════════════════════════════════════════════════════════════════════════════
(async () => {
    // ── 1. Cas nominal : retenu contre déclaré ─────────────────────────────────
    titre('Cas nominal (contrat par actions)');
    {
        const session = nouvelleSession();
        const dejaLa  = session.rows[1].designation;   // une « modification » à l'identique
        scenario = [completion(JSON.stringify({
            rapport: 'Un chapitre revu, une ligne ajoutée.',
            actions: [
                { _action: 'update', _id: 1, designation: 'Chapitre revu' },
                { _action: 'update', _id: 2, designation: dejaLa },
                { _action: 'insert', _apres: 'fin', niveauListe: '○ ○ ●', designation: 'Nouvelle ligne' },   // le label, comme le FORMAT l'enseigne
            ],
        }), { jetons: 4321 })];
        envois = [];
        const r = await lancer(session, 'Revois le chapitre et ajoute une ligne.', 'act', 'decomposition');   // contrat tableau
        verifier('le traitement aboutit', !r.erreur && !!r.done, r.erreur && r.erreur.message);
        verifier('le journal est sur la session, canal api, mode act, la demande',
            !!(r.journal && r.journal.canal === 'api' && r.journal.mode === 'act' && /Revois le chapitre/.test(r.journal.demande)),
            JSON.stringify(r.journal && { canal: r.journal.canal, mode: r.journal.mode, demande: r.journal.demande }));
        const ev = r.etapes.map((e) => e.evenement);
        verifier('les étapes : début, un appel au modèle, fin', ev.join(',') === 'debut,modele,fin', ev.join(','));
        const debut = r.etapes[0];
        verifier('le début dit le modèle, les lignes, la taille de l\'envoi',
            debut.modele === session.ia.model && debut.lignes === 7 && debut.tailleEnvoi > 1000, JSON.stringify(debut));
        const appel = r.etapes[1];
        verifier('l\'appel porte la durée, les jetons, la taille de la réponse — et pas de mode JSON (contrat tableau)',
            appel.ok === true && typeof appel.dureeMs === 'number' && appel.jetons === 4321 && appel.tailleReponse > 50 && appel.jsonMode === false,
            JSON.stringify(appel));
        const fin = r.etapes[2];
        verifier('la fin dit ce qui est retenu : 1 ajoutée, 1 modifiée, 0 supprimée',
            fin.issue === 'terminee' && fin.inserees === 1 && fin.modifiees === 1 && fin.supprimees === 0, JSON.stringify(fin));
        verifier('… et ce que le modèle déclarait : 2 modifications dont 1 sans effet',
            !!(fin.declarees && fin.declarees.modifiees === 2 && fin.declarees.inserees === 1 && fin.sansEffet === 1), JSON.stringify(fin.declarees));
        verifier('la fin sait qu\'un rapport a été rendu, et compte les tours', fin.rapport === true && fin.tours === 1, JSON.stringify(fin));
        const m = Journal.mesuresDe(r.journal);
        verifier('mesuresDe rend les mêmes colonnes que pour XSProAssist',
            m.canal === 'api' && m.tours === 1 && m.jetons === 4321 && m.envoiCar > 1000 && m.relances === 0 && m.appelsOutils === 0
            && m.inserees === 1 && m.modifiees === 1 && m.coupee === false && m.issue === 'terminee',
            JSON.stringify(m));
        verifier('la grille a bien la cellule et la ligne en attente (mode revue)',
            session.rows[0].designation === 'Chapitre revu' && !!session.rows[0].__pendingFields && session.rows[session.rows.length - 1].__pendingInsert === true);
        const inseree = session.rows[session.rows.length - 1];
        const valeurDetail = (session.selectChoix.niveauListe.choix.find((c) => String(c.label).trim() === '○ ○ ●') || {}).valeur;
        verifier('le label de niveau d\'une ligne insérée devient sa valeur, et non 0 (résolu avant la conversion de type)',
            inseree.niveauListe === valeurDetail && valeurDetail !== undefined && valeurDetail !== 0,
            `niveauListe = ${JSON.stringify(inseree.niveauListe)}, attendu ${JSON.stringify(valeurDetail)}`);
        verifier('en décomposition (tableau attendu), la requête ne demande PAS json_object', !envois[0].body.response_format, JSON.stringify(envois[0].body.response_format));

        // Le contrat objet { rapport, actions } (mode chiffrage) demande, lui, le mode JSON.
        const session2 = nouvelleSession();
        scenario = [completion(JSON.stringify({ rapport: 'ok', actions: [{ _action: 'update', _id: 3, prixAchatUnitaire: 12 }] }))];
        envois = [];
        const r2 = await lancer(session2, 'Chiffre.', 'act', 'chiffrage');
        verifier('en chiffrage (objet attendu), la requête demande json_object et le journal le note',
            !r2.erreur && envois[0].body.response_format && envois[0].body.response_format.type === 'json_object' && r2.etapes[1].jsonMode === true,
            JSON.stringify({ rf: envois[0].body.response_format, etape: r2.etapes[1] }));
    }

    // ── 2. JSON invalide, puis corrigé ─────────────────────────────────────────
    titre('Correction JSON');
    {
        const session = nouvelleSession();
        scenario = [
            completion('Voici les actions : { pas du json'),
            completion(JSON.stringify({ actions: [{ _action: 'update', _id: 1, designation: 'Corrigé' }] })),
        ];
        const r = await lancer(session, 'x');
        const ev = r.etapes.map((e) => e.evenement);
        verifier('la correction laisse une relance entre deux appels', ev.join(',') === 'debut,modele,relance,modele,fin', ev.join(','));
        verifier('la relance dit pourquoi', /JSON invalide/.test(r.etapes[2].motif || ''), r.etapes[2].motif);
        verifier('le second appel est le tour 2', r.etapes[3].tour === 2);
        verifier('le traitement aboutit, 1 ligne modifiée', !r.erreur && r.etapes[4].issue === 'terminee' && r.etapes[4].modifiees === 1, JSON.stringify(r.etapes[4]));
        verifier('mesuresDe compte la relance et les deux tours', Journal.mesuresDe(r.journal).relances === 1 && Journal.mesuresDe(r.journal).tours === 2);
    }

    // ── 3. Réponse coupée par la limite de sortie ──────────────────────────────
    titre('Réponse coupée');
    {
        const session = nouvelleSession();
        scenario = [
            completion('{"actions":[{"_action":"update","_id":1,"designation":"Un très long', { finish_reason: 'length' }),
            completion('{"actions":[{"_action":"update","_id":1,"designation":"Un très long', { finish_reason: 'length' }),
        ];
        const r = await lancer(session, 'x');
        verifier('l\'erreur remonte', !!r.erreur, r.erreur && r.erreur.message);
        verifier('les appels notent finish_reason=length', r.etapes.filter((e) => e.evenement === 'modele').every((e) => e.finish_reason === 'length'));
        const fin = r.journal.fin;
        verifier('la fin nomme la réponse coupée comme cause', !!(fin && fin.issue === 'erreur' && fin.coupee === true && /coupée/.test(fin.motif)), JSON.stringify(fin));
        verifier('l\'erreur porte une suggestion qui dit quoi faire', /coupée/.test(r.erreur.suggestion || ''), r.erreur.suggestion);
        verifier('mesuresDe le dit aussi', Journal.mesuresDe(r.journal).coupee === true);
    }

    // ── 4. Modèle injoignable, ou en erreur ────────────────────────────────────
    titre('Modèle injoignable');
    {
        const session = nouvelleSession();
        scenario = [http(500, 'boom')];
        const r = await lancer(session, 'x');
        verifier('un 500 laisse un appel en échec et une fin « erreur »',
            !!r.erreur && r.etapes[1].ok === false && r.etapes[1].status === 500 && r.journal.fin.issue === 'erreur', JSON.stringify(r.etapes[1]));

        const session2 = nouvelleSession();
        scenario = [{ reject: 'aborted', name: 'AbortError' }];
        const r2 = await lancer(session2, 'x');
        verifier('un délai dépassé donne une fin « injoignable », cause timeout',
            !!r2.erreur && r2.journal.fin.issue === 'injoignable' && r2.etapes[1].cause === 'timeout', JSON.stringify(r2.journal.fin));
    }

    // ── 5. Mode JSON replié (400 puis succès sans response_format) ─────────────
    titre('Mode JSON replié');
    {
        const session = nouvelleSession();
        scenario = [
            (body) => (body.response_format ? http(400, 'response_format not supported') : completion('[]')),
            (body) => (body.response_format ? http(400, 'response_format not supported') : completion(JSON.stringify({ actions: [] }))),
        ];
        envois = [];
        const r = await lancer(session, 'x', 'act', 'chiffrage');
        verifier('un seul tour, deux essais, mode JSON replié',
            !r.erreur && r.etapes[1].tour === 1 && r.etapes[1].essais === 2 && r.etapes[1].jsonMode === false, JSON.stringify(r.etapes[1]));
        verifier('rien de retenu, rien de déclaré', r.journal.fin.inserees === 0 && r.journal.fin.modifiees === 0 && r.journal.fin.declarees.modifiees === 0);
    }

    // ── 6. Mode plan ───────────────────────────────────────────────────────────
    titre('Plan');
    {
        const session = nouvelleSession();
        scenario = [completion('Je propose de revoir le chapitre 1.')];
        const r = await lancer(session, 'Que ferais-tu ?', 'plan');
        verifier('un plan laisse une fin « plan », sans retenu', !!r.plan && r.journal.fin.issue === 'plan' && r.journal.mode === 'plan' && r.journal.fin.tailleReponse > 10, JSON.stringify(r.journal.fin));
        verifier('la requête du plan ne demande pas le mode JSON', !envois[envois.length - 1].body.response_format);
    }

    // ── 7. mesuresDe sur un journal de XSProAssist ─────────────────────────────
    titre('mesuresDe, forme commune');
    {
        const session = { };
        const j = Journal.ouvrir(session, { canal: 'assist', modele: 'm', demande: 'd' }, { maintenant: (() => { let t = 0; return () => (t += 100); })() });
        j.etape({ evenement: 'debut', lignes: 3 });
        j.etape({ evenement: 'modele', tour: 1, dureeMs: 50, ok: true, appels: 1, tailleEnvoi: 1000, jetons: 10 });
        j.etape({ evenement: 'outil', nom: 'worker_ecrire_cellules', ok: true });
        j.etape({ evenement: 'outil', nom: 'worker_inserer_lignes', ok: false, erreur: 'x' });
        j.etape({ evenement: 'relance' });
        j.etape({ evenement: 'modele', tour: 2, dureeMs: 60, ok: true, appels: 1, tailleEnvoi: 1200, jetons: 12 });
        j.fin('terminee', null, { appelsOutils: 2, refusOutils: 1, relances: 1, cellulesEcrites: 4, inserees: 0, supprimees: 0, cellules: 4 });
        const m = Journal.mesuresDe(session.journalTraitement);
        verifier('les sommes et les comptes sont justes',
            m.tours === 2 && m.dureeModeleMs === 110 && m.jetons === 22 && m.envoiCar === 2200 && m.relances === 1
            && m.appelsOutils === 2 && m.refusOutils === 1 && m.cellules === 4 && m.issue === 'terminee' && m.declarees === null,
            JSON.stringify(m));
        verifier('la fin compte les tours d\'elle-même', session.journalTraitement.fin.tours === 2);
        verifier('un journal absent rend null', Journal.mesuresDe(null) === null);
    }

    console.log('');
    console.log(reussis + ' PASS, ' + echoues + ' FAIL');
    process.exit(echoues === 0 ? 0 : 1);
})().catch((e) => {
    console.error('');
    console.error('Le harnais s\'est interrompu : ' + (e && e.stack));
    process.exit(1);
});

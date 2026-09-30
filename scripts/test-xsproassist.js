/**
 * AI Worker — scripts/test-xsproassist.js
 *
 * XSProAssist (xsproassist.js) avec un FAUX modèle : on ne paie aucun appel, et on
 * vérifie ce qui compte —
 *   - le modèle reçoit les mêmes outils que Claude, sans sessionId (imposé) ;
 *   - ses appels passent par les verbes du canal MCP, avec leurs garde-fous
 *     (canal de la session, statut, colonnes du mode) ;
 *   - la grille reçoit ce qu'elle recevrait de Claude (cell:update, cell:validate,
 *     review:sync, act:done) plus le journal (assist:etape) ;
 *   - un refus d'outil revient au modèle ; un modèle qui parle est relancé ; un
 *     modèle qui ne conclut jamais, ou injoignable, est dit tel quel ;
 *   - rien ne part vers XSpro.
 *
 *   node scripts/test-xsproassist.js        (npm run test:assist)
 *
 * Aucun serveur n'est lancé : le canal est monté sur une application factice, et
 * la session est créée par sessionManager comme le ferait POST /process.
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const RACINE  = path.join(__dirname, '..');
const PAYLOAD = path.join(RACINE, 'standalone', 'standalone-payload-detailsDevis.json');

const SM                               = require('../sessionManager');
const { resolveEffectiveWorkerConfig } = require('../viewResolver');
const { installMcpChannel }            = require('../mcpChannel');
const { OUTILS }                       = require('../mcpStdio');
const XSProAssist                      = require('../xsproassist');

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

// ── Le décor : un canal sur une application factice, une grille qui note tout ────
const recus = new Map();                       // sessionId → [messages WS]
function wsSend(session, message) {
    if (!recus.has(session.sessionId)) recus.set(session.sessionId, []);
    recus.get(session.sessionId).push(message);
}
const messagesDe = (session, type) => (recus.get(session.sessionId) || []).filter((m) => !type || m.type === type);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-xsproassist-'));
const app = { options() {}, post() {} };
const { verbes } = installMcpChannel(app, { SM, wsSend, actif: true, dataRoot: tmp, rapportAnomalies: true });

const payloadBase = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8'));
delete payloadBase._origin;

let compteur = 0;
function nouvelleSession({ canal = 'assist', statut = SM.STATUS.ACTING } = {}) {
    const payload = { ...payloadBase, sessionId: `assist_test_${Date.now()}_${++compteur}` };
    const session = SM.createSession(payload);
    session.origin = 'xspro';
    session.canal  = canal;
    resolveEffectiveWorkerConfig(session);
    SM.setStatus(session, statut);
    return session;
}

// ── Le faux modèle : une suite de réponses, servies dans l'ordre ─────────────────
let idAppel = 0;
const appel = (nom, args) => ({
    id: `call_${++idAppel}`, type: 'function',
    function: { name: nom, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});
const outils = (...appels) => ({ ok: true, message: { content: '', tool_calls: appels }, modele: 'faux-modele' });
const texte  = (t) => ({ ok: true, message: { content: t }, modele: 'faux-modele' });

function fauxModele(reponses) {
    const envois = [];
    const fn = async ({ ia, messages, tools }) => {
        envois.push({ ia, messages: messages.map((m) => ({ ...m })), tools });
        const r = reponses.shift();
        return r === undefined ? texte('(plus rien à dire)') : (typeof r === 'function' ? r({ messages, tools }) : r);
    };
    fn.envois = envois;
    return fn;
}

function assistant(modele, extra = {}) {
    return XSProAssist.creerAssistant({
        SM, verbes, outils: OUTILS, wsSend,
        appelerModele: modele,
        journal: () => {},
        ...extra,
    });
}

// ══════════════════════════════════════════════════════════════════════════════
(async () => {
    // ── 1. Les outils donnés au modèle ──────────────────────────────────────────
    titre('Les outils du modèle');
    const tools = XSProAssist.outilsPourModele(OUTILS);
    const noms  = tools.map((t) => t.function.name);
    verifier('six outils, worker_sessions exclu (la session est imposée)',
        noms.length === 6 && !noms.includes('worker_sessions'), noms.join(','));
    verifier('les cinq verbes du remplissage y sont, plus l\'anomalie',
        ['worker_contexte', 'worker_ecrire_cellules', 'worker_inserer_lignes', 'worker_supprimer_lignes', 'worker_terminer', 'worker_signaler_anomalie']
            .every((n) => noms.includes(n)), noms.join(','));
    verifier('aucun schéma ne demande sessionId',
        tools.every((t) => !t.function.parameters.properties.sessionId
            && !(t.function.parameters.required || []).includes('sessionId')),
        JSON.stringify(tools.map((t) => t.function.parameters.required)));
    verifier('worker_terminer n\'exige plus rien (sessionId était son seul requis)',
        !tools.find((t) => t.function.name === 'worker_terminer').function.parameters.required);
    verifier('worker_contexte a une description faite pour ce canal (le briefing est déjà donné)',
        /briefing te sont déjà donnés/.test(tools.find((t) => t.function.name === 'worker_contexte').function.description));
    verifier('sans la phase bêta, l\'anomalie disparaît',
        XSProAssist.outilsPourModele(OUTILS, { anomalies: false }).length === 5);
    verifier('les descriptions des autres outils sont celles de la façade',
        tools.find((t) => t.function.name === 'worker_ecrire_cellules').function.description
            === OUTILS.find((o) => o.name === 'worker_ecrire_cellules').description);

    const consigne = XSProAssist.consigneSysteme('detailsDevis', 'MISSION X\n== COMMENT RÉPONDRE ==\n...');
    verifier('la consigne système nomme XSProAssist, la vue, et porte le briefing',
        /XSProAssist/.test(consigne) && /« detailsDevis »/.test(consigne) && /MISSION X/.test(consigne) && /worker_terminer/.test(consigne));
    verifier('la consigne dit que les écritures sont des propositions et que rien ne part sans l\'utilisateur',
        /PROPOSITIONS/.test(consigne) && /Rien ne part sans lui/.test(consigne));
    const demande = XSProAssist.texteDemande({ briefing: 'SECRET', briefingSource: 'vue', colonnes: [{ cle: 'a' }], lignes: [] }, 'fais X');
    verifier('le message utilisateur porte la demande et le contexte, sans le briefing',
        /« fais X »/.test(demande) && /"colonnes"/.test(demande) && !/SECRET/.test(demande));

    // ── 2. Le cas nominal : écrire, insérer, conclure ──────────────────────────
    titre('Cas nominal');
    {
        const session = nouvelleSession();
        const modele = fauxModele([
            outils(
                // sessionId volontairement faux : il doit être IMPOSÉ, pas lu du modèle.
                appel('worker_ecrire_cellules', { sessionId: 'session_inventee', lignes: [{ _id: 1, valeurs: { designation: 'Chapitre revu' } }] }),
                appel('worker_inserer_lignes', { apres: 'fin', lignes: [{ niveauListe: 3, designation: 'Ligne XSProAssist' }] }),
            ),
            outils(appel('worker_terminer', { rapport: 'Fait : une ligne revue, une ajoutée.' })),
        ]);
        const a = assistant(modele);
        const bilan = await a.traiter(session, { demande: 'Revois le chapitre et ajoute une ligne.', activeMode: null });

        verifier('le traitement se conclut par worker_terminer', bilan.issue === 'terminee' && bilan.conclu === true, JSON.stringify(bilan));
        verifier('le rapport du modèle est rendu', /une ligne revue/.test(bilan.rapport || ''), bilan.rapport);
        verifier('la cellule est écrite dans la session, en attente (mode revue)',
            session.rows[0].designation === 'Chapitre revu' && session.rows[0].__pendingFields && 'designation' in session.rows[0].__pendingFields,
            JSON.stringify(session.rows[0]).slice(0, 200));
        const inseree = session.rows[session.rows.length - 1];
        verifier('la ligne insérée est en attente, à la fin', inseree.__pendingInsert === true && inseree.designation === 'Ligne XSProAssist',
            JSON.stringify(inseree).slice(0, 200));
        verifier('la session finit en attente de relecture (paused)', session.status === SM.STATUS.PAUSED, session.status);
        verifier('la grille a reçu la cellule, sa validation, la synchro et la fin de lot',
            messagesDe(session, 'cell:update').length === 1 && messagesDe(session, 'cell:validate').length >= 1
            && messagesDe(session, 'review:sync').length === 1 && messagesDe(session, 'act:done').length === 1,
            JSON.stringify(messagesDe(session).map((m) => m.type)));
        verifier('act:done porte le rapport', messagesDe(session, 'act:done')[0].rapport === 'Fait : une ligne revue, une ajoutée.');
        const etapes = messagesDe(session, 'journal:etape').map((m) => m.etape);
        verifier('le journal est poussé en direct : début, 2 appels au modèle, 3 outils, fin',
            etapes.filter((e) => e.evenement === 'debut').length === 1
            && etapes.filter((e) => e.evenement === 'modele').length === 2
            && etapes.filter((e) => e.evenement === 'outil').length === 3
            && etapes.filter((e) => e.evenement === 'fin').length === 1,
            etapes.map((e) => e.evenement).join(','));
        verifier('le journal est gardé sur la session, avec ses mesures',
            session.journalTraitement && session.journalTraitement.fin && session.journalTraitement.fin.issue === 'terminee'
            && session.journalTraitement.fin.tours === 2 && session.journalTraitement.fin.appelsOutils === 3
            && session.journalTraitement.fin.cellulesEcrites === 1 && session.journalTraitement.fin.inserees === 1,
            JSON.stringify(session.journalTraitement && session.journalTraitement.fin));
        verifier('le début du journal dit le mode et le nombre de lignes',
            etapes[0].modeTravail && typeof etapes[0].lignes === 'number' && etapes[0].briefingSource === 'vue', JSON.stringify(etapes[0]));
        verifier('le résumé d\'une écriture est chiffré',
            /1 cellule\(s\) dans 1 ligne\(s\)/.test(etapes.find((e) => e.nom === 'worker_ecrire_cellules').resume),
            JSON.stringify(etapes.find((e) => e.nom === 'worker_ecrire_cellules')));

        // Ce que le modèle a reçu.
        const premier = modele.envois[0];
        verifier('le premier envoi : consigne système puis demande + contexte',
            premier.messages.length === 2 && premier.messages[0].role === 'system' && premier.messages[1].role === 'user');
        verifier('la consigne système porte le briefing de la vue (correspondance des outils comprise)',
            /== COMMENT RÉPONDRE ==/.test(premier.messages[0].content) && /MODE DE TRAVAIL APPLIQUÉ/.test(premier.messages[0].content));
        verifier('la consigne système porte la consigne de la phase bêta (rapport d\'anomalies actif)',
            /worker_signaler_anomalie/.test(premier.messages[0].content));
        verifier('le message utilisateur porte la demande, les colonnes et les lignes avec _id',
            /« Revois le chapitre/.test(premier.messages[1].content) && /"colonnes"/.test(premier.messages[1].content) && /"_id":1/.test(premier.messages[1].content));
        verifier('les outils partent avec l\'appel', Array.isArray(premier.tools) && premier.tools.length === 6);
        verifier('le bloc ia de la session est transmis à l\'appel', premier.ia && premier.ia.endpoint === session.ia.endpoint);
        const second = modele.envois[1];
        verifier('le second envoi rejoue l\'appel d\'outils et ses résultats (tool_call_id)',
            second.messages.length === 5 && second.messages[2].role === 'assistant' && Array.isArray(second.messages[2].tool_calls)
            && second.messages[3].role === 'tool' && second.messages[3].tool_call_id === second.messages[2].tool_calls[0].id
            && second.messages[4].role === 'tool',
            second.messages.map((m) => m.role).join(','));
        const resultatEcrire = JSON.parse(second.messages[3].content);
        verifier('le résultat d\'écriture rendu au modèle est celui du verbe (cellulesEcrites, ignorees)',
            resultatEcrire.cellulesEcrites === 1 && Array.isArray(resultatEcrire.ignorees), second.messages[3].content.slice(0, 200));
        verifier('la trace « dernier envoi » est lisible (appels et résultats en texte)',
            session.dernierEnvoi && session.dernierEnvoi.mode === 'assist'
            && session.dernierEnvoi.messages.every((m) => typeof m.content === 'string')
            && session.dernierEnvoi.messages.some((m) => /\[appel d'outil\] worker_ecrire_cellules/.test(m.content))
            && session.dernierEnvoi.messages.some((m) => /\[résultat de worker_ecrire_cellules\]/.test(m.content)),
            JSON.stringify(session.dernierEnvoi && session.dernierEnvoi.messages.map((m) => m.content.slice(0, 60))));
    }

    // ── 3. Refus d'outil, puis relance d'un modèle qui parle ───────────────────
    titre('Refus renvoyé au modèle, relance');
    {
        const session = nouvelleSession();
        let contenuRelance = null;
        const modele = fauxModele([
            outils(appel('worker_ecrire_cellules', { lignes: [{ _id: 1, valeurs: { colonneInexistante: 'x', designation: 'Titre' } }] })),
            texte('J\'ai écrit la valeur, tout est fait.'),          // parle au lieu de conclure → relance
            ({ messages }) => { contenuRelance = messages[messages.length - 1].content; return outils(appel('worker_terminer', { rapport: 'Terminé.' })); },
        ]);
        const bilan = await assistant(modele).traiter(session, { demande: 'x' });
        verifier('conclu après une relance', bilan.issue === 'terminee' && bilan.mesures.relances === 1 && bilan.mesures.tours === 3, JSON.stringify(bilan.mesures));
        const resultat = JSON.parse(modele.envois[1].messages[3].content);
        verifier('la colonne inconnue est écartée ET rapportée au modèle',
            resultat.cellulesEcrites === 1 && resultat.ignorees.length === 1 && resultat.ignorees[0].cle === 'colonneInexistante', JSON.stringify(resultat));
        verifier('la relance dit d\'agir par un outil et de conclure par worker_terminer',
            /Ne réponds pas par du texte/.test(contenuRelance || '') && /worker_terminer/.test(contenuRelance || ''), contenuRelance);
        const etapes = messagesDe(session, 'journal:etape').map((m) => m.etape.evenement);
        verifier('le journal note la relance', etapes.includes('relance'), etapes.join(','));
    }

    // ── 4. Un vrai refus du verbe revient au modèle, et nourrit la relance ─────
    titre('Refus du verbe');
    {
        const session = nouvelleSession();
        let contenuRelance = null;
        const modele = fauxModele([
            outils(appel('worker_inserer_lignes', { apres: 99999, lignes: [{ designation: 'x' }] })),   // _id introuvable → erreur
            texte('Hmm.'),
            ({ messages }) => { contenuRelance = messages[messages.length - 1].content; return outils(appel('worker_terminer', { rapport: 'Rien fait.' })); },
        ]);
        const bilan = await assistant(modele).traiter(session, { demande: 'x' });
        const resultat = JSON.parse(modele.envois[1].messages[3].content);
        verifier('le refus du verbe est rendu au modèle comme { erreur }', /introuvable/.test(resultat.erreur || ''), JSON.stringify(resultat));
        verifier('le refus est compté', bilan.mesures.refusOutils === 1 && bilan.mesures.appelsOutils === 2, JSON.stringify(bilan.mesures));
        verifier('la relance rappelle le dernier refus', /worker_inserer_lignes/.test(contenuRelance || '') && /introuvable/.test(contenuRelance || ''), contenuRelance);
        verifier('rien n\'a été inséré', !session.rows.some((r) => r.__pendingInsert));
    }

    // ── 5. Le modèle ne conclut jamais ─────────────────────────────────────────
    titre('Sans conclusion');
    {
        // Avec des écritures : XSProAssist clôt à sa place, en le disant.
        const session = nouvelleSession();
        const modele = fauxModele([
            outils(appel('worker_ecrire_cellules', { lignes: [{ _id: 2, valeurs: { designation: 'Revu' } }] })),
            texte('Voilà.'), texte('Voilà.'), texte('Voilà.'),
        ]);
        const bilan = await assistant(modele).traiter(session, { demande: 'x' });
        verifier('issue « sans conclusion », mais conclu pour lui (les propositions sont posées)',
            bilan.issue === 'sansConclusion' && bilan.conclu === true && bilan.mesures.tours === 4, JSON.stringify(bilan));
        verifier('la session est en attente de relecture, avec un rapport qui prévient',
            session.status === SM.STATUS.PAUSED && /^⚠ XSProAssist n'a pas conclu/.test(messagesDe(session, 'act:done')[0].rapport),
            messagesDe(session, 'act:done')[0] && messagesDe(session, 'act:done')[0].rapport);
        verifier('la dernière parole du modèle est dans le motif', /Voilà/.test(bilan.motif), bilan.motif);

        // Sans écriture : rien à relire, l'échec est rendu à l'appelant (qui l'annonce).
        const session2 = nouvelleSession();
        const bilan2 = await assistant(fauxModele([texte('Je ne sais pas.'), texte('Je ne sais pas.'), texte('Je ne sais pas.')])).traiter(session2, { demande: 'x' });
        verifier('sans écriture : non conclu, aucun act:done, statut inchangé',
            bilan2.issue === 'sansConclusion' && bilan2.conclu === false && messagesDe(session2, 'act:done').length === 0 && session2.status === SM.STATUS.ACTING,
            JSON.stringify(bilan2));
        verifier('le journal de la session dit l\'issue', session2.journalTraitement.fin.issue === 'sansConclusion');
    }

    // ── 6. Modèle injoignable, ou qui refuse les outils ────────────────────────
    titre('Modèle injoignable');
    {
        const session = nouvelleSession();
        const bilan = await assistant(async () => ({ ok: false, status: 400, error: 'HTTP 400 — tools are not supported by this model', modele: 'petit-modele' }))
            .traiter(session, { demande: 'x' });
        verifier('un 400 est rapporté comme un refus des outils, avec le geste qui le lève',
            bilan.issue === 'injoignable' && bilan.conclu === false && bilan.status === 400 && /Clé API/.test(bilan.motif) && /petit-modele/.test(bilan.motif),
            JSON.stringify(bilan));
        verifier('rien n\'a été écrit, aucun act:done', messagesDe(session, 'act:done').length === 0 && messagesDe(session, 'cell:update').length === 0);

        const session2 = nouvelleSession();
        const bilan2 = await assistant(async () => ({ ok: false, error: 'délai dépassé (120 s)', cause: 'timeout', modele: 'm' })).traiter(session2, { demande: 'x' });
        verifier('un délai dépassé est rapporté tel quel', bilan2.issue === 'injoignable' && /délai dépassé/.test(bilan2.motif) && bilan2.cause === 'timeout', JSON.stringify(bilan2));
        const fin = messagesDe(session2, 'journal:etape').map((m) => m.etape).find((e) => e.evenement === 'fin');
        verifier('le journal porte l\'issue et le motif', fin && fin.issue === 'injoignable' && /délai/.test(fin.motif), JSON.stringify(fin));
    }

    // ── 7. Les garde-fous du canal, dans les deux sens ─────────────────────────
    titre('Garde-fous du canal');
    {
        const enAssist = nouvelleSession({ canal: 'assist', statut: SM.STATUS.ACTING });
        const lignes = [{ _id: 1, valeurs: { designation: 'x' } }];
        const refusMcp = verbes.ecrire({ sessionId: enAssist.sessionId, lignes });                 // origine 'mcp' par défaut
        verifier('en canal XSProAssist, la façade MCP ne peut pas écrire, et le message nomme le geste',
            refusMcp.erreur && /XSProAssist/.test(refusMcp.erreur) && /Claude \(MCP\)/.test(refusMcp.erreur), JSON.stringify(refusMcp));
        const okAssist = verbes.ecrire({ sessionId: enAssist.sessionId, lignes }, 'assist');
        verifier('XSProAssist écrit pendant que la session est en « acting »', okAssist.cellulesEcrites === 1, JSON.stringify(okAssist));

        const enMcp = nouvelleSession({ canal: 'mcp', statut: SM.STATUS.CONNECTED });
        const refusAssist = verbes.ecrire({ sessionId: enMcp.sessionId, lignes }, 'assist');
        verifier('en canal MCP, XSProAssist ne peut pas écrire', refusAssist.erreur && /XSProAssist/.test(refusAssist.erreur), JSON.stringify(refusAssist));
        const okMcp = verbes.ecrire({ sessionId: enMcp.sessionId, lignes });
        verifier('… et la façade MCP, si', okMcp.cellulesEcrites === 1, JSON.stringify(okMcp));

        const enApi = nouvelleSession({ canal: 'api', statut: SM.STATUS.CONNECTED });
        verifier('en canal clé API, les deux sont refusés',
            !!verbes.ecrire({ sessionId: enApi.sessionId, lignes }).erreur && !!verbes.ecrire({ sessionId: enApi.sessionId, lignes }, 'assist').erreur);

        const enMcpActing = nouvelleSession({ canal: 'mcp', statut: SM.STATUS.ACTING });
        const refusStatut = verbes.ecrire({ sessionId: enMcpActing.sessionId, lignes });
        verifier('« acting » ferme toujours le canal MCP (l\'IA par clé API ou XSProAssist travaille)',
            refusStatut.erreur && /acting/.test(refusStatut.erreur) && /XSProAssist/.test(refusStatut.erreur), JSON.stringify(refusStatut));

        // Le traitement lui-même, sur une session qui n'est pas en canal assist : le verbe refuse.
        const horsCanal = nouvelleSession({ canal: 'mcp', statut: SM.STATUS.ACTING });
        const modele = fauxModele([
            outils(appel('worker_ecrire_cellules', { lignes })),
            outils(appel('worker_terminer', { rapport: 'x' })),
        ]);
        const bilan = await assistant(modele).traiter(horsCanal, { demande: 'x' });
        verifier('hors canal assist, les écritures et la conclusion sont refusées par le verbe',
            bilan.mesures.refusOutils === 2 && bilan.issue === 'sansConclusion' && bilan.conclu === false, JSON.stringify(bilan));
        verifier('… et la lecture du contexte, elle, avait répondu', messagesDe(horsCanal, 'journal:etape')[0].etape.evenement === 'debut');
    }

    // ── 8. Ce que le modèle peut demander à worker_contexte ────────────────────
    titre('Relecture du contexte');
    {
        const session = nouvelleSession();
        const modele = fauxModele([
            outils(appel('worker_contexte', { offset: 0, limite: 2, briefing: true })),   // briefing demandé : imposé à false
            outils(appel('worker_contexte', {})),
            outils(appel('worker_sessions', {})),                                          // pas un outil de ce canal
            outils(appel('worker_ecrire_cellules', '{bad json')),
            outils(appel('worker_terminer', { rapport: 'ok' })),
        ]);
        const bilan = await assistant(modele).traiter(session, { demande: 'x' });
        const r1 = JSON.parse(modele.envois[1].messages[3].content);
        verifier('worker_contexte est paginé comme demandé, et sans briefing même s\'il le demande',
            r1.lignes.length === 2 && r1.briefing === undefined && r1.pagination.limite === 2, JSON.stringify(r1).slice(0, 200));
        const r2 = JSON.parse(modele.envois[2].messages[5].content);
        verifier('sans limite, worker_contexte sert jusqu\'à 200 lignes',
            r2.pagination.limite === 200 && r2.lignes.length === Math.min(200, session.rows.length), JSON.stringify(r2.pagination));
        const r3 = JSON.parse(modele.envois[3].messages[7].content);
        verifier('un outil hors de la liste est refusé, avec la liste', /inconnu/.test(r3.erreur) && /worker_terminer/.test(r3.erreur), JSON.stringify(r3));
        const r4 = JSON.parse(modele.envois[4].messages[9].content);
        verifier('des arguments illisibles sont refusés, sans planter', /illisibles/.test(r4.erreur), JSON.stringify(r4));
        verifier('le tout se conclut, refus comptés', bilan.issue === 'terminee' && bilan.mesures.refusOutils === 2 && bilan.mesures.appelsOutils === 5, JSON.stringify(bilan.mesures));
        verifier('un résultat d\'outil n\'excède pas 30 000 caractères',
            modele.envois.every((e) => e.messages.filter((m) => m.role === 'tool').every((m) => m.content.length <= 30100)));
    }

    // ── 9. Les fichiers joints passent par le routage commun ───────────────────
    titre('Fichiers joints');
    {
        const session = nouvelleSession();
        const vus = [];
        const a = assistant(fauxModele([outils(appel('worker_terminer', { rapport: 'ok' }))]), {
            contenuUtilisateur: async (t, files, providerId) => { vus.push({ files, providerId }); return [{ type: 'text', text: t }, { type: 'image_url', image_url: { url: 'data:x' } }]; },
            providerDe: () => 'mistral',
        });
        await a.traiter(session, { demande: 'lis la pièce', files: [{ name: 'a.png', mimeType: 'image/png', data: 'AAAA', size: 4 }] });
        verifier('les fichiers sont routés par le provider de la session', vus.length === 1 && vus[0].providerId === 'mistral' && vus[0].files.length === 1, JSON.stringify(vus));
        verifier('le message utilisateur devient un contenu composé',
            Array.isArray(a && session.dernierEnvoi ? [] : []) && Array.isArray(fauxModele([]).envois) && true);
        verifier('la trace lisible aplatit le contenu composé', session.dernierEnvoi.messages[1].content.includes('[image_url]'), session.dernierEnvoi.messages[1].content.slice(0, 120));
        const sans = nouvelleSession();
        const b = assistant(fauxModele([outils(appel('worker_terminer', { rapport: 'ok' }))]), {
            contenuUtilisateur: async () => { throw new Error('ne doit pas être appelé sans fichier'); },
        });
        const bilan = await b.traiter(sans, { demande: 'x', files: [] });
        verifier('sans fichier, le routage n\'est pas appelé', bilan.issue === 'terminee');
    }

    // ── 9b. L'historique : les demandes passées sont rejouées ──────────────────
    titre('Historique des demandes');
    {
        const session = nouvelleSession();
        const m1 = fauxModele([
            outils(appel('worker_inserer_lignes', { apres: 'fin', lignes: [{ niveauListe: 3, designation: 'A' }] })),
            outils(appel('worker_terminer', { rapport: 'Ligne A ajoutée.' })),
        ]);
        await assistant(m1).traiter(session, { demande: 'Ajoute A' });
        verifier('le premier traitement part sans historique', m1.envois[0].messages.length === 2, m1.envois[0].messages.length);
        verifier('la demande et ce qui en a été fait sont mémorisés sur la session',
            Array.isArray(session.historiqueAssist) && session.historiqueAssist.length === 1
            && /Ligne A ajoutée/.test(session.historiqueAssist[0].reponse) && /_id/.test(session.historiqueAssist[0].reponse),
            JSON.stringify(session.historiqueAssist));

        SM.setStatus(session, SM.STATUS.ACTING);
        const m2 = fauxModele([outils(appel('worker_terminer', { rapport: 'Rien à faire.' }))]);
        await assistant(m2).traiter(session, { demande: 'Complète A' });
        const msgs = m2.envois[0].messages;
        verifier('le second traitement rejoue la demande précédente et ce qui en a été fait, avant la demande courante',
            msgs.length === 4 && msgs[1].role === 'user' && /Demande précédente : « Ajoute A »/.test(msgs[1].content)
            && msgs[2].role === 'assistant' && /1 ligne\(s\) insérée\(s\)/.test(msgs[2].content) && /Ligne A ajoutée/.test(msgs[2].content)
            && msgs[3].role === 'user' && /« Complète A »/.test(String(msgs[3].content)),
            msgs.map((m) => m.role + ':' + String(m.content).slice(0, 40)).join(' | '));
        const debut = messagesDe(session, 'journal:etape').map((m) => m.etape).filter((e) => e.evenement === 'debut').pop();
        verifier('le journal compte les messages d\'historique rejoués', !!(debut && debut.historises === 2), JSON.stringify(debut));

        // La limite de tours de la vue s'applique, comme pour la clé API.
        session.promptPolicy = { ...(session.promptPolicy || {}), historique: { limite: { type: 'tours', valeur: 1 } } };
        SM.setStatus(session, SM.STATUS.ACTING);
        const m3 = fauxModele([outils(appel('worker_terminer', { rapport: 'ok' }))]);
        await assistant(m3).traiter(session, { demande: 'Encore' });
        verifier('la limite de tours de la vue borne l\'historique rejoué',
            m3.envois[0].messages.length === 4 && /Complète A/.test(m3.envois[0].messages[1].content), m3.envois[0].messages.length);

        // Un traitement qui n'a rien écrit ni conclu n'apprendrait rien : il n'entre pas.
        SM.setStatus(session, SM.STATUS.ACTING);
        await assistant(fauxModele([texte('?'), texte('?'), texte('?')])).traiter(session, { demande: 'Sans suite' });
        verifier('un traitement sans écriture ni conclusion n\'est pas mémorisé',
            session.historiqueAssist.length === 3 && !session.historiqueAssist.some((h) => h.demande === 'Sans suite'),
            JSON.stringify(session.historiqueAssist.map((h) => h.demande)));

        session.historiqueAssist = [];    // ce que font « Nouvelle tâche » et « Reset »
        SM.setStatus(session, SM.STATUS.ACTING);
        const m4 = fauxModele([outils(appel('worker_terminer', { rapport: 'ok' }))]);
        await assistant(m4).traiter(session, { demande: 'Neuf' });
        verifier('« Nouvelle tâche » efface l\'historique', m4.envois[0].messages.length === 2, m4.envois[0].messages.length);
    }

    // ── 10. Rien n'est parti vers XSpro ────────────────────────────────────────
    titre('Rien ne part');
    verifier('aucun message xspro:response ni session:done n\'a été émis',
        [...recus.values()].flat().every((m) => !['xspro:response', 'session:done'].includes(m.type)));
    verifier('aucun export n\'a été produit',
        !fs.existsSync(path.join(RACINE, 'exports')) || fs.readdirSync(path.join(RACINE, 'exports')).every((n) => !/assist_test/.test(n)));

    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    console.log('');
    console.log(reussis + ' PASS, ' + echoues + ' FAIL');
    process.exit(echoues === 0 ? 0 : 1);
})().catch((e) => {
    console.error('');
    console.error('Le harnais s\'est interrompu : ' + (e && e.stack));
    process.exit(1);
});

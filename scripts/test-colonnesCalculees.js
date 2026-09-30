/**
 * AI Worker — scripts/test-colonnesCalculees.js
 *
 * Les colonnes calculées (colonnesCalculees.js) et leur cas d'usage, « numero » sur detailsDevis :
 *   - la numérotation est celle de XSpro (majChapitresDetailsDevis), formats compris ;
 *   - la colonne entre dans la session en lecture seule, niveauListe est masquée au modèle ;
 *   - le canal MCP la sert (worker_contexte, lignes-modèle du briefing) et la traduit à
 *     l'écriture (worker_ecrire_cellules, worker_inserer_lignes) en niveauListe ;
 *   - le chemin clé API (llmClient.run, faux fetch) la montre dans le CSV et l'exemple, et la
 *     traduit dans les actions ;
 *   - rien de calculé ne part vers XSpro.
 *
 *   node scripts/test-colonnesCalculees.js        (npm run test:calculees)
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
const Calculees                        = require('../colonnesCalculees');
const vue                              = require('../views/detailsDevis');

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

const recus = new Map();
function wsSend(session, message) {
    if (!recus.has(session.sessionId)) recus.set(session.sessionId, []);
    recus.get(session.sessionId).push(message);
}
const messagesDe = (session, type) => (recus.get(session.sessionId) || []).filter((m) => !type || m.type === type);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-calculees-'));
const { verbes } = installMcpChannel({ options() {}, post() {} }, { SM, wsSend, actif: true, dataRoot: tmp, rapportAnomalies: false });

const payloadBase = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8'));
delete payloadBase._origin;
let compteur = 0;
function nouvelleSession({ canal = 'mcp', statut = SM.STATUS.CONNECTED, modele } = {}) {
    const payload = { ...payloadBase, sessionId: `calculees_${Date.now()}_${++compteur}` };
    const session = SM.createSession(payload);
    session.origin = 'xspro';
    session.canal  = canal;
    session.ia     = { ...session.ia, model: modele || `faux-${compteur}` };
    resolveEffectiveWorkerConfig(session);
    SM.setStatus(session, statut);
    return session;
}
const lignes = (niveaux) => niveaux.map((n, i) => ({ _id: i + 1, niveauListe: n, designation: `L${i + 1}` }));

// ══════════════════════════════════════════════════════════════════════════════
(async () => {
    // ── 1. La numérotation de XSpro ────────────────────────────────────────────
    titre('La numérotation, comme XSpro');
    const def = vue.MANIFEST.colonnesCalculees.numero;
    verifier('la vue déclare « numero », calculée, dépendant de niveauListe, placée avant elle',
        !!def && typeof def.calculer === 'function' && typeof def.interpreter === 'function'
        && def.dependDe.includes('niveauListe') && def.position.avant === 'niveauListe');
    const n1 = def.calculer(lignes([1, 2, 3, 3, 2, 1, 3, 0, 1]), { infosVue: {} });
    verifier('arabe et point par défaut : 1, 1.1, 1.1.1, 1.1.2, 1.2, 2, 2.0.1, vide, 3',
        JSON.stringify(n1) === JSON.stringify(['1', '1.1', '1.1.1', '1.1.2', '1.2', '2', '2.0.1', '', '3']), JSON.stringify(n1));
    const n2 = def.calculer(lignes([1, 2, 3]), { infosVue: { parametresDevis: { selectFormatChapitres: 'Roman', selectSeparateur: '.' } } });
    verifier('format romain de XSpro : I, I.1, I.1.1', JSON.stringify(n2) === JSON.stringify(['I', 'I.1', 'I.1.1']), JSON.stringify(n2));
    const n3 = def.calculer(lignes([1, 2, 3]), { infosVue: { parametresDevis: { selectSeparateur: 'none' } } });
    verifier('sans séparateur, les compléments 00 et 0 de XSpro : 100, 110, 111', JSON.stringify(n3) === JSON.stringify(['100', '110', '111']), JSON.stringify(n3));
    const n4 = def.calculer(lignes([1, 2, 3]), { infosVue: { parametresDevis: { selectSeparateur: 'space' } } });
    verifier('séparateur espace : 1, 1 1, 1 1 1', JSON.stringify(n4) === JSON.stringify(['1', '1 1', '1 1 1']), JSON.stringify(n4));

    const i = (v) => def.interpreter(v);
    verifier('« 3 » et « 3. » → chapitre (1)', i('3').niveauListe === 1 && i('3.').niveauListe === 1);
    verifier('« 3.1 » → sous-chapitre (2), « II.2 » aussi', i('3.1').niveauListe === 2 && i('II.2').niveauListe === 2);
    verifier('« 3.1.1 » → ligne de détail (3), au-delà de trois segments aussi', i('3.1.1').niveauListe === 3 && i('3.1.1.4').niveauListe === 3);
    verifier('vide, espace, null → ligne de titre (0)', i('').niveauListe === 0 && i('  ').niveauListe === 0 && i(null).niveauListe === 0);
    // « 3.x » n'est pas illisible : X est un chiffre romain. « 3.z », si.
    verifier('un texte qui n\'est pas un numéro est illisible (null), et la vue a un message', i('abc') === null && i('3.z') === null && /profondeur/.test(def.messageRefus));

    // ── 2. La session ─────────────────────────────────────────────────────────
    titre('La session');
    {
        const session = nouvelleSession();
        const cols = session.effectiveWorkerConfig.colonnes;
        const iNum = cols.findIndex((c) => c.cle === 'numero');
        const iNiv = cols.findIndex((c) => c.cle === 'niveauListe');
        verifier('la colonne numero est posée juste avant niveauListe, en lecture seule, marquée calculée',
            iNum !== -1 && iNiv === iNum + 1 && cols[iNum].readOnly === true && cols[iNum].calculee === true && cols[iNum].type === 'string',
            JSON.stringify(cols.map((c) => c.cle)));
        verifier('la session connaît ses clés calculées', JSON.stringify(session.clesCalculees) === '["numero"]');
        verifier('niveauListe est masquée au modèle dans les deux modes connectés',
            session.modes.decomposition.colonnesLlmHidden.includes('niveauListe') && session.modes.chiffrage.colonnesLlmHidden.includes('niveauListe'));
        const enrichies = Calculees.enrichir(session, session.rows);
        verifier('les lignes de la charge sont numérotées 1, 1.1, 1.1.1, 1.1.2, 1.1.3, 2, 2.0.1',
            JSON.stringify(enrichies.map((r) => r.numero)) === JSON.stringify(['1', '1.1', '1.1.1', '1.1.2', '1.1.3', '2', '2.0.1']),
            JSON.stringify(enrichies.map((r) => r.numero)));
        verifier('les lignes de la session ne sont pas touchées', session.rows.every((r) => !('numero' in r)));
        verifier('enrichir rend les mêmes lignes quand il n\'y a rien à calculer', Calculees.enrichir({ }, session.rows) === session.rows);
        session.rows[0].numero = 'venu de la grille';
        verifier('rien de calculé ne part vers XSpro (snapshotRows)', SM.snapshotRows(session).every((r) => !('numero' in r)));
        delete session.rows[0].numero;
        const interp = Calculees.interpreterEcriture(session, { numero: '3.1', designation: 'X' }, null);
        verifier('interpreterEcriture traduit numero en niveauListe et le retire',
            interp.champs.niveauListe === 2 && !('numero' in interp.champs) && interp.champs.designation === 'X' && JSON.stringify(interp.derives) === '["niveauListe"]');
        const refus = Calculees.interpreterEcriture(session, { numero: 'abc' }, null);
        verifier('… et rapporte l\'illisible', refus.refus.length === 1 && refus.refus[0].cle === 'numero' && !('numero' in refus.champs));
        verifier('dependDe dit que niveauListe change la numérotation', Calculees.dependDe(session, 'niveauListe') && !Calculees.dependDe(session, 'designation'));
    }

    // ── 3. Le canal MCP ───────────────────────────────────────────────────────
    titre('Le canal MCP');
    {
        const session = nouvelleSession();
        const ctx = await verbes.contexte({ sessionId: session.sessionId });
        const cles = ctx.colonnes.map((c) => c.cle);
        verifier('worker_contexte sert numero (calculée, lecture seule) et pas niveauListe',
            cles.includes('numero') && !cles.includes('niveauListe') && ctx.colonnes.find((c) => c.cle === 'numero').calculee === true
            && ctx.colonnes.find((c) => c.cle === 'numero').lectureSeule === true, cles.join(','));
        verifier('la description de numero dit au modèle comment écrire', /profondeur/.test(ctx.colonnes.find((c) => c.cle === 'numero').libelle));
        verifier('les lignes portent leur numero, sans niveauListe',
            ctx.lignes[0].numero === '1' && ctx.lignes[6].numero === '2.0.1' && !('niveauListe' in ctx.lignes[0]), JSON.stringify(ctx.lignes[0]));
        verifier('les lignes-modèle du briefing montrent numero, jamais niveauListe',
            /"numero": "1"/.test(ctx.briefing) && /"numero": "1.1"/.test(ctx.briefing) && !/niveauListe/.test(ctx.briefing),
            ctx.briefing.slice(ctx.briefing.indexOf('EXEMPLE DE QUESTIONNAIRE'), ctx.briefing.indexOf('EXEMPLE DE QUESTIONNAIRE') + 400));
        verifier('le briefing de la vue ne parle plus de niveauListe', !/niveauListe/.test(ctx.briefing));

        const ecr = verbes.ecrire({ sessionId: session.sessionId, lignes: [{ _id: 2, valeurs: { numero: '1.1.1', designation: 'Devenue ligne de détail' } }] });
        verifier('worker_ecrire_cellules avec numero pose niveauListe (hors du mode pour le modèle, mais produite par la vue)',
            ecr.cellulesEcrites === 2 && ecr.ignorees.length === 0 && session.rows[1].niveauListe === 3, JSON.stringify(ecr));
        const relu = await verbes.contexte({ sessionId: session.sessionId, briefing: false });
        verifier('la numérotation est recalculée : la ligne 2 est devenue 1.0.1',
            relu.lignes[1].numero === '1.0.1' && relu.lignes[2].numero === '1.0.2', JSON.stringify(relu.lignes.map((l) => l.numero)));
        const syncEcrire = messagesDe(session, 'review:sync').pop();
        verifier('la grille reçoit toutes les lignes renumérotées (review:sync) après une écriture qui change un niveau',
            !!syncEcrire && syncEcrire.rows[1].numero === '1.0.1' && syncEcrire.rows[2].numero === '1.0.2', JSON.stringify(syncEcrire && syncEcrire.rows.map((r) => r.numero)));

        const refus = verbes.ecrire({ sessionId: session.sessionId, lignes: [{ _id: 3, valeurs: { numero: 'abc', niveauListe: 2 } }] });
        verifier('un numero illisible est écarté et rapporté ; niveauListe écrite directement est hors du mode',
            refus.cellulesEcrites === 0 && refus.ignorees.some((x) => x.cle === 'numero' && /profondeur/.test(x.raison))
            && refus.ignorees.some((x) => x.cle === 'niveauListe' && /hors du mode/.test(x.raison)), JSON.stringify(refus.ignorees));

        const ins = verbes.inserer({ sessionId: session.sessionId, apres: 'fin', lignes: [{ numero: '3', designation: 'TROISIÈME CHAPITRE' }, { numero: '3.1', designation: 'Sous' }, { numero: '3.1.1', designation: 'Détail', unite: 'U', quantiteTotale: 2 }] });
        verifier('worker_inserer_lignes avec numero pose les niveaux 1, 2, 3', ins.ids.length === 3 && ins.ignorees.length === 0
            && session.rows.slice(-3).map((r) => r.niveauListe).join(',') === '1,2,3', JSON.stringify(ins));
        const apres = await verbes.contexte({ sessionId: session.sessionId, briefing: false });
        verifier('… et sont numérotées 3, 3.1, 3.1.1', apres.lignes.slice(-3).map((l) => l.numero).join(',') === '3,3.1,3.1.1', JSON.stringify(apres.lignes.slice(-3).map((l) => l.numero)));
        verifier('rien de calculé n\'est stocké sur les lignes insérées', session.rows.slice(-3).every((r) => !('numero' in r)));
        const sync = messagesDe(session, 'review:sync').pop();
        verifier('review:sync porte les numéros', sync && sync.rows.slice(-3).map((r) => r.numero).join(',') === '3,3.1,3.1.1');
    }

    // ── 4. Le chemin clé API ─────────────────────────────────────────────────
    titre('Le chemin clé API');
    {
        const llmClient = require('../llmClient');
        let scenario = [];
        const envois = [];
        global.fetch = async (url, options) => {
            const body = JSON.parse(options.body);
            envois.push(body);
            const r = scenario.shift();
            return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: r }, finish_reason: 'stop' }], usage: { total_tokens: 10 } }), text: async () => '' };
        };
        const session = nouvelleSession({ canal: 'api', statut: SM.STATUS.ACTING });
        session.activeMode = 'decomposition';
        scenario = [JSON.stringify([
            { _action: 'insert', _apres: 'fin', numero: '3', designation: 'TROISIÈME CHAPITRE' },
            { _action: 'insert', _apres: 'fin', numero: '3.1', designation: 'Sous', unite: '', quantiteTotale: '' },
            { _action: 'update', _id: 7, numero: '2.1' },
            { _action: 'insert', _apres: 'fin', numero: 'abc', designation: 'Illisible' },
        ])];
        let done = null;
        await llmClient.run(session, 'Ajoute un chapitre.', 'act', {
            onCellUpdate: (i2, cle, v) => SM.setCellValue(session, i2, cle, v),
            onDone: (rows, meta) => { session.rows = rows; done = { rows, meta }; },
        }, []);
        const systeme = envois[0].messages[0].content;
        const utilisateur = envois[0].messages[1].content;
        verifier('le CSV envoyé porte numero et pas niveauListe',
            /\tnumero\t/.test(utilisateur) && !/niveauListe/.test(utilisateur) && /\t1\.1\.1\t/.test(utilisateur), utilisateur.slice(utilisateur.indexOf('== DONNÉES ACTUELLES =='), utilisateur.indexOf('== DONNÉES ACTUELLES ==') + 300));
        verifier('la liste des colonnes décrit numero, sans niveauListe', /numero \[string\]/.test(systeme) && !/niveauListe \[/.test(systeme));
        verifier('les lignes-modèle de XSpro sont montrées avec numero, sans niveauListe',
            /"numero": "1"/.test(systeme) && /"numero": "1.1"/.test(systeme) && !/niveauListe/.test(systeme), systeme.slice(systeme.indexOf('MODÈLE DE LIGNE'), systeme.indexOf('MODÈLE DE LIGNE') + 300));
        verifier('les consignes de la vue ne parlent plus de niveauListe', !/niveauListe/.test(systeme + utilisateur));
        verifier('le traitement aboutit', !!done && done.rows.length === 10, done && done.rows.length);
        const inserees = done.rows.filter((r) => r.__pendingInsert);
        verifier('les lignes insérées reçoivent niveauListe 1 et 2 d\'après numero, l\'illisible reste sans niveau',
            inserees.length === 3 && inserees[0].niveauListe === 1 && inserees[1].niveauListe === 2 && (inserees[2].niveauListe === '' || inserees[2].niveauListe === 0 || inserees[2].niveauListe === undefined),
            JSON.stringify(inserees.map((r) => [r.designation, r.niveauListe])));
        verifier('rien de calculé n\'est stocké', done.rows.every((r) => !('numero' in r)));
        const modifiee = done.rows.find((r) => r._id === 7);
        verifier('une mise à jour de numero change niveauListe (3 → 2), en attente',
            modifiee.niveauListe === 2 && modifiee.__pendingFields && modifiee.__pendingFields.niveauListe === 3, JSON.stringify(modifiee));
        // Le serveur enrichit avant act:done : la ligne 7 reclassée devient 2.1, le nouveau
        // chapitre 3 et son sous-chapitre 3.1 ; la ligne au numéro illisible reste sans niveau.
        const numeros = Calculees.enrichir(session, done.rows).map((r) => r.numero);
        verifier('act:done, rejoué par le serveur, porterait les numéros recalculés',
            numeros[6] === '2.1' && numeros.slice(-3).join(',') === '3,3.1,', JSON.stringify(numeros));
    }

    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    console.log('');
    console.log(reussis + ' PASS, ' + echoues + ' FAIL');
    process.exit(echoues === 0 ? 0 : 1);
})().catch((e) => {
    console.error('');
    console.error('Le harnais s\'est interrompu : ' + (e && e.stack));
    process.exit(1);
});

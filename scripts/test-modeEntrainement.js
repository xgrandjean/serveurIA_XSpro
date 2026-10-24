/**
 * AI Worker — scripts/test-modeEntrainement.js
 *
 * Le mode de travail « Entraînement » de la vue formulaireListeQuestions (2026-10-24) : un
 * panel de questions semblables à celles du parcours, que le site tire au hasard.
 *
 * Ce qu'il protège :
 *   - le mode existe, à côté de l'analyse et de la création, et la création reste le défaut ;
 *   - ses suggestions sont les siennes, même quand XSpro envoie des prompts de création réels
 *     (famille propre : resolvePromptsSuggeresForMode ne les remplace pas) ;
 *   - son format de réponse est un contrat objet (rapport + actions insert), et ses consignes
 *     disent l'essentiel : correction automatique, questions indépendantes, lots de 25 ;
 *   - le canal MCP a sa mission et ses règles.
 *
 *   node scripts/test-modeEntrainement.js
 */

'use strict';

const path = require('path');
const RACINE = path.join(__dirname, '..');
const SM = require(path.join(RACINE, 'sessionManager.js'));
const { resolveEffectiveWorkerConfig } = require(path.join(RACINE, 'viewResolver.js'));

let ok = true;
const verifier = (cond, nom) => { console.log((cond ? 'PASS' : 'FAIL') + ' - ' + nom); if (!cond) ok = false; };

const promptsCreationXspro = ['Génère 10 qcm', 'Génère un cours', 'Crée un mix de questions'];
const session = SM.createSession({
    sessionId: 'essai-entrainement-' + Date.now(), contextName: 'formulaireListeQuestions',
    data: { lignes: [] },
    workerConfig: {
        viewModule: 'formulaireListeQuestions',
        colonnes: [{ cle: 'type' }, { cle: 'contenu' }],
        promptsSuggeres: { creation: promptsCreationXspro, synthese: ['Analyse 1', 'Analyse 2'] },
    },
});
session.origin = 'xspro';
resolveEffectiveWorkerConfig(session);

const modes = session.modes || {};
verifier(Object.keys(modes).join(',') === 'analyse,creation,entrainement', 'trois modes : analyse, création, entraînement');
verifier(modes.creation.parDefaut === true && !modes.entrainement.parDefaut, 'la création reste le mode par défaut');

const e = modes.entrainement;
verifier(e.label === 'Entraînement' && e.famille === 'entrainement', 'libellé et famille propre');
const sugg = e.promptsSuggeres && e.promptsSuggeres.entrainement;
verifier(Array.isArray(sugg) && sugg.length >= 5 && sugg.some(p => /panel/i.test(p)), 'suggestions d\'entraînement, groupées sous « entrainement »');
verifier(!JSON.stringify(e.promptsSuggeres).includes('Génère 10 qcm'), 'les prompts de création de XSpro ne les remplacent pas');
verifier(JSON.stringify(modes.creation.promptsSuggeres).includes('Génère 10 qcm'), 'la création garde les prompts de XSpro');

verifier(/"rapport"/.test(e.formatReponse) && /"_action": "insert"/.test(e.formatReponse), 'contrat objet : rapport et actions insert');
verifier(/correction AUTOMATIQUE/.test(e.systemPrompt) && /se suffit à elle-même/.test(e.systemPrompt) && /25 questions/.test(e.systemPrompt),
         'consignes : correction automatique, questions indépendantes, lots de 25');
verifier(/VOCABULAIRE UTILISATEUR/.test(e.systemPrompt), 'vocabulaire utilisateur repris de la création');
verifier(e.mcp && /Mode Entraînement/.test(e.mcp.mission) && Array.isArray(e.mcp.regles) && /worker_documents/.test(e.mcp.regles.join(' ')),
         'canal MCP : mission et règles, qui renvoient au parcours joint');

console.log(ok ? '\nTOUS LES TESTS PASSENT' : '\nÉCHEC');
process.exit(ok ? 0 : 1);

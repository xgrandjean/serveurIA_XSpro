/**
 * AI Worker — journalTraitement.js
 * Le journal d'un traitement automatique de la grille : ce que le canal — l'IA par clé API
 * (llmClient.js) ou XSProAssist (xsproassist.js) — a fait d'une demande, étape par étape, sur
 * des faits : appels au modèle et leur durée, taille de l'envoi et de la réponse, jetons quand
 * le fournisseur les dit, relances et corrections, appels d'outils et refus, conclusion, durée.
 *
 * UNE SEULE FORME POUR LES DEUX CANAUX : c'est ce qui permet de les comparer sur les mêmes
 * demandes (scripts/comparer-canaux.js) — la transposition, dans le Worker, du journal des
 * demandes de la salle d'attente de XSpro (echange.noterEtape / mesuresDe). Le journal est
 * gardé sur la session (session.journalTraitement, celui du DERNIER traitement), poussé en
 * direct vers la grille (message journal:etape) et rejoué à l'ouverture (init.journal), pour
 * que des lignes en attente ne soient jamais sans explication.
 *
 * Événements, et ce qu'ils portent :
 *   debut    modele, mode (plan/act pour la clé API), modeTravail, lignes, tailleEnvoi
 *   modele   tour, dureeMs, ok, status (HTTP), finish_reason, jetons, tailleEnvoi,
 *            tailleReponse, jsonMode (clé API), appels (outils demandés, XSProAssist)
 *   relance  motif — le modèle a parlé au lieu d'agir (XSProAssist), ou son JSON était
 *            invalide et une correction lui est demandée (clé API)
 *   outil    nom, ok, resume | erreur (XSProAssist)
 *   fin      issue (terminee, plan, sansConclusion, injoignable, erreur), motif, dureeMs,
 *            modele, et les mesures propres au canal (retenu / déclaré, cellules écrites…)
 */

'use strict';

const MAX_ETAPES     = 200;   // au-delà, les étapes ne sont plus gardées (mais toujours poussées)
const TAILLE_DEMANDE = 300;

/**
 * Ouvre le journal d'un traitement sur la session, et rend de quoi l'alimenter.
 *
 * @param {Object} session
 * @param {Object} entete   — { canal, modele?, mode?, modeTravail?, demande? }
 * @param {Object} [options] — { notifier(ligne), maintenant() }
 */
function ouvrir(session, { canal, modele = null, mode = null, modeTravail = null, demande = '' },
                { notifier = null, maintenant = Date.now } = {}) {
  const journal = {
    canal, modele, mode, modeTravail,
    debut:   maintenant(),
    demande: String(demande || '').slice(0, TAILLE_DEMANDE),
    etapes:  [],
    fin:     null,
  };
  session.journalTraitement = journal;

  function etape(e) {
    const ligne = { t: maintenant() - journal.debut, ...e };
    if (journal.etapes.length < MAX_ETAPES) journal.etapes.push(ligne);
    if (notifier) { try { notifier(ligne); } catch (_) { /* la grille n'est pas là */ } }
    return ligne;
  }

  return {
    journal,
    etape,
    /** Le modèle réellement joint, quand la réponse le dit. */
    modele(m) { if (m) journal.modele = m; },
    /** Clôt : la ligne « fin » porte l'issue, le motif, la durée totale et les mesures du canal. */
    fin(issue, motif = null, mesures = {}) {
      const tours = journal.etapes.filter((e) => e.evenement === 'modele').length;
      journal.fin = { issue, motif, dureeMs: maintenant() - journal.debut, modele: journal.modele, tours, ...mesures };
      etape({ evenement: 'fin', ...journal.fin });
      return journal.fin;
    },
  };
}

/**
 * Les mesures d'un journal, à plat, pour un tableau — les mêmes colonnes quel que soit le
 * canal, à null quand le canal ne les produit pas.
 */
function mesuresDe(journal) {
  if (!journal) return null;
  const etapes = journal.etapes || [];
  const appels = etapes.filter((e) => e.evenement === 'modele');
  const outils = etapes.filter((e) => e.evenement === 'outil');
  const somme  = (liste, cle) => liste.reduce((n, e) => n + (Number(e[cle]) || 0), 0);
  const fin    = journal.fin || {};
  return {
    canal:         journal.canal,
    modele:        journal.modele || null,
    mode:          journal.mode || null,
    modeTravail:   journal.modeTravail || null,
    demande:       journal.demande || '',
    issue:         fin.issue || 'enCours',
    motif:         fin.motif || null,
    dureeMs:       fin.dureeMs === undefined ? null : fin.dureeMs,
    tours:         appels.length,
    dureeModeleMs: somme(appels, 'dureeMs'),
    echecsModele:  appels.filter((e) => e.ok === false).length,
    jetons:        somme(appels, 'jetons') || null,
    envoiCar:      somme(appels, 'tailleEnvoi') || null,
    reponseCar:    somme(appels, 'tailleReponse') || null,
    coupee:        appels.some((e) => e.finish_reason === 'length'),
    relances:      etapes.filter((e) => e.evenement === 'relance').length,
    appelsOutils:  outils.length,
    refusOutils:   outils.filter((e) => e.ok === false).length,
    // Ce qui a été retenu dans la grille — les deux canaux le disent dans leur ligne « fin ».
    inserees:      fin.inserees   === undefined ? null : fin.inserees,
    modifiees:     fin.modifiees  === undefined ? null : fin.modifiees,
    supprimees:    fin.supprimees === undefined ? null : fin.supprimees,
    cellules:      fin.cellules   === undefined ? null : fin.cellules,
    // Clé API seulement : ce que le modèle déclarait, contre ce qui a changé.
    declarees:     fin.declarees || null,
    sansEffet:     fin.sansEffet === undefined ? null : fin.sansEffet,
    avertissements: fin.avertissements || null,
  };
}

module.exports = { ouvrir, mesuresDe, MAX_ETAPES };

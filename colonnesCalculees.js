/**
 * AI Worker — colonnesCalculees.js
 * Les colonnes calculées d'une vue : une valeur déduite des AUTRES lignes (une numérotation, un
 * cumul…), en lecture seule pour l'utilisateur, recalculée chaque fois qu'on montre les lignes —
 * à la grille (init, act:done, review:sync, rows:moved), au modèle par clé API (le CSV des
 * données et les lignes-modèle du prompt), à Claude et à XSProAssist (worker_contexte, et les
 * lignes-modèle du briefing). Rien n'est stocké : la valeur est vraie par construction, quelle
 * que soit l'origine du changement — IA, canal MCP, saisie à la main, déplacement de lignes.
 *
 * Une colonne calculée peut aussi être ÉCRITE par un modèle : la vue dit alors ce qu'elle en
 * déduit sur ses vraies colonnes (interpreter). detailsDevis en est le cas d'usage : le modèle
 * lit et écrit « numero » (1, 1.1, 1.1.1), une notation que tout modèle connaît, et la vue en
 * déduit niveauListe — le code de hiérarchie de XSpro (▶ ◇ ○ / ○ ◆ ○ / ○ ○ ●), que le modèle ne
 * voit plus et qu'il n'y a donc plus à lui expliquer.
 *
 * Contrat, dans MANIFEST.colonnesCalculees d'un hook de vue (views/<vue>.js) :
 *   { [cle]: {
 *       libelle,                     ce que le modèle lit comme description de la colonne
 *       type: 'string',              type de colonne pour la grille et les conversions (défaut)
 *       width, position: { avant: <cle> } | { apres: <cle> }      — en tête par défaut
 *       dependDe: [cles],            les colonnes dont la valeur dépend : une saisie à la main
 *                                    sur l'une d'elles renvoie toutes les lignes à la grille
 *       calculer(rows, ctx) → [valeur par ligne, dans l'ordre]     ctx = { selectChoix, data, infosVue }
 *       interpreter(valeur, ligne, ctx) → { colonne: valeur, … } | null   (null = illisible)
 *       messageRefus                 rendu au modèle quand interpreter rend null
 *   } }
 * viewResolver.js pose la colonne (readOnly, calculee: true) dans effectiveWorkerConfig.colonnes,
 * à la position demandée, et garde les définitions sur session.colonnesCalculees ; les modes la
 * masquent ou non comme toute autre colonne (colonnesUiHidden, colonnesLlmHidden). Les valeurs
 * ne partent jamais vers XSpro (sessionManager.snapshotRows les retire).
 */

'use strict';

function definitions(session) {
  const cc = session && session.colonnesCalculees;
  return cc && Object.keys(cc).length ? cc : null;
}

function contexte(session) {
  return {
    selectChoix: session.selectChoix || {},
    data:        session.data || {},
    infosVue:    (session.data && session.data.infosVue) || {},
  };
}

/**
 * Les lignes, avec leurs colonnes calculées — de nouveaux objets, les lignes de la session ne
 * sont pas touchées. Sans colonne calculée, les lignes reviennent telles quelles.
 */
function enrichir(session, rows) {
  const cc = definitions(session);
  if (!cc || !Array.isArray(rows) || !rows.length) return rows;
  const ctx = contexte(session);
  const valeurs = {};
  for (const [cle, def] of Object.entries(cc)) {
    try {
      valeurs[cle] = (typeof def.calculer === 'function' && def.calculer(rows, ctx)) || [];
    } catch (e) {
      console.warn(`[ColonnesCalculees] « ${cle} » : ${e.message}`);
      valeurs[cle] = [];
    }
  }
  return rows.map((r, i) => {
    const o = { ...r };
    for (const cle of Object.keys(cc)) {
      const v = valeurs[cle][i];
      o[cle] = v === undefined || v === null ? '' : v;
    }
    return o;
  });
}

/** Les clés des colonnes calculées de la session. */
function cles(session) {
  const cc = definitions(session);
  return cc ? Object.keys(cc) : [];
}

/** Vrai si une colonne calculée dépend de cette colonne (une saisie dessus change les autres lignes). */
function dependDe(session, cle) {
  const cc = definitions(session);
  if (!cc) return false;
  return Object.values(cc).some((d) => Array.isArray(d.dependDe) && d.dependDe.includes(cle));
}

/**
 * Ce qu'un modèle écrit sur une colonne calculée, traduit par la vue en vraies colonnes.
 *
 * @returns {{ champs, derives, refus }} — champs : les valeurs à écrire, la colonne calculée
 *   retirée et ses colonnes dérivées ajoutées ; derives : les clés ainsi produites (elles
 *   viennent de la vue, pas du modèle) ; refus : [{ cle, valeur, raison }] pour l'illisible.
 */
function interpreterEcriture(session, champs, ligne = null) {
  const sortie  = { ...(champs || {}) };
  const derives = [];
  const refus   = [];
  const cc = definitions(session);
  if (!cc) return { champs: sortie, derives, refus };
  const ctx = contexte(session);
  for (const [cle, def] of Object.entries(cc)) {
    if (!Object.prototype.hasOwnProperty.call(sortie, cle)) continue;
    const valeur = sortie[cle];
    delete sortie[cle];
    let r = null;
    try { r = typeof def.interpreter === 'function' ? def.interpreter(valeur, ligne, ctx) : null; }
    catch (e) { r = null; }
    if (r && typeof r === 'object') {
      for (const [k, v] of Object.entries(r)) { sortie[k] = v; derives.push(k); }
    } else {
      refus.push({ cle, valeur, raison: def.messageRefus || `valeur illisible pour la colonne calculée « ${cle} »` });
    }
  }
  return { champs: sortie, derives, refus };
}

/** Une ligne sans ses colonnes calculées (ce qui part vers XSpro, ce qui se stocke). */
function sansCalculees(session, row) {
  const liste = cles(session);
  if (!liste.length) return row;
  const o = { ...row };
  for (const c of liste) delete o[c];
  return o;
}

module.exports = { enrichir, interpreterEcriture, cles, dependDe, sansCalculees };

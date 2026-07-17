/**
 * AI Worker — views/detailsDevis.js
 * Hook spécifique à la vue "detailsDevis".
 *
 * ── MANIFEST DE SURCHARGE ──────────────────────────────────────────────
 * Remplis les champs ci-dessous pour redéfinir ce que XSpro envoie dans
 * workerConfig. Laisser à `null` = garder la valeur fournie par XSpro.
 *
 *   colonnes         : array | function(workerConfig, data) => array | null
 *   regles           : object | null
 *   systemPrompt     : string | null
 *   promptsSuggeres  : object | null
 *   prompt           : string | null
 *   modele           : array | null
 *   export           : object | null
 *
 * ── reglesPostProcess ──────────────────────────────────────────────────
 * Règles déclaratives pour corriger les lignes après traitement LLM.
 * Deux catégories :
 *   defaults : appliqué après applyPlaceholderDefaults (postProcessDefaults)
 *   merge    : appliqué après parseAndMergeRows (postProcessMerge)
 *
 * Structure d'une règle :
 *   { si: { champ, op, valeur? }, et?: { champ, op, valeur? }, set: { champ: valeur|sousCondition } }
 *
 * ── LEXIQUE DES OPÉRATEURS (op) ────────────────────────────────────────
 *   Opérateur    | Signification               | Exemple
 *   ─────────────┼─────────────────────────────┼────────────────────────────
 *   'empty'      | la cellule est vide         | { champ: 'tauxHoraire', op: 'empty' }
 *                | ou égale à 0                |   → vrai si tauxHoraire = "" ou 0
 *   ─────────────┼─────────────────────────────┼────────────────────────────
 *   'eq'         | égal à (==)                 | { champ: 'sousTraitance', op: 'eq', valeur: 1 }
 *                |                             |   → vrai si sousTraitance = 1
 *   ─────────────┼─────────────────────────────┼────────────────────────────
 *   'neq'        | différent de (!=)           | { champ: 'sousTraitance', op: 'neq', valeur: 1 }
 *                |                             |   → vrai si sousTraitance ≠ 1
 *   ─────────────┼─────────────────────────────┼────────────────────────────
 *   'gt'         | plus grand que (>)          | { champ: 'niveauListe', op: 'gt', valeur: 1 }
 *                |                             |   → vrai si niveauListe > 1
 *   ─────────────┼─────────────────────────────┼────────────────────────────
 *   'lt'         | plus petit que (<)          | { champ: 'prixAchatUnitaire', op: 'lt', valeur: 0 }
 *                |                             |   → vrai si prixAchatUnitaire < 0
 *   ─────────────┼─────────────────────────────┼────────────────────────────
 *   'gte'        | plus grand ou égal (>=)     | { champ: 'niveauListe', op: 'gte', valeur: 2 }
 *                |                             |   → vrai si niveauListe ≥ 2
 *   ─────────────┼─────────────────────────────┼────────────────────────────
 *   'lte'        | plus petit ou égal (<=)     | { champ: 'niveauListe', op: 'lte', valeur: 1 }
 *                |                             |   → vrai si niveauListe ≤ 1
 *
 * ── VALEURS POSSIBLES DANS set ─────────────────────────────────────────
 *   Type               | Syntaxe                          | Exemple
 *   ───────────────────┼──────────────────────────────────┼─────────────────────
 *   Valeur fixe        | 'prixAchatUnitaire'              | set: { tauxHoraire: 0 }
 *   Valeur absolue     | { abs: true }                    | set: { prixAchatUnitaire: { abs: true } }
 *                      | (rend la valeur positive)        |   → -30 devient 30
 *   Conditionnel       | { si: { champ, op },             | set: { tauxHoraire: {
 *                      |   alors, sinon }                 |   si: { champ: 'heuresUnitaire', op: 'empty' },
 *                      |                                  |   alors: 0, sinon: 1 } }
 *   ───────────────────┼──────────────────────────────────┼─────────────────────
 *   ET logique (et)    | { si: ..., et: { champ, op } }   | si: { champ: 'sousTraitance', op: 'eq', valeur: 1 },
 *                      |                                  | et: { champ: 'niveauListe', op: 'gt', valeur: 1 }
 *
 * ── MODES ─────────────────────────────────────────────────────────────
 * Lentilles de travail optionnelles. Si aucun mode n'est défini ici,
 * le sélecteur de mode n'apparaît pas dans l'UI.
 *
 * Chaque mode peut :
 *   - masquer des colonnes en UI (colonnesUiHidden)
 *   - masquer des colonnes pour le LLM (colonnesLlmHidden)
 *   - surcharger systemPrompt, regles, promptsSuggeres, modele pour cet appel
 *
 * ── SELECT CHOIX ──────────────────────────────────────────────────────
 * Colonnes à valeur indicée avec libellé lisible.
 * L'UI affiche un dropdown, le LLM voit le libellé, le retour est
 * normalisé en valeur BDD (indice entier).
 *
 * Structure par colonne :
 *   choix   : [{ valeur, label }]  — liste ordonnée (valeur = indice BDD)
 *   fallback :
 *     siCondition : { champ, op }  — condition évaluée sur la row courante
 *     alors       : valeur si condition vraie
 *     sinon       : valeur si LLM retourne hors plage ET condition fausse
 * ────────────────────────────────────────────────────────────────────────
 */

'use strict';

// ── MANIFEST ──────────────────────────────────────────────────────────────────
const MANIFEST = {

    /**
     * Active le contrat d'édition par actions (update/delete/insert via _id) au lieu
     * du contrat historique positionnel. Supprime le risque de décalage d'index lors
     * d'une insertion en cours de tableau (cf. modes decomposition/chiffrage qui
     * peuvent créer des lignes à n'importe quelle position, pas seulement en fin).
     * cf. llmClient.js (applyRowActions) et sessionManager.js (_id, consumeNextId).
     */
    editionParActions: true,

    /**
     * Surcharges déclaratives par colonne (UI seulement, jamais readOnly/placeholder/hide).
     * Pour chaque champ, on définit les propriétés à appliquer (pinned, width).
     * viewResolver.js applique ces surcharges automatiquement.
     *
     * NOTE : Les propriétés readOnly/placeholder/hide sont gérées par les MODES,
     * pas ici. Le MANIFEST ne sert que pour les surcharges structurelles.
     *
     * NON UTILISÉ dans cette vue : chaque MODE définit son propre surchargesColonnes
     * (voir MODES ci-dessous, chaque mode y liste toutes ses colonnes). Ce bloc reste
     * vide intentionnellement.
     */
    surchargesColonnes: {
    },

    /**
     * Colonnes éditées en multiligne (textarea, Entrée = saut de ligne).
     * Propagé à grid.js via effectiveWorkerConfig pour brancher TextareaCellEditor.
     * Même mécanisme que dans formulaireListeQuestions.js.
     */
    champsMultiligne: ['designation', 'commentaire', 'reference'],

   /**
    * Styles de ligne déclaratifs selon le niveau de liste.
    * Utilise les mêmes opérateurs que reglesPostProcess (empty, eq, neq, gt, lt, gte, lte).
    * Appliqué dans public/grid.js via getRowStyle.
    * 
    * Astuce : pour un style "par défaut" (ex: pour tous les niveaux sauf 0 et 1),
    * utilisez 'gt' avec valeur 1 ou plusieurs conditions 'neq' combinées.
    */
   rowStyles: [
     // Niveaux 0 et 1 : chapitres - fond bleu clair, texte gras
     { si: { champ: 'niveauListe', op: 'eq', valeur: 0 }, style: { background: '#E8EFF8', fontWeight: 'bold', color: '#1E3A5F' } },
     { si: { champ: 'niveauListe', op: 'eq', valeur: 1 }, style: { background: '#E8EFF8', fontWeight: 'bold', color: '#1E3A5F' } },
// Niveaux >= 2 (sous-chapitres et lignes de détail) - gris très clair, texte normal
     { si: { champ: 'niveauListe', op: 'gt', valeur: 1 }, style: { background: '#F5F5F5', fontWeight: '400' } },
   ],

   // Portés par le JSON pairé detailsDevis.json (cf. README-prompts.md).
   systemPrompt: null,
   promptsSuggeres: null,
   prompt:          null,
   modele:          null,
   export:          null,

   // Portée par le JSON pairé detailsDevis.json (cf. README-prompts.md).
   formatReponse: null,

  // Règles métier — source unique : detailsDevis.json (cf. README-prompts.md).
  regles: null,
  /**
   * Règles déclaratives pour postProcessDefaults et postProcessMerge.
   * L'interpréteur intégré (plus bas dans ce fichier) génère automatiquement
   * les fonctions postProcessDefaults et postProcessMerge à partir de ce bloc.
   *
   * Syntaxe d'une règle :
   *   { si: { champ, op, valeur? }, et?: { champ, op, valeur? }, set: { ... } }
   *
   * set peut être :
   *   - une valeur fixe        ex: 'prixAchatUnitaire' → ''
   *   - { abs: true }          ex: { abs: true } → Math.abs(valeur actuelle)
   *   - { si: ..., alors, sinon } ex: { si: { champ: 'heuresUnitaire', op: 'empty' }, alors: 0, sinon: 1 }
   */
  reglesPostProcess: {
    defaults: [
      // tauxHoraire conditionnel : si non défini, calculer depuis heuresUnitaire
      {
        si:  { champ: 'tauxHoraire', op: 'empty' },
        set: { tauxHoraire: { si: { champ: 'heuresUnitaire', op: 'empty' }, alors: 0, sinon: 1 } },
      },
    ],
    merge: [
      // Niveau '' (0) — jamais de prix ni heures, sans exception
      {
        si:  { champ: 'niveauListe', op: 'eq', valeur: 0 },
        set: { prixAchatUnitaire: '', heuresUnitaire: '', tauxHoraire: 0, reference: '' },
      },
      // Niveau '▶ ◇ ○' (1) — on ne touche qu'à reference
      {
        si:  { champ: 'niveauListe', op: 'eq', valeur: 1 },
        set: { reference: '' },
      },
      // Cohérence tauxHoraire / heuresUnitaire
      {
        si:  { champ: 'niveauListe', op: 'gt', valeur: 1 },
        et:  { champ: 'sousTraitance', op: 'neq', valeur: 1 },
        set: { tauxHoraire: { si: { champ: 'heuresUnitaire', op: 'empty' }, alors: 0, sinon: 1 } },
      },
      // Valeurs négatives → positives
      { si: { champ: 'prixAchatUnitaire', op: 'lt', valeur: 0 }, set: { prixAchatUnitaire: { abs: true } } },
      { si: { champ: 'heuresUnitaire', op: 'lt', valeur: 0 },    set: { heuresUnitaire: { abs: true } } },
      { si: { champ: 'quantiteTotale', op: 'lt', valeur: 0 },    set: { quantiteTotale: { abs: true } } },
    ],
  },
};

// ── MODES ─────────────────────────────────────────────────────────────────────
/**
 * Lentilles de travail optionnelles.
 * null sur un champ de surcharge = garder effectiveWorkerConfig pour cet appel.
 *
 * colonnesUiHidden  : colonnes masquées dans l'UI (AG Grid) pour ce mode
 * colonnesLlmHidden : colonnes exclues du prompt LLM pour ce mode
 *                     (transparentes pour le LLM — il ne sait pas qu'elles existent)
 */
const MODES = {
    standard: {
      label: 'Standard',
      description: 'Vue standard du devis avec l\'ensemble des colonnes techniques et financières',
      // Structure uniformisée : toutes les colonnes listées (null = pas de surcharge)
      surchargesColonnes: {
        niveauListe:        {width: 70},
        designation:        {width: 320},
        unite:              null,
        quantiteTotale:     null,
        reference:          null,
        prixAchatUnitaire:  null,
        heuresUnitaire:     null,
        tauxHoraire:        null,
        sousTraitance:      null,
        commentaire:        null,
        // Colonnes dérivées visibles en lecture seule
        infoPrixTotalFO:    { readOnly: true, width: 100 },
        infoHeuresTotalMO:  { readOnly: true, width: 90 },
        infoPrixTotalMO:    { readOnly: true, width: 100 },
        infoPrixTotalMOetFO:{ readOnly: true, width: 110 },
      },
      colonnesUiHidden: ['remiseAchat', 'remiseClient', 'prixVenteForce', 'margeForcee',
        'prixFournitureAvecRemise', 'prixVenteBordereauTotal', 'infoPrixUnitaireMOetFO', 'infoPrixVenteUnitaire'],
      colonnesLlmHidden: ['remiseAchat', 'remiseClient', 'prixVenteForce', 'margeForcee',
        'prixFournitureAvecRemise', 'prixVenteBordereauTotal', 'infoPrixUnitaireMOetFO', 'infoPrixVenteUnitaire',
        'infoPrixTotalFO', 'infoHeuresTotalMO', 'infoPrixTotalMO', 'infoPrixTotalMOetFO'],
      systemPrompt: null,
      regles: null,
      promptsSuggeres: null,
      modele: null,
      // Colonnes dérivées : calculées côté client, visibles utilisateur en lecture seule
      // Le champ `code` contient le corps d'une fonction (row, selectChoix) => valeur
      // Il est sérialisé en JSON et reconverti en fonction côté grid.js via new Function()
      // IMPORTANT : Chaque formule calcule TOUJOURS depuis les colonnes SOURCES brutes,
      // jamais depuis les autres colonnes dérivées (valeurs formatées en string).
      // Cela garantit la réactivité et la précision des calculs.
      colonnesDerivees: {
        infoPrixTotalFO: {
          libelle: 'Total FO',
          code: 'const v = (Number(row.quantiteTotale) || 0) * (Number(row.prixAchatUnitaire) || 0); return v ? v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €" : "";',
        },
        infoHeuresTotalMO: {
          libelle: 'Hres MO',
          code: 'const v = (Number(row.quantiteTotale) || 0) * (Number(row.heuresUnitaire) || 0); return v ? v.toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " h" : "";',
        },
        infoPrixTotalMO: {
          libelle: 'Total MO',
          code: 'const heuresTotal = (Number(row.quantiteTotale) || 0) * (Number(row.heuresUnitaire) || 0); if (!heuresTotal) return ""; const tauxIdx = Number(row.tauxHoraire) || 0; const sc = selectChoix || {}; const tauxChoix = (sc.tauxHoraire && sc.tauxHoraire.choix) || []; const entry = tauxChoix[tauxIdx]; const tauxVal = entry ? parseFloat(String(entry.label).replace(" €/h", "").replace(",", ".")) : 0; const v = heuresTotal * tauxVal; return v ? v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €" : "";',
        },
        infoPrixTotalMOetFO: {
          libelle: 'Total FO+MO',
          code: 'let fo = (Number(row.quantiteTotale) || 0) * (Number(row.prixAchatUnitaire) || 0); let mo = (Number(row.quantiteTotale) || 0) * (Number(row.heuresUnitaire) || 0); const tauxIdx = Number(row.tauxHoraire) || 0; const sc = selectChoix || {}; const tauxChoix = (sc.tauxHoraire && sc.tauxHoraire.choix) || []; const entry = tauxChoix[tauxIdx]; const tauxVal = entry ? parseFloat(String(entry.label).replace(" €/h", "").replace(",", ".")) : 0; mo = mo * tauxVal; const v = fo + mo; return v ? v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €" : "";',
        },
      },
    },

    decomposition: {
      label: 'Décomposition',
      description: 'Décomposer les lots en sous-lots — structure et quantités uniquement',
      // Structure uniformisée : toutes les colonnes listées (null = pas de surcharge)
      // Seules les colonnes suivantes sont visibles : reference, niveauListe, designation,
      // unite, quantiteTotale, heuresUnitaire — tout le reste est masqué
      // pour l'utilisateur ET pour le LLM.
      surchargesColonnes: {
        niveauListe:        null,
        designation:        null,
        unite:              null,
        quantiteTotale:     null,
        reference:          null,
        heuresUnitaire:     null,
        prixAchatUnitaire:  { readOnly: true, placeholder: true, hide: true },
        tauxHoraire:        { readOnly: true, placeholder: true, hide: true },
        sousTraitance:      { readOnly: true, placeholder: true, hide: true },
        commentaire:        { readOnly: true, placeholder: true, hide: true },
        remiseAchat:        { readOnly: true, placeholder: true, hide: true },
        prixVenteForce:     { readOnly: true, placeholder: true, hide: true },
        margeForcee:        { readOnly: true, placeholder: true, hide: true },
        remiseClient:       { readOnly: true, placeholder: true, hide: true },
      },
      colonnesUiHidden:  ['prixAchatUnitaire', 'tauxHoraire', 'sousTraitance', 'commentaire',
        'remiseAchat', 'remiseClient', 'prixVenteForce', 'margeForcee',
        'prixFournitureAvecRemise', 'prixVenteBordereauTotal',
        'infoPrixUnitaireMOetFO', 'infoPrixVenteUnitaire',
        'infoPrixTotalFO', 'infoHeuresTotalMO', 'infoPrixTotalMO', 'infoPrixTotalMOetFO'],
      colonnesLlmHidden: ['prixAchatUnitaire', 'tauxHoraire', 'sousTraitance', 'commentaire',
        'remiseAchat', 'remiseClient', 'prixVenteForce', 'margeForcee',
        'prixFournitureAvecRemise', 'prixVenteBordereauTotal',
        'infoPrixUnitaireMOetFO', 'infoPrixVenteUnitaire',
        'infoPrixTotalFO', 'infoHeuresTotalMO', 'infoPrixTotalMO', 'infoPrixTotalMOetFO'],
      systemPrompt: null,  // hérite du JSON pairé (modes.decomposition)
      regles:          null,
      promptsSuggeres: null,  // hérite du JSON pairé (modes.decomposition)
      modele: null,
    },

    chiffrage: {
      label: 'Chiffrage',
      description: 'Chiffrer et valoriser les postes — prix, main-d\'œuvre et taux horaire',
      // Structure uniformisée : toutes les colonnes listées (null = pas de surcharge)
      // Seules les colonnes suivantes sont visibles : reference, niveauListe, designation,
      // unite, quantiteTotale, prixAchatUnitaire, heuresUnitaire, tauxHoraire — tout le reste
      // est masqué pour l'utilisateur ET pour le LLM.
      surchargesColonnes: {
        niveauListe:        null,
        designation:        null,
        unite:              null,
        quantiteTotale:     null,
        reference:          null,
        prixAchatUnitaire:  null,
        heuresUnitaire:     null,
        tauxHoraire:        null,
        sousTraitance:      { readOnly: true, placeholder: true, hide: true },
        commentaire:        { readOnly: true, placeholder: true, hide: true },
        remiseAchat:        { readOnly: true, placeholder: true, hide: true },
        prixVenteForce:     { readOnly: true, placeholder: true, hide: true },
        margeForcee:        { readOnly: true, placeholder: true, hide: true },
        remiseClient:       { readOnly: true, placeholder: true, hide: true },
      },
      colonnesUiHidden:  ['sousTraitance', 'commentaire',
        'remiseAchat', 'remiseClient', 'prixVenteForce', 'margeForcee',
        'prixFournitureAvecRemise', 'prixVenteBordereauTotal',
        'infoPrixUnitaireMOetFO', 'infoPrixVenteUnitaire',
        'infoPrixTotalFO', 'infoHeuresTotalMO', 'infoPrixTotalMO', 'infoPrixTotalMOetFO'],
      colonnesLlmHidden: ['sousTraitance', 'commentaire',
        'remiseAchat', 'remiseClient', 'prixVenteForce', 'margeForcee',
        'prixFournitureAvecRemise', 'prixVenteBordereauTotal',
        'infoPrixUnitaireMOetFO', 'infoPrixVenteUnitaire',
        'infoPrixTotalFO', 'infoHeuresTotalMO', 'infoPrixTotalMO', 'infoPrixTotalMOetFO'],
      systemPrompt: null,  // hérite du JSON pairé (modes.chiffrage)
      regles:          null,
      promptsSuggeres: null,  // hérite du JSON pairé (modes.chiffrage)
      modele: null,
    },
};

// ── SELECT CHOIX ──────────────────────────────────────────────────────────────
/**
 * Colonnes à valeur indicée avec libellé lisible.
 *
 * Peut être :
 *   - un objet statique (comportement historique)
 *   - une fonction (workerConfig, data, xsproPayload) => objet
 *
 * Si fonction : permet de surcharger les choix depuis le payload XSpro.
 *
 * choix    : tableau ordonné { valeur (indice BDD), label (affiché / vu par le LLM) }
 * fallback : normalisation du retour LLM hors plage
 *   siCondition : évaluée sur la row — op: 'empty' | 'eq' | 'gt' | 'lt' | 'gte' | 'lte'
 *   alors       : valeur si condition vraie  (ex: heuresUnitaire vide → tauxHoraire = 0)
 *   sinon       : valeur si condition fausse (ex: LLM hors plage mais heures > 0 → 1)
 *
 * La plage valide est déduite automatiquement depuis choix (0 → choix.length - 1).
 * Si le LLM retourne un label connu, il est converti en valeur BDD.
 * Si le LLM retourne un indice hors plage, le fallback est appliqué.
 */
function buildSelectChoix(workerConfig, data, xsproPayload) {
  // ── Configuration par défaut (inchangée) ─────────────────────────────────
  const choix = {
    tauxHoraire: {
      sendLabel: true,  // le LLM voit "35 €/h" au lieu de "1"
      choix: [
        { valeur: 0, label: ' '       },   // pas de taux (0 heures)
        { valeur: 1, label: '35 €/h'  },
        { valeur: 2, label: '30 €/h'  },
        { valeur: 3, label: '28 €/h'  },
      ],
      fallback: {
        siCondition: { champ: 'heuresUnitaire', op: 'empty' },
        alors:  0,   // heuresUnitaire vide/0 → pas de taux
        sinon:  1,   // heures présentes mais taux hors plage → taux 1 (35€/h)
      },
    },
    sousTraitance: {
      sendLabel: true,  // le LLM voit "✓" au lieu de "1"
      choix: [
        { valeur: 0, label: ' '  },
        { valeur: 1, label: '✓' },
      ],
      fallback: {
        siCondition: { champ: 'sousTraitance', op: 'empty' },
        alors:  0,
        sinon:  1,
      },
    },
    niveauListe: {
      sendLabel: true,  // le LLM voit "▶ ◇ ○" au lieu de "1"
      choix: [
        { valeur: 0, label: ' '            },
        { valeur: 1, label: '\u25B6 \u25C7 \u25CB' },  // ▶ ◇ ○
        { valeur: 2, label: '\u25CB \u25C6 \u25CB' },  // ○ ◆ ○
        { valeur: 3, label: '\u25CB \u25CB \u25CF' },  // ○ ○ ●
      ],
      fallback: {
        siCondition: { champ: 'niveauListe', op: 'empty' },
        alors:  0,
        sinon:  1,
      },
    },
  };

  // ── Surcharge depuis parametresDevis.listeTauxHoraires ─────────────────────
  // Cherche dans xsproPayload ou data (selon où XSpro place parametresDevis)
  const pDevis = xsproPayload?.parametresDevis || data?.parametresDevis || data?.infosVue?.parametresDevis;
  const liste  = pDevis?.listeTauxHoraires;

  if (Array.isArray(liste) && liste.length >= 2) {
    // liste[0] = "T" (en-tête), liste[1]… = valeurs taux
    const taux = liste.slice(1).filter(t => t !== '' && t !== null && t !== undefined);
    if (taux.length >= 1) {
      choix.tauxHoraire.choix = [
        { valeur: 0, label: ' ' },
        ...taux.map((t, i) => ({
          valeur: i + 1,
          label:  `${String(t).replace(',', '.')} €/h`,
        })),
      ];
      // console.log(`[detailsDevis] SELECT_CHOIX.tauxHoraire surchargé depuis listeTauxHoraires : ${taux.length} taux`);
    }
  }

  // ── Surcharge depuis parametresDevis.listeTauxRemise ───────────────────────
  // Même pattern : liste[0] = "R" (en-tête), liste[1]… = valeurs de remise
  const listeRemise = pDevis?.listeTauxRemise;

  if (Array.isArray(listeRemise) && listeRemise.length >= 2) {
    const remises = listeRemise.slice(1).filter(t => t !== '' && t !== null && t !== undefined);
    if (remises.length >= 1) {
      const remiseChoices = remises.map((t, i) => ({
        valeur: i + 1,
        label:  String(t).replace(',', '.'),
      }));
      choix.remiseAchat = {
        sendLabel: true,
        choix: [
          { valeur: 0, label: '0 %' },
          ...remiseChoices,
        ],
        fallback: {
          siCondition: { champ: 'remiseAchat', op: 'empty' },
          alors:  0,
          sinon:  0,
        },
      };
      choix.remiseClient = {
        sendLabel: true,
        choix: [
          { valeur: 0, label: '0 %' },
          ...remiseChoices,
        ],
        fallback: {
          siCondition: { champ: 'remiseClient', op: 'empty' },
          alors:  0,
          sinon:  0,
        },
      };
      // console.log(`[detailsDevis] SELECT_CHOIX remiseAchat/remiseClient surchargés depuis listeTauxRemise : ${remises.length} taux`);
    }
  }

  return choix;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── INTERPRÉTEUR DE RÈGLES DÉCLARATIVES ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
//
// Les deux fonctions ci-dessous (postProcessDefaults et postProcessMerge) sont
// GÉNÉRÉES AUTOMATIQUEMENT depuis le bloc MANIFEST.reglesPostProcess.
// Tu n'as pas besoin de les modifier à la main — change plutôt le bloc
// reglesPostProcess dans le MANIFEST ci-dessus.
//
// L'interpréteur supporte :
//   - Opérateurs : empty, eq, neq, gt, lt, gte, lte
//   - Set fixe   : { champ: 'valeur' }
//   - Set abs    : { champ: { abs: true } }
//   - Set conditionnel : { champ: { si: { champ, op }, alors, sinon } }
//   - Condition ET avec "et"

/**
 * Évalue une condition simple { champ, op, valeur? } sur une row.
 * Retourne true/false.
 */
function evalCondition(row, cond) {
  if (!cond) return true;
  const { champ, op, valeur } = cond;
  const val = row[champ];
  const isEmpty = val === '' || val === ' ' || val === null || val === undefined || Number(val) === 0;

  switch (op) {
    case 'empty': return isEmpty;
    case 'eq':    return String(val) === String(valeur);
    case 'neq':   return String(val) !== String(valeur);
    case 'gt':    return Number(val) > Number(valeur);
    case 'lt':    return Number(val) < Number(valeur);
    case 'gte':   return Number(val) >= Number(valeur);
    case 'lte':   return Number(val) <= Number(valeur);
    default:      return false;
  }
}

/**
 * Évalue une règle complète { si, et?, set } sur une row.
 * Si la condition est vraie, applique set sur la row et retourne true.
 */
function applyRegle(row, regle) {
  if (!evalCondition(row, regle.si)) return false;
  if (regle.et && !evalCondition(row, regle.et)) return false;

  for (const [champ, valeur] of Object.entries(regle.set)) {
    if (typeof valeur === 'object' && valeur !== null) {
      if (valeur.abs === true) {
        // { abs: true } → Math.abs()
        const n = Number(row[champ]);
        row[champ] = isNaN(n) ? '' : Math.abs(n);
      } else if (valeur.si) {
        // { si: { champ, op }, alors, sinon }
        row[champ] = evalCondition(row, valeur.si) ? valeur.alors : valeur.sinon;
      } else {
        row[champ] = valeur;
      }
    } else {
      row[champ] = valeur;
    }
  }
  return true;
}

/**
 * Applique toutes les règles d'une catégorie sur les rows.
 * @param {Array} regles  — tableau de règles
 * @param {Array} rows    — tableau de rows
 * @returns {Array} rows modifiées
 */
function applyRegles(regles, rows) {
  if (!regles || !regles.length) return rows;
  return rows.map(row => {
    const r = { ...row };
    for (const regle of regles) applyRegle(r, regle);
    return r;
  });
}

// ── Construction automatique des hooks depuis reglesPostProcess ────────────
const rpp = MANIFEST.reglesPostProcess || {};

/**
 * Appelé après applyPlaceholderDefaults (valeurs par défaut génériques).
 * Généré automatiquement depuis MANIFEST.reglesPostProcess.defaults.
 */
function postProcessDefaults(rows, colonnes, regles) {
  return applyRegles(rpp.defaults, rows);
}

/**
 * Appelé après parseAndMergeRows.
 * Corrige les incohérences que le LLM peut produire malgré les consignes.
 * Généré automatiquement depuis MANIFEST.reglesPostProcess.merge.
 */
function postProcessMerge(mergedRows, originalRows, colonnes) {
  return applyRegles(rpp.merge, mergedRows);
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  MANIFEST,
  MODES,
  SELECT_CHOIX: buildSelectChoix,
  postProcessDefaults,
  postProcessMerge,
};
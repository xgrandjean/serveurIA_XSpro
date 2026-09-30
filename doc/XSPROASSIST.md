# XSProAssist — le troisième canal de remplissage

## L'idée

Le Worker savait remplir une grille de deux façons automatiques : **l'IA par clé API**, qui
répond en un coup à partir d'un long prompt et rend un tableau JSON (`llmClient.js`), et
**Claude par le canal MCP**, un agent que quelqu'un pilote depuis Claude Code avec les outils
`worker_*` (`mcpChannel.js` + `mcpStdio.js`, cf. [`CANAL_MCP.md`](./CANAL_MCP.md)).

**XSProAssist** est ce même agent, mais **autonome et hébergé par le Worker** : il lit la
demande tapée dans la zone de prompt de la grille, dialogue avec un modèle « ordinaire » par
**appels d'outils** (format chat completions, `tools` + `tool_choice: "auto"`), exécute chaque
appel par les **mêmes verbes** que la façade MCP — donc avec les mêmes garde-fous — et clôt par
`worker_terminer`, dont le rapport s'affiche dans le fil. C'est la transposition, dans le
Worker, du XSProAssist de la salle d'attente de XSpro (`XSpro/tools/xsproassist/assistant.js`).

Comme les deux autres canaux, il ne fait que **proposer** : ses écritures arrivent en attente
dans la grille (ambre, ✓/✗), et c'est l'utilisateur seul qui renvoie le résultat à XSpro.
**Aucun chemin de ce canal ne touche `deliverResult`.**

Le modèle est celui du **bloc `ia` de la session** — la clé que XSpro a prêtée (cf.
`XSPRO_INTEGRATION.md`, « D'où vient le bloc `ia` »), ou celle de `standalone/ia-config.json`
en mode autonome. Il doit savoir appeler des outils ; s'il refuse (HTTP 400), le fil le dit
avec le geste qui le lève — jamais de repli silencieux sur la clé API.

## Les trois canaux, côte à côte

| Canal | Qui remplit | Comment | Ce que l'utilisateur voit |
|---|---|---|---|
| `api` | l'IA par clé API | un prompt, une réponse JSON, recollée sur les lignes | la zone de prompt, le badge du modèle, les cellules qui arrivent |
| `assist` | **XSProAssist** | un agent hébergé ici, même clé, outils `worker_*` | la zone de prompt, le badge du modèle, **le journal** (chaque appel au modèle et à un outil), puis le rapport |
| `mcp` | Claude | un agent piloté depuis Claude Code, outils `worker_*` par la façade | le panneau MCP (branchement, numéro de session) |

La saisie à la main reste possible dans les trois cas : ce n'est pas un canal, c'est la grille.

Le sélecteur « Remplissage » de la grille choisit le canal ; le choix explicite de l'utilisateur
fait mémoire (`.worker-canal.json`) comme pour les deux autres, et `canalParDefaut` de
`worker-config.json` accepte `"assist"`. Sans clé prêtée (`ia: null`), les options « Clé API »
et « XSProAssist » sont grisées : seul le canal MCP peut remplir.

## Ce qu'un traitement fait exactement

`server.js`, `prompt:send`, quand `session.canal === 'assist'` :

1. la session passe en `acting` — ce statut ferme la grille (boutons, déplacement de lignes,
   bascule de canal) et le canal MCP le temps du traitement, comme pour la clé API ;
2. `xsproassist.traiter(session, { demande, files, activeMode })` :
   - **le contexte**, par le verbe `contexte` — le même que `worker_contexte` : colonnes du
     mode de travail (celui du sélecteur de la grille), lignes avec leur `_id` (200 au plus
     d'emblée), informations de l'affaire, et le **briefing** de la vue (mission, règles,
     exemple, lignes-modèle, correspondance des outils, consigne de la phase bêta) ;
   - **la consigne système** : qui il est, comment il répond (uniquement par outils, toujours
     conclure par `worker_terminer`, ne rien inventer, un refus se corrige), puis le briefing ;
   - **le message utilisateur** : la demande, puis le contexte en JSON ; les fichiers joints
     suivent par le même routage que la clé API (`llmClient.buildUserContent`, selon le
     provider) ;
   - **la boucle** : au plus 12 tours. À chaque tour le modèle rend des appels d'outils, chacun
     est exécuté par son verbe avec `sessionId` **imposé** (le modèle ne le connaît pas), le
     résultat lui revient tel quel (`cellulesEcrites`, `ignorees`, `ids`…, ou `{ erreur }`),
     borné à 30 000 caractères. Un modèle qui répond par du texte est relancé deux fois, en
     lui rappelant le dernier refus. `worker_terminer` conclut : statut `paused`, `act:done`
     avec le rapport ;
3. **s'il n'a pas conclu** : s'il a écrit, XSProAssist appelle lui-même `worker_terminer` avec
   un rapport qui le dit (« ⚠ XSProAssist n'a pas conclu… ») — les propositions sont dans la
   grille, elles restent à relire ; s'il n'a rien écrit, ou si le modèle est injoignable ou
   refuse les outils, la session passe en `error` et le fil affiche la cause.

Les écritures sont strictement celles d'un client MCP : `SM.setCellValue` + `cell:update`, puis
un `cell:validate` par ligne (c'est lui qui pose l'ambre « en attente »), `review:sync` après
une insertion ou une suppression, `act:done` à la fin. Les mêmes conversions (type de colonne,
`valeur` ou `label` d'une colonne à choix, alias déclarés par la vue) et les mêmes refus
rapportés (colonne inconnue, hors du mode, `_id` introuvable).

## Les outils du modèle

Les mêmes déclarations que la façade (`mcpStdio.js`, `OUTILS`), au format chat completions,
**sans `sessionId`** dans les schémas :

| Outil | Note pour ce canal |
|---|---|
| `worker_contexte` | description propre au canal : relire les lignes (pagination), le briefing n'est jamais resservi (`briefing: false` imposé) |
| `worker_ecrire_cellules` | tel quel |
| `worker_inserer_lignes` | tel quel |
| `worker_supprimer_lignes` | tel quel |
| `worker_terminer` | tel quel — c'est la conclusion attendue |
| `worker_signaler_anomalie` | seulement si `beta.rapportAnomalies` est actif, comme la consigne qui va avec |

`worker_sessions` n'en fait pas partie : la session est celle de la grille, imposée.

## Le journal — commun aux deux canaux

`journalTraitement.js`. Chaque traitement automatique, par la clé API (`llmClient.run`) comme par
XSProAssist, tient le même journal : gardé sur la session (`session.journalTraitement`, le dernier
traitement), poussé en direct vers la grille (`journal:etape`, une ligne du fil par étape), rejoué
à l'ouverture suivante (`init.journal`) — l'utilisateur peut découvrir des lignes en attente
posées pendant que la grille était fermée, avec ce qui les a produites. C'est aussi ce qui permet
de comparer les deux canaux sur des faits (`scripts/comparer-canaux.js`, ci-dessous).

| Événement | Ce qu'il porte |
|---|---|
| `debut` | modèle, mode de travail, nombre de lignes, taille de l'envoi, messages d'historique rejoués ; clé API : mode plan/act |
| `modele` | tour, durée, ok/échec (statut HTTP, cause), taille de l'envoi et de la réponse, jetons si le fournisseur les dit, `finish_reason` (une réponse **coupée** par la limite de sortie est nommée) ; clé API : mode JSON et nombre d'essais ; XSProAssist : appels d'outils demandés |
| `relance` | XSProAssist : le modèle a parlé au lieu d'agir ; clé API : JSON invalide, correction demandée |
| `outil` | XSProAssist : nom, ok/refus, résumé chiffré (« 12 cellule(s) dans 4 ligne(s), 1 valeur(s) écartée(s) ») ou l'erreur |
| `fin` | issue (`terminee`, `plan`, `sansConclusion`, `injoignable`, `erreur`), motif, durée, tours ; ce qui est **retenu** (lignes ajoutées, modifiées, supprimées, cellules) ; clé API : ce que le modèle **déclarait** et les actions sans effet, les avertissements de troncature ; XSProAssist : appels et refus d'outils, relances |

`journalTraitement.mesuresDe(journal)` en tire les mesures à plat, les mêmes colonnes pour les
deux canaux. La trace « dernier envoi » de la grille (📋 → « Dernier envoi ») montre l'échange
lisible : la consigne système, la demande, chaque appel d'outil et son résultat.

## L'historique d'une session

Aucun modèle ne se souvient de rien entre deux appels : ce que la clé API « retient », c'est
le Worker qui le lui renvoie — les tours passés (`llmTurns`, quand la vue déclare des `slots`,
dans la limite `historique.limite` de son JSON). XSProAssist fait de même depuis ce lot : avant
la demande courante, il rejoue chaque demande passée de la session et ce qu'il en a fait (les
lignes écrites avec leurs `_id`, son rapport) comme un dialogue user/assistant — jamais le
détail des appels d'outils. Même limite que la vue (15 tours à défaut) ; un traitement sans
écriture ni conclusion n'entre pas ; « Nouvelle tâche » et « Reset » effacent.

## Garde-fous

Ceux du canal MCP, inchangés, plus une seule chose : chaque verbe d'écriture sait **qui**
demande (`origine` : `'mcp'` par la façade HTTP, `'assist'` par XSProAssist) et n'accepte que
l'appelant dont la session porte le canal. En canal `assist`, Claude reçoit donc un refus qui
nomme XSProAssist et le geste (basculer le sélecteur) ; en canal `mcp` ou `api`, XSProAssist
est refusé de même — inatteignable depuis la grille, mais le verbe se protège lui-même.

Le statut `acting` reste fermé au canal MCP (« l'IA par clé API ou XSProAssist travaille en ce
moment ») ; XSProAssist, lui, écrit précisément pendant ce statut.

Rien de nouveau côté réseau : XSProAssist tourne dans le process, il ne passe pas par
`/mcp/commande`.

## Ce que ce canal ne fait pas

- **Livrer** vers XSpro — jamais.
- **Planifier** : pas de mode Plan (le sélecteur Plan/Act est masqué) ; il agit, ou dit dans
  son rapport pourquoi il ne peut pas.
- **Replier** sur la clé API quand le modèle refuse les outils : il le dit, c'est tout.

## Tests

```
npm run test:assist     xsproassist.js avec un FAUX modèle en mémoire : outils, consigne,
                        cas nominal, refus renvoyés, relances, sans conclusion, injoignable,
                        garde-fous du canal dans les deux sens, relecture du contexte,
                        fichiers joints, rien ne part (aucun serveur, aucun appel payant)
npm run test:mcp:e2e    + XSProAssist de bout en bout : un faux modèle servi par HTTP, une
                        session au bloc « ia » pointé dessus, la bascule et la demande par la
                        WebSocket comme la grille, le journal, act:done, le rejeu à l'ouverture,
                        le refus d'écriture MCP pendant ce temps, un modèle sans outils (400)
```

## Limites connues

- Le contexte initial porte au plus 200 lignes ; au-delà, le modèle doit relire par
  `worker_contexte` (offset, limite), et rien ne l'y force.
- 12 tours et 2 relances au plus (`MAX_TOURS`, `MAX_RELANCES`, dans `xsproassist.js`) : une
  grille très longue à remplir peut s'arrêter « sans conclusion », propositions posées.
- Un seul traitement à la fois par session (le statut `acting` l'impose) ; deux sessions
  peuvent tourner en parallèle.
- XSpro n'envoie pas encore de marqueur `canal: "assist"` : le canal d'une session neuve
  vient de la mémoire du sélecteur (ou de `canalParDefaut`), comme pour les deux autres.
- Le modèle prêté par XSpro est celui de `config_or` (puis `config_hf`) : s'il ne sait pas
  appeler d'outils, ce canal ne peut rien — le message le dit, et le remède est côté XSpro
  (Configuration IA).

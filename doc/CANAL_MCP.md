# Canal MCP — remplir la grille avec Claude

## L'idée

Dans le Worker, l'IA par clé API n'est qu'un moyen de **pré-remplir** la grille : l'utilisateur
peut déjà tout saisir à la main, puis renvoyer à XSpro. Le canal MCP est une **troisième façon
de remplir les lignes**, à côté de la clé API et de la main. Rien n'est remplacé, rien n'est
retiré.

La validation finale reste humaine : Claude remplit, l'utilisateur relit dans la grille et
renvoie lui-même à XSpro. **Aucun outil ne déclenche la livraison.**

## Un seul canal à la fois

Un sélecteur « Remplissage » dans l'en-tête de la grille choisit qui pré-remplit :

| Canal | Visible dans l'UI | Masqué |
|---|---|---|
| `api` | zone de prompt, badge du modèle, ⚙ Config IA | le panneau MCP |
| `mcp` | le panneau MCP (numéro de session, état) | zone de prompt, badge du modèle, ⚙ Config IA |

La grille, la barre de revue et le fil de conversation restent visibles dans les deux cas : la
saisie à la main n'est pas un « mode », c'est la grille elle-même.

Le verrou est aussi côté serveur, dans les deux sens : `prompt:send` et `plan:validate` sont
refusés hors canal `api` ; les verbes d'écriture MCP sont refusés hors canal `mcp`. Les verbes
de **lecture** restent toujours autorisés, pour que Claude puisse voir l'état d'une session et
expliquer pourquoi il ne peut pas écrire.

## Qui décide du canal d'une session neuve

Deux règles, et une mémoire.

**XSpro le dit quand il n'a rien à prêter.** Depuis la révision du contrat `/process`
(`XSpro/src/aiView/aiQuery.js`), XSpro envoie `ia: null` **et** un marqueur `canal: "mcp"` au
premier niveau du corps, exactement lorsqu'aucun canal IA n'est actif de son côté sur une vue
que le Worker sait traiter. Le Worker **force** alors le canal MCP : sans cela la session
naîtrait avec une zone de prompt visible, un bloc `ia` vide, et aucune façon d'aboutir.

Ce forçage vaut pour **cette session seulement**. Il ne fait pas mémoire : que XSpro n'ait pas
de clé à prêter à un instant donné ne dit rien de la façon dont l'utilisateur veut travailler.

**Sinon, on garde le dernier canal choisi par l'utilisateur.** On ne s'aligne surtout pas sur
`api` par réflexe : qu'une session arrive avec une clé n'est pas une raison de ramener le
Worker sur le chemin clé API si son utilisateur travaille avec Claude.

**La mémoire** vit dans `.worker-canal.json`, à côté de `.worker.lock`, dans le dossier de
données — purement local au Worker, il ne relie rien à XSpro. Elle est lue **une fois au
démarrage** (la variable en mémoire fait foi ensuite) et écrite **uniquement** sur un
basculement explicite du sélecteur « Remplissage ». Fichier absent ou illisible →
`worker-config.json` → `"canalParDefaut"`, qui ne fixe donc plus que le tout premier départ.

Régler `"canalParDefaut": "mcp"` reste utile sur un poste neuf : il permet à Claude de préparer
une session **sans que la grille ait été ouverte** — `wsSend` ne fait rien quand personne
n'écoute, mais les valeurs sont bien posées dans la session, et l'`init` les transmet à
l'ouverture.

**Quand XSpro n'a pas de clé et que le canal MCP est fermé** (`mcp.actif: false`), le forçage a
lieu quand même. La session n'est de toute façon remplissable par personne, et le canal répond
alors par un diagnostic juste — « désactivé dans worker-config.json, le réactiver » — au lieu
d'une erreur de LLM sans rapport avec la cause.

Sur une session forcée, l'option « Clé API » du sélecteur est **grisée**, avec la raison en
info-bulle : il n'y a pas de clé, s'y engager ne mènerait nulle part.

## Les deux pièces

```
mcpChannel.js                  la logique, les verbes, les garde-fous  → embarqué dans serveurIA.exe
mcpStdio.js                    la façade MCP, qui ne fait que traduire → embarqué dans serveurIA.exe
tools/mcp-worker/server.js     le point d'entrée du dépôt : trois lignes qui appellent demarrer()
```

Même séparation que `XSpro/src/agent/agentBridge.js` + `XSpro/tools/mcp-xspro/server.js` : un
client MCP ne peut rien faire de plus que ce que le canal autorise déjà.

**Pourquoi la façade vit à la racine.** `pkg` ne suit que le graphe de `require` de
`server.js` : un module sous `tools/` n'entre pas dans `serveurIA.exe`, et la façade
n'existerait alors que sur un poste de développement — dépôt cloné, Node installé, client MCP
ouvert sur le dossier. L'utilisateur, lui, n'a que l'application : il n'aurait aucun moyen de
brancher Claude, et la grille lui proposerait de copier un numéro de session sans que rien
puisse le lire. C'est exactement ce qu'a révélé le premier essai de production.

Donc : `mcpStdio.js` est requis par `server.js`, et `tools/mcp-worker/server.js` n'est plus
qu'un point d'entrée pour le dépôt. Le déplacer sous `tools/` le retirerait du build **sans
aucun message d'erreur**. `mcpStdio.js` est aussi listé dans `build.files` de `package.json`
— cette liste est explicite, un module oublié ferait planter l'application packagée.

Déclaration, dans `.mcp.json` à la racine — pour le dépôt seulement. Le nom
`worker-dev`, et non `worker` : le bouton « Connecter Claude » de la grille inscrit
`mcpServers.worker` en portée *user* (`~/.claude.json`), pointant vers l'exe
(`serveurIA.exe --mcp`). Deux scopes déclarant le MÊME nom avec des commandes
différentes font lever à Claude Code un avertissement « Conflicting scopes » à
chaque session ouverte sur le dépôt. `worker-dev` offre la façade sans le conflit
— les outils s'appellent toujours `worker_*` quoi qu'il arrive, le nom de serveur
ne change rien aux noms d'outils.

```json
{ "mcpServers": { "worker-dev": { "command": "node", "args": ["tools/mcp-worker/server.js"] } } }
```

## Chez l'utilisateur : `serveurIA.exe --mcp`

L'utilisateur n'installe pas le Worker, il installe XSpro — qui embarque `serveurIA.exe` et le
copie dans son dossier de données au premier démarrage. Le même exe sert de deux façons :

```
serveurIA.exe          le Worker : Express, WebSocket, sessions   ← lancé par XSpro
serveurIA.exe --mcp    la façade MCP sur stdin/stdout             ← lancé par Claude
```

Les deux processus sont indépendants : la façade ne fait que parler au Worker déjà lancé, par
le canal HTTP local. On peut donc la brancher, la débrancher et la relancer sans jamais
toucher aux sessions ouvertes.

Le drapeau est traité **avant les `require`** de `server.js` : dans ce mode, stdout appartient
au protocole, et rien d'autre ne doit démarrer — ni Express, ni WebSocket, ni verrou.

**Le port.** La façade est lancée par Claude, jamais par XSpro : elle n'hérite pas de
`AI_WORKER_ASSETS_DIR` et ne peut rien présumer de son voisinage. `racinesConfig()`
(`mcpStdio.js`) essaie donc, dans l'ordre : cette variable si elle est là, le dossier de l'exe,
puis `<exe>/serveurIA-data/` — la disposition réelle d'une installation, où XSpro pose l'exe
dans `userData` et les assets dans ce sous-dossier. À défaut, 8888.

## Le bouton « Connecter Claude »

Reste à inscrire la façade chez Claude. C'est un bouton dans le panneau MCP de la grille, et
non une commande à taper : `claudeConfig.js` écrit la clé `mcpServers.worker` de
`~/.claude.json` — même fichier, même entrée que `claude mcp add -s user`.

**Pourquoi c'est le Worker qui inscrit, et pas XSpro.** Lui seul connaît le chemin de sa propre
façade, et il y a deux cas : l'exe compilé (`process.execPath` + `--mcp`) chez l'utilisateur,
le point d'entrée du dépôt (`node tools/mcp-worker/server.js`) chez le développeur. Aucun des
deux ne se devine depuis l'extérieur. Accessoirement, c'est le Worker qui sert la grille : le
bouton est donc à l'endroit exact où l'utilisateur découvre qu'il lui faut Claude.

**D'où l'entrée prend effet.** L'inscription `mcpServers.worker` est lue par
**Claude Code** (la commande `claude`, ou l'extension Claude Code dans VS Code) à
l'ouverture d'une session — jamais par une fenêtre déjà ouverte. Pour l'essai,
ouvrir une session sans dossier ouvert : seule l'entrée `user` s'applique alors.

**L'application Claude de bureau a sa propre inscription.** Elle lit
`claude_desktop_config.json` (distinct de `~/.claude.json`) et n'expose pas les
serveurs stdio de la portée `user`. Le bouton « Connecter Claude » l'inscrit
aussi — aux deux emplacements connus (installation classique `%APPDATA%\Claude`
et Microsoft Store/MSIX) — et le panneau le dit d'une phrase. Il faut alors
**fermer puis rouvrir l'application** : son fichier de configuration n'est lu
qu'au démarrage. Un numéro collé dans une application non inscrite répond
« aucun connecteur ne correspond », sans qu'aucun code du Worker soit en cause.

**Un numéro de session ne suffit jamais.** Collé seul, Claude répond « ceci n'est
qu'un identifiant, que veux-tu que j'en fasse » — et l'utilisateur croit que le
canal est en panne, alors qu'il n'a simplement pas donné de consigne. Le bouton
📋 de la grille copie une phrase complète qui force les outils
`worker_sessions` puis `worker_contexte` (cf. `public/grid.js`,
`consigneSession`).

**Le mode de travail suit le sélecteur de la grille.** La grille annonce au
serveur chaque changement de mode (`workmode:set`) ; `worker_contexte` applique
par défaut le mode ainsi choisi. Priorité : un mode demandé explicitement >
le sélecteur de la grille > le mode par défaut de la vue. `worker_sessions` le
rapporte (`modeActif`). Après un changement de mode, Claude doit rappeler
`worker_contexte` pour relire le contexte.

**Ce que le panneau montre**, demandé à chaque affichage (`claude:etat`) :

| État | Ce qu'on voit |
|---|---|
| branché | ligne verte, pas de bouton |
| pas inscrit | ligne ambre, « Claude n'est pas branché sur ce poste » + bouton |
| inscrit ailleurs | ligne ambre, « sur un autre exécutable » + bouton **Rebrancher** |
| échec de l'écriture | ligne rouge, la cause, **et la commande à taper** |

L'état est relu depuis le fichier après chaque écriture : c'est lui qui peint le panneau, jamais
le message de retour. Si Claude tournait et a réécrit sa configuration entre temps, l'entrée a
disparu — et le panneau le dit, au lieu d'annoncer un succès que rien ne confirme.

**Précautions**, parce que ce fichier ne nous appartient pas : il est relu juste avant
l'écriture, copié en `.claude.json.avant-xspro`, modifié à une seule clé, puis remis en place
par un renommage atomique. Le reste — projets, historique, préférences — n'est jamais touché.

**Un piège qui vaut d'être dit** : Claude lit sa configuration à l'ouverture d'une session.
Après le branchement, il faut une fenêtre **neuve** ; celle qui est déjà ouverte ne verra rien.

**Chez l'utilisateur**, le chemin inscrit est celui de la copie dans `userData`
(`Globals.modelServeurIAExe`), jamais celui des assets : ceux-ci sont packés dans `app.asar`,
d'où aucun exécutable ne se lance.

## Les sept outils

| Outil | Ce qu'il fait |
|---|---|
| `worker_sessions` | Les grilles ouvertes, ce que XSpro a demandé, les modes, si c'est inscriptible |
| `worker_contexte` | Colonnes du mode, lignes avec leur `_id`, et le **briefing** — les règles métier de la vue et ses exemples |
| `worker_ecrire_cellules` | Pose des valeurs : plusieurs lignes, plusieurs colonnes, un appel |
| `worker_inserer_lignes` | Ajoute des lignes (chemin du bouton « + Ligne »), rend les `_id` créés |
| `worker_supprimer_lignes` | Marque des lignes à supprimer (chemin du bouton « ✂️ ») |
| `worker_terminer` | Clôt le lot : statut `paused`, grille redessinée, rapport affiché |
| `worker_signaler_anomalie` | **Phase bêta** — consigne dans un journal, pour le développeur, ce qui cloche dans les données reçues |

Les lignes se désignent par leur **`_id`** (stable toute la session), jamais par leur position :
la traduction en index se fait au moment d'écrire, si bien qu'un déplacement ou un ajout fait
par l'utilisateur entre deux lots est sans conséquence.

## Le briefing : deux jeux de prompts, et pourquoi

Le **briefing** est ce que Claude reçoit comme consignes métier. Il vient, par ordre de
priorité :

1. du bloc **`mcp`** du JSON pairé de la vue (`views/<vue>.json`) — des consignes courtes,
   écrites pour ce canal ;
2. à défaut, du prompt système de l'IA à clé API, **amputé** de ce qui ne vaut que pour elle.

Pourquoi deux jeux plutôt qu'un. Les prompts de la clé API ont été écrits pour un modèle de
puissance limitée, joignable par une seule requête sans dialogue possible. Ils sont donc longs,
méfiants, répétitifs — et se terminent par un contrat de réponse : *« Réponds UNIQUEMENT avec
un tableau JSON valide […] Pas de texte avant ni après. »* Par MCP, c'est l'inverse qu'il faut
faire : appeler des outils, et parler à l'utilisateur. Les reprendre tels quels revenait à
donner une consigne fausse et à payer quelque 8 000 caractères de garde-fous devenus sans
objet. Mesuré sur les six vues : le briefing est passé de 4 221–17 778 caractères à
3 250–5 449, et de 9 395 à 3 653 sur `detailsDevis/décomposition`. (La consigne de la phase
bêta ci-dessous en rajoute ~950, portant l'intervalle servi aujourd'hui à 4 202–6 401.)

**Les prompts de la clé API ne sont pas touchés**, et la divergence est assumée : les deux
lecteurs n'ont ni la même puissance, ni le même canal. Une règle métier qui change doit donc
être portée aux deux endroits — un test compare mot pour mot, avant et après, ce que reçoit
la clé API.

### Le bloc `mcp`

À la racine du JSON pairé **et** par mode :

```jsonc
"mcp": {
  "mission": "2 à 5 lignes : ce que Claude fait sur cette vue, dans ce mode.",
  "regles":  ["une phrase par règle métier", "..."],
  "exemple": "un appel d'outil, montrant la forme attendue"
}
```

Contrairement aux quatre autres champs prompt, qui se **remplacent** en bloc, celui-ci se
**compose** : la racine porte ce qui vaut pour toute la vue, le mode ajoute son spécifique, et
les règles sont concaténées. C'est délibéré — la règle du remplacement total oblige sinon à
recopier dans chaque mode ce qui vaut pour la vue, et c'est précisément ce qui a produit
l'encart `VOCABULAIRE` dupliqué quatre fois dans `detailsDevis`.

Ce qu'un bloc `mcp` ne reprend pas : la liste des colonnes (`worker_contexte` la sert déjà,
structurée, avec les types et les valeurs admises), les consignes de format, et les garde-fous
écrits pour un modèle faible. Ce qu'il garde : les valeurs stockées exactes, les invariants,
les arbitrages métier, et les exemples.

**Attention** — `mergePromptFields` (`viewResolver.js`) est une **liste fermée** : un champ
prompt qui n'y est pas nommé est ignoré sans erreur. Ajouter une clé au JSON pairé sans
l'ajouter là donne un fichier qui a l'air correct et qui ne sert à rien.

### Le repli

Pour une vue sans bloc `mcp` : le prompt de la clé API, coupé à partir de
`== FORMAT DE RÉPONSE ==` (toujours en dernière position), débarrassé de `== COLONNES ==`, et
suivi de la correspondance avec les outils. Utilisable immédiatement, sans relecture — mais ce
n'est pas l'état visé : une vue reprise à la main dit les choses en trois fois moins.

## Ce qu'une écriture MCP fait exactement

Pour chaque cellule, strictement ce que fait `onCellUpdate` sur le chemin clé API
(cf. `server.js`, case `prompt:send`) :

```js
SM.setCellValue(session, rowIndex, cle, valeur);
wsSend(session, { type: 'cell:update', rowIndex, cle, value: valeur });
```

puis, par ligne touchée, un `cell:validate` consolidé — copie du chemin de saisie manuelle.
**Il n'est pas cosmétique** : c'est lui qui recopie `__pendingFields` côté client et fait donc
apparaître l'ambre « en attente » ; un `cell:update` seul ne la déclenche pas.

Les six vues du projet déclarant `revueParPending: true`, toute écriture MCP arrive comme une
**proposition** : ligne ambrée, ✓/✗ par champ, et « Valider et exporter » masqué tant qu'il
reste des propositions à trancher (`server.js`, case `session:validate`).

Deux conversions sont appliquées avant d'écrire, pour que MCP produise exactement ce que
produirait une saisie manuelle :
- **type** — miroir de `coerceValueForGrid` (`public/grid.js`) : `"120"` devient `120` sur une
  colonne numérique. Une valeur non numérique est laissée intacte et non remplacée par `0`.
- **colonnes à choix** — la `valeur` comme le `label` sont acceptés, résolus **avant** la
  conversion de type (un label comme « 35 €/h » donnerait sinon `35` à `parseFloat`).

Les colonnes inconnues et les `_id` introuvables sont **écartés et rapportés** dans la réponse :
sans cela, une faute de frappe créerait un champ fantôme expédié à XSpro.

## Phase bêta — le rapport d'anomalies

Pendant la bêta, Claude est le seul à voir en vrai ce que XSpro envoie au Worker. Un septième
outil, `worker_signaler_anomalie`, lui permet de consigner ce qui ne tient pas debout : des
données qui contredisent la réalité de l'affaire, un libellé de colonne qui ne décrit pas son
contenu, une règle métier intenable, une valeur attendue absente d'une liste de choix, une
colonne masquée par un mode alors qu'elle serait nécessaire.

**Ce journal s'adresse au développeur, pas à l'utilisateur.** L'outil n'écrit rien dans la
grille et n'émet aucun message WebSocket. La consigne donnée à Claude lui interdit d'expliquer
l'anomalie dans la grille : s'il en a signalé au moins une, il ajoute à son rapport de fin
cette phrase, et rien d'autre à ce sujet —

> Rapport d'activité mis à jour — voir le fichier log correspondant.

L'utilisateur averti sait ainsi qu'il y a eu un souci, et transmet le fichier.

**Où** : `logs/anomalies-AAAA-MM-JJ.jsonl`, à côté de `exports/`, dans le dossier de données du
Worker (créé au premier signalement, ignoré par git). Une ligne JSON par anomalie —
horodatage, gravité (`mineure` / `genante` / `bloquante`), session, vue, mode, origine, canal,
description, et les éléments en cause en forme libre.

**Interrupteur** : `worker-config.json` → `"beta": { "rapportAnomalies": false }` coupe à la
fois l'outil et la consigne dans le briefing. Le coût de cette consigne est d'environ
950 caractères par briefing, ce qui est la raison d'être de l'interrupteur.

À trancher avant de figer : garde-t-on le mécanisme une fois la bêta finie, et si oui, que
devient le journal — rotation, purge, remontée automatique ? Le bandeau en tête de
`mcpChannel.js` pose la question à l'endroit où on la relira.

## Garde-fous

**Accès** — le Worker écoute sur toutes les interfaces avec un CORS permissif. Le canal ajoute
trois filtres, montés **avant** ce middleware CORS :

1. **loopback** — ferme le réseau local ;
2. **refus de tout en-tête `Origin`** — un navigateur en met toujours un sur un POST
   cross-origin, `curl` et Node n'en mettent pas ; c'est ce filtre qui ferme le vecteur « page
   web ouverte chez l'utilisateur », que le loopback seul ne bloque pas (une telle page poste
   depuis 127.0.0.1) ;
3. **en-tête `X-Worker-MCP: 1`** — non listée dans `Access-Control-Allow-Headers`, donc
   inenvoyable en cross-origin : le préflight échoue avant la requête.

`"mcp": { "actif": false }` dans `worker-config.json` ferme complètement le canal.

**Statut** — une écriture n'est acceptée que sur `idle`, `connected`, `paused`, `error`. Sont
refusés : `planning`/`acting` (l'IA par clé API travaille, deux sources écriraient les mêmes
lignes), `delivering`, et `done` — une session livrée a vu ses lignes partir chez XSpro, une
écriture ne repartirait pas.

**Lignes** — insertion et suppression sont refusées hors mode revue : une ligne
`__pendingDelete` y survivrait à `snapshotRows` et partirait quand même chez XSpro, alors
qu'elle était marquée supprimée.

## Tests

```
npm run test:mcp        protocole + garde-fous du canal
npm run test:mcp:e2e    + un aller-retour complet sur une vraie session
```

L'aller-retour lance un Worker au besoin (ou réutilise celui qui tourne), crée une session par
`POST /process`, se connecte comme le ferait la grille, bascule le canal, enchaîne les six
outils, et vérifie pour finir qu'**aucun fichier n'est apparu dans `exports/`** — la preuve
qu'aucun verbe n'a déclenché la livraison. Aucun navigateur ne s'ouvre.

## Limites connues

- `rows:sync` (`server.js`) écrase `session.rows` à l'aveugle depuis le client. Il n'est émis
  que sur un ajout/suppression manuel de ligne et sur le « ↺ Annuler » du toast : une écriture
  MCP exactement simultanée à ce geste serait perdue. Fenêtre étroite, déjà vraie pour le
  chemin clé API.
- Les écritures MCP ne passent pas par `viewHook.validateCellEdit` — comme le chemin clé API.
  Le `cell:validate` émis après chaque ligne en rapporte néanmoins les champs fautifs.
- `cell:update` écrit dans `state.rows[rowIndex]` mais anime `getDisplayedRowAtIndex(rowIndex)` :
  sous le filtre « en attente seulement », le flash visuel vise la mauvaise ligne. Défaut
  pré-existant du chemin clé API ; le re-rendu complet de `worker_terminer` le rattrape.

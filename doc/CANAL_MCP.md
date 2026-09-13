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

Le canal de départ des nouvelles sessions vient de `worker-config.json` :

```json
"canalParDefaut": "api"     // ou "mcp"
```

Régler `"mcp"` permet à Claude de préparer une session **sans que la grille ait été ouverte** :
`wsSend` ne fait rien quand personne n'écoute, mais les valeurs sont bien posées dans la
session, et l'`init` les transmet à l'ouverture.

## Les deux pièces

```
mcpChannel.js                  la logique, les verbes, les garde-fous  → embarqué dans serveurIA.exe
tools/mcp-worker/server.js     la façade MCP, qui ne fait que traduire → hors périmètre du build
```

Même séparation que `XSpro/src/agent/agentBridge.js` + `XSpro/tools/mcp-xspro/server.js` : un
client MCP ne peut rien faire de plus que ce que le canal autorise déjà.

Le dossier `tools/` reste hors du build sans effort particulier : `pkg` ne suit que le graphe
de `require` de `server.js`, et `scripts/copy-assets-for-xspro.js` a une liste fermée
(`public`, `views`, `worker-config.json`). **Ne pas l'y ajouter.** En revanche `mcpChannel.js`
est listé dans `build.files` de `package.json` — cette liste est explicite, un module oublié
ferait planter l'application packagée au démarrage.

Déclaration, dans `.mcp.json` à la racine :

```json
{ "mcpServers": { "worker": { "command": "node", "args": ["tools/mcp-worker/server.js"] } } }
```

## Les six outils

| Outil | Ce qu'il fait |
|---|---|
| `worker_sessions` | Les grilles ouvertes, ce que XSpro a demandé, les modes, si c'est inscriptible |
| `worker_contexte` | Colonnes du mode, lignes avec leur `_id`, et le **briefing** — les consignes métier exactes de l'IA à clé API |
| `worker_ecrire_cellules` | Pose des valeurs : plusieurs lignes, plusieurs colonnes, un appel |
| `worker_inserer_lignes` | Ajoute des lignes (chemin du bouton « + Ligne »), rend les `_id` créés |
| `worker_supprimer_lignes` | Marque des lignes à supprimer (chemin du bouton « ✂️ ») |
| `worker_terminer` | Clôt le lot : statut `paused`, grille redessinée, rapport affiché |

Les lignes se désignent par leur **`_id`** (stable toute la session), jamais par leur position :
la traduction en index se fait au moment d'écrire, si bien qu'un déplacement ou un ajout fait
par l'utilisateur entre deux lots est sans conséquence.

Le **briefing** vient de `llmClient.buildPromptPreview()` : c'est le system prompt que
recevrait l'IA à clé API pour le mode demandé. Les deux canaux travaillent donc avec les mêmes
règles métier, sans que `llmClient.js` ait été modifié.

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

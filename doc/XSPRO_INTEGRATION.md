# AI Worker — Intégration XSpro

## Vue d'ensemble

Le Worker est un serveur autonome. XSpro l'appelle via HTTP et reçoit la réponse sur un endpoint dédié. Les deux processus sont indépendants — XSpro n'attend pas le résultat en temps réel.

```
XSpro ──POST /process──► Worker  (déclenchement)
XSpro ◄──POST callback── Worker  (résultat, annulation, ou refus)
```

---

## 1. Démarrage du Worker

XSpro spawne le Worker au démarrage si ce n'est pas déjà actif.

```js
// Côté XSpro — exemple de spawn
const { spawn } = require('child_process');
const worker = spawn('node', ['server.js'], {
  cwd:      '/chemin/vers/ai-worker',
  detached: true,
  stdio:    'ignore',
});
worker.unref(); // ne bloque pas XSpro
```

**Probe de disponibilité** avant tout appel :

```
HEAD http://localhost:8888/view-config/
```

- Réponse `200` → Worker disponible
- Timeout ou erreur → Worker absent, traitement local

Le port est configurable dans `ai-worker/worker-config.json` (défaut : `8888`).

---

## 2. Envoi d'une requête — `POST /process`

XSpro envoie le payload complet. Le Worker répond **immédiatement** avec un accusé de réception — la réponse finale arrive ensuite sur `callbackUrl`.

### Endpoint
```
POST http://localhost:8888/process
Content-Type: application/json
```

### Payload
```json
{
  "sessionId":   "detailsDevis_onglet3_1719300000000",
  "contextName": "detailsDevis",
  "callbackUrl": "http://localhost:3000/worker-response",

  "ia": {
    "apiKey":    "sk-xxxxxxxxxxxx",
    "endpoint":  "https://albert.api.etalab.gouv.fr/v1/chat/completions",
    "provider":  "albert",
    "model":     "mistralai/Ministral-3-8B-Instruct-2512",
    "timeoutMs": 30000,
    "maxPromptLength": 25000
  },

  "data": {
    "lignes": [
      { "niveauListe": 1, "designation": "CHAPITRE EXEMPLE - Travaux...", "unite": "", ... },
      { "niveauListe": 2, "designation": "Fourniture et pose de parpaings...", "unite": "m²", ... }
    ],
    "lexique": {
      "niveauListe": "niveau hiérarchique de la ligne...",
      "designation": "description de l'article..."
    },
    "infosParent": {
      "noDevis": "DEV-2026-001",
      "date": "2026-06-15 10:30:00",
      "responsableDuDevis": "Martin Dupont",
      "nom du client": "BTP Martinique",
      "entreprise cliente": "SARL BTPM"
    },
    "infosVue": {
      "parametresDevis": {},
      "nomOnglet": "Devis IA"
    },
    "maxContenu": 50000,
    "modele": [ /* lignes d'exemple */ ]
  },

    "workerConfig": {
      "viewModule": "detailsDevis",
      "colonnes": [
        { "champ": "niveauListe", "cle": "niveauListe", "libelle": "niveau hiérarchique de la ligne : 1 = chapitre..." },
        { "champ": "designation", "cle": "designation", "libelle": "description de l'article..." }
      ],
      "regles": {
        "clesChampsDevantEtreNonVides": ["designation"],
        "clesChampsSelectChoixDevantResterBrut": ["niveauListe", "tauxHoraire"]
      },
      "systemPrompt": "Voici des données JSON du détail de calcul d'un devis...",
      "promptsSuggeres": {
        "analyse": [
          "Je suis un prompt par défaut, fichier des prompts prédéfinis absent",
          "Exemple attendu: fais moi une liste du matériel à commander."
        ],
        "creation": [
          "Je suis un prompt par défaut, fichier des prompts prédéfinis absent",
          "Exemple attendu: génère un chapitre intitulé 'Chambre Parents' pour la fourniture et pose de 3 prises de courant, 2 points d'allumage va et vient, 1 luminaire et 1 départ climatisation"
        ]
      },
      "modele": [
        { "reference": "", "niveauListe": 1, "designation": "CHAPITRE EXEMPLE - Travaux de maçonnerie", "unite": "", "quantiteTotale": "", "prixAchatUnitaire": "", "remiseAchat": "", "heuresUnitaire": "", "tauxHoraire": 0, "sousTraitance": 0, "prixVenteForce": "", "margeForcee": "", "remiseClient": "", "commentaire": "" },
        { "reference": "MAC-001", "niveauListe": 2, "designation": "Fourniture et pose de parpaings creux 20x20x50", "unite": "m²", "quantiteTotale": 50, "prixAchatUnitaire": 12.5, "remiseAchat": "", "heuresUnitaire": 2.5, "tauxHoraire": 1, "sousTraitance": 0, "prixVenteForce": "", "margeForcee": "", "remiseClient": "", "commentaire": "" }
      ],
      "prompt": "Génère un chapitre intitulé 'Chambre Parents' pour la fourniture et pose de 3 prises de courant, 2 points d'allumage va et vient, 1 luminaire et 1 départ climatisation",
      "export": {
        "nomOnglet": "Devis IA",
        "colonnesExport": []
      },
      "copyToClipBoard": false,
      "exportExcel": true
    }
}
```

### Clés spécifiques de `workerConfig`

Le `workerConfig` peut contenir, en plus des colonnes et règles, les clés suivantes :

| Clé | Type | Description |
|---|---|---|
| `promptsSuggeres` | `object` | Objet avec trois sous-clés (`analyse`, `creation`, `synthese`) contenant chacune un tableau de prompts suggérés pour guider l'utilisateur dans ses demandes — la sous-clé `creation` est utilisée pour les exports Excel, `synthese` pour les autres cas |
| `prompt` | `string` | Prompt suggéré direct, utilisé comme exemple ou valeur par défaut dans l'interface |
| `modele` | `array` | Tableau de lignes d'exemple au format des colonnes définies, servant de référence de structure au LLM |

### Réponse immédiate du Worker
```json
{ "sessionId": "detailsDevis_onglet3_1719300000", "status": "accepted" }
```

XSpro reçoit cet accusé et n'attend plus rien. La réponse finale arrive sur `callbackUrl`.

---

## 3. Réponse finale — `POST {callbackUrl}`

Le Worker appelle `callbackUrl` quand la session se termine. **3 cas possibles.**

### Format commun
```json
{
  "sessionId":   "detailsDevis_onglet3_1719300000",
  "contextName": "detailsDevis",
  "status":      "done" | "cancelled" | "unknown",
  "rows":        [...],
  "message":     "texte lisible optionnel"
}
```

### Réponse attendue de XSpro
```json
{ "ok": true }
```

Si XSpro ne répond pas dans **5 secondes** → le Worker génère un export `.xlsx` directement.

---

### Cas 1 — `unknown` : Worker ne prend pas en charge

**Causes possibles :**
- `contextName` dans la liste noire de `worker-config.json`
- `contextName` absent de la liste blanche (si liste blanche non vide)
- `workerConfig.colonnes` manquant ou vide
- `workerConfig.copyToClipBoard === true` (fonctionnalité non supportée par ce Worker)
- `workerConfig.exportExcel === false` (requête standard sans export, le Worker ne produit qu'un export Excel)
- Payload structurellement invalide

```json
{
  "sessionId":   "...",
  "contextName": "listeEleves",
  "status":      "unknown",
  "rows":        [],
  "message":     "Contexte \"listeEleves\" non traité par ce Worker"
}
```

**XSpro doit :** traiter localement comme si le Worker n'existait pas.

---

### Flags de capacité `workerConfig`

Le Worker inspecte deux flags optionnels dans `workerConfig` pour valider sa capacité à traiter la requête :

| Flag | Valeur bloquante | Raison du refus | Message renvoyé |
|---|---|---|---|
| `copyToClipBoard` | `true` | Copie au presse-papier non supportée par ce Worker | `"copyToClipBoard demandé mais non supporté par ce Worker"` |
| `exportExcel` | `false` | Requête standard sans export — le Worker ne produit qu'un export Excel comme résultat | `"exportExcel=false — requête standard sans export non gérée par ce Worker"` |

Ces vérifications sont effectuées **après** la validation structurelle et **avant** le filtrage par liste blanche/noire.

> **Note** : En mode standalone (`callbackUrl: null`), ces flags sont ignorés car le Worker utilise toujours le fallback Excel.

---

### Surcharge locale via `MANIFEST` (hook vue)

Quand un hook vue (`views/<contextName>.js`) existe, il peut exposer un objet `MANIFEST` pour
surcharger certains champs de `workerConfig`. La fusion est faite dans `llmClient.js` avant
la construction du prompt.

Champs redéfinissables :

| Champ | `null` = |
|---|---|
| `colonnes` | Garder celles de XSpro |
| `regles` | Garder celles de XSpro |
| `systemPrompt` | Garder celui de XSpro |
| `promptsSuggeres` | Garder ceux de XSpro (`{}` = supprimer) |
| `prompt` | Garder celui de XSpro |
| `modele` | Garder celui de XSpro |
| `export` | Garder celui de XSpro |

`buildSystemPrompt` est générique : il sérialise `regles` en JSON (`== RÈGLES ==`)
sans connaître sa structure interne. Les règles ne sont plus parsées cas par cas.

---

### Cas 2 — `cancelled` : utilisateur a annulé

L'utilisateur a cliqué "Annuler" dans l'interface du Worker.

```json
{
  "sessionId":   "...",
  "contextName": "detailsDevis",
  "status":      "cancelled",
  "rows":        [],
  "message":     "Session annulée par l'utilisateur"
}
```

**XSpro doit :** fermer le dialogue en attente, ne rien modifier.

---

### Cas 3 — `done` : résultat disponible

L'utilisateur a validé le résultat dans l'interface du Worker.

```json
{
  "sessionId":   "...",
  "contextName": "detailsDevis",
  "status":      "done",
  "rows": [
    { "niveauListe": 1, "designation": "DISTRIBUTION GÉNÉRALE", ... },
    { "niveauListe": 2, "designation": "Câble U1000R2V 3G2.5", "prixAchatUnitaire": 3.40, ... }
  ],
  "message":     "13 ligne(s) traitée(s)"
}
```

**XSpro doit :** intégrer les rows dans la vue appelante, fermer le dialogue.

---

## 4. Endpoint `callbackUrl` côté XSpro

XSpro doit exposer un endpoint HTTP local pour recevoir les callbacks du Worker.

```js
// Exemple — ipcAI.js ou un module dédié
const express = require('express');
const app     = express();
app.use(express.json());

app.post('/worker-response', async (req, res) => {
  const { sessionId, contextName, status, rows, message } = req.body;

  res.json({ ok: true }); // répondre vite — le Worker a un timeout de 5s

  switch (status) {

    case 'done':
      // Intégrer les rows dans la vue appelante
      // ex: ipcMain.emit('WORKER:result', { contextName, rows });
      break;

    case 'cancelled':
      // Fermer le dialogue d'attente sans rien modifier
      // ex: ipcMain.emit('WORKER:cancelled', { contextName });
      break;

    case 'unknown':
      // Traitement local — comme si le Worker n'avait pas répondu
      // ex: ipcMain.emit('WORKER:fallback', { contextName });
      break;
  }
});

app.listen(3000); // port à définir dans parametresAi.json → callbackPort
```

---

## 5. `sessionId` — convention de nommage

Le `sessionId` doit être unique par appel. Convention recommandée :

```js
const sessionId = `${contextName}_${idOnglet}_${Date.now()}`;
// ex: "detailsDevis_onglet3_1719300000000"
```

XSpro utilise le `sessionId` pour retrouver quelle vue/onglet correspond à la réponse reçue — un seul endpoint `callbackUrl` peut gérer plusieurs sessions simultanées.

---

## 6. Configuration

### `ai-worker/worker-config.json`
```json
{
  "port": 8888,
  "contexts": {
    "listeBlanche": [],
    "listeNoire":   ["listeEleves", "listeClients"]
  }
}
```

| Combinaison | Résultat |
|---|---|
| `listeNoire` contient le contextName | Refusé (`unknown`) — priorité absolue |
| `listeBlanche` vide | Tout accepté |
| `listeBlanche` non vide + contextName dedans | Accepté |
| `listeBlanche` non vide + contextName absent | Refusé (`unknown`) |
| contextName dans les deux listes | `listeNoire` l'emporte → refusé |

### `worker-config.json` côté Worker — callbackUrl

Le Worker peut configurer un callback local par défaut, avec une option de priorité :

```json
{
  "port": 8888,
  "callbackUrl": "http://localhost:3000/worker-response",
  "callbackUrlPriority": false,
  "contexts": { ... }
}
```

| Champ | Type | Description |
|---|---|---|
| `callbackUrl` | `string` | URL de callback vers XSpro, utilisée si XSpro n'en fournit pas |
| `callbackUrlPriority` | `boolean` | Si `true`, le callbackUrl local **prime** sur celui envoyé par XSpro |

**Règles de résolution :**
- `callbackUrlPriority: true` → Worker impose son `callbackUrl` local
- `callbackUrlPriority: false` (défaut) → `callbackUrl` de XSpro prime, fallback sur local si absent
- Aucun des deux → fallback Excel automatique

### `autoOpenUI` — contrôle de l'ouverture du navigateur

| Valeur | Comportement |
|---|---|
| `true` (défaut) | Le Worker ouvre automatiquement le navigateur à chaque `POST /process` |
| `false` | Le Worker reste silencieux. XSpro appelle `GET /open-ui?sessionId=xxx` pour ouvrir l'UI manuellement |

**Endpoint d'ouverture à la demande :**
```
GET http://localhost:8888/open-ui?sessionId=detailsDevis_1719300000000
```
Réponse :
```json
{ "opened": true, "url": "http://localhost:8888/index.html?sessionId=..." }
```

Le Worker referme automatiquement l'UI quand l'utilisateur valide (`session:validate`) ou annule (`session:cancel`).

### `parametresAi.json` côté XSpro
Ajouter :
```json
{
  "promptGeneratorUrl": "http://localhost:8888",
  "workerCallbackPort": 3000
}
```

---

## 7. Séquence complète

```
XSpro                          Worker
  │                               │
  ├─ GET http://localhost:8888/   │  (démarrage silencieux si autoOpenUI=false)
  │◄─ 200 OK ─────────────────────┤  probe disponibilité
  │                               │
  ├─ POST /process ──────────────►│
  │◄─ { sessionId, "accepted" } ──┤  accusé immédiat
  │                               │
  │   (autoOpenUI=false : rien ne s'ouvre)
  │                        [XSpro peut appeler GET /open-ui pour ouvrir manuellement]
  │                        [utilisateur travaille...]
  │                               │
  │          ┌── done ────────────┤
  │          ├── cancelled ───────┤  POST callbackUrl
  │          └── unknown ─────────┤
  │◄─────────────────────────────►│
  ├─ { ok: true } ───────────────►│
  │                               │
[XSpro traite selon status]       │
```

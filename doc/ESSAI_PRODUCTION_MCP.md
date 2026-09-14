# Essai de production du canal MCP — marche à suivre

À faire une fois, sur un vrai devis, dans XSpro. Ce document est une recette : il se suit
d'un bout à l'autre sans rien connaître du code.

## Pourquoi cet essai

Tout le reste est déjà éprouvé. Le canal, les outils, les garde-fous, les consignes données
à Claude, la négociation avec XSpro : 61 vérifications automatiques passent
(`npm run test:mcp:e2e`), et une décomposition complète a été faite en simulation — 30 lignes,
hiérarchie juste, aucun prix posé là où il ne faut pas.

**Une seule chose n'a jamais été testée de bout en bout : que les lignes reviennent bien dans
XSpro** quand l'utilisateur clique sur « Valider et exporter ». Tous les essais s'arrêtaient
volontairement avant la livraison, pour ne rien envoyer par accident.

C'est cela qu'on va vérifier, plus le passage par XSpro lui-même : le bouton, le formulaire,
l'ouverture de la grille.

## Ce qu'il faut sous la main

- Un devis d'essai dans XSpro — pas un devis client.
- Un vrai CCTP, ou un descriptif de travaux, sous forme de fichier.
- Le Worker qui tourne. Pour savoir sur quel code : s'il a été lancé depuis les sources, c'est
  le code à jour ; pour éprouver la version livrée à XSpro, faire d'abord
  `npm run build:for-xspro`, puis tuer le `serveurIA.exe` resté en mémoire.

## D'abord : brancher Claude (une fois par poste)

Sans ce geste, rien de ce qui suit ne peut marcher — et c'est silencieux : la grille propose un
numéro de session, Claude reçoit le numéro, et ne dispose d'aucun outil pour en faire quoi que
ce soit. Le premier essai de production s'est arrêté exactement là.

Dans la grille, panneau **🔌 Remplissage par Claude** : si la ligne du haut est ambre, cliquer
**Connecter Claude**. Elle passe au vert, et c'est fini (cf. [`CANAL_MCP.md`](./CANAL_MCP.md),
« Le bouton Connecter Claude »).

**Puis ouvrir une fenêtre Claude NEUVE** : sa configuration est lue à l'ouverture. Celle qui est
déjà ouverte ne verra rien, même après un branchement réussi.

Pour vérifier : dans cette fenêtre neuve, demander les sessions du Worker. Les sept outils
`worker_*` doivent être là. La façade et le Worker sont deux processus indépendants —
brancher, rebrancher ou relancer la façade ne touche à aucune session ouverte.

Si l'écriture échoue (poste verrouillé, droits insuffisants), le panneau affiche la commande
équivalente, à taper une fois. La portée `user` est celle de l'utilisateur réel : il n'ouvre
pas un dépôt, il ouvre Claude. C'est aussi ce qui rend l'essai honnête — une session Claude
**sans dossier**, sans `.mcp.json` à approuver, rien d'autre que l'application installée.

## La marche à suivre

1. **Éteindre les deux clés IA de XSpro** (dans ses réglages IA : `config_or.START` et
   `config_hf.START` à `false`). C'est ce qui dit à XSpro de se tourner vers Claude plutôt que
   vers une IA payante.
2. Ouvrir XSpro, ouvrir le devis d'essai.
3. **Le bouton IA doit apparaître** sur le devis — et pas sur les listes ni les annuaires.
   S'il manque, s'arrêter là : c'est le premier point à comprendre.
4. Cliquer. **Le formulaire doit s'ouvrir directement**, verrouillé sur « Assistant externe ».
5. Envoyer. **Une grille s'ouvre dans le navigateur.** Le sélecteur « Remplissage » en haut à
   droite doit afficher « Claude (MCP) », et l'option « Clé API » doit être grisée.
6. Revenir dans Claude Code, **coller le texte ci-dessous et joindre le CCTP**. Le fichier se
   donne à Claude directement : en mode MCP la grille n'a pas de zone de pièce jointe.
7. Regarder la grille se remplir pendant que Claude travaille.
8. **Relire.** Les lignes proposées sont en couleur : vert pour un ajout, ambre pour une
   modification, rouge pour une suppression. Accepter ou refuser, ligne par ligne ou en bloc.
9. Quand il ne reste plus rien en attente, **« Valider et exporter »** réapparaît. Cliquer.
10. **Vérifier dans XSpro** que les lignes sont bien arrivées : le nombre, l'ordre, les niveaux
    hiérarchiques, les quantités.

## Le texte à coller à l'étape 6

```
On fait l'essai de production du canal MCP. Je viens d'envoyer une demande
depuis XSpro sur un devis, la grille est ouverte. Voici le CCTP.

Regarde les sessions en cours, prends la nouvelle, lis tout ce qu'elle te
donne, et dis-moi d'abord ce que tu as compris du travail demande — avant
d'ecrire quoi que ce soit.

Ensuite decompose le CCTP en chapitres et postes, puis termine avec un
resume de ce que tu as fait et de ce que je dois verifier.

Si quelque chose cloche dans ce que XSpro t'envoie, signale-le au journal
sans t'arreter pour autant.
```

## Ce qui compterait comme un échec

- Le bouton IA absent du devis, ou présent sur une vue qui ne devrait pas l'avoir.
- La grille qui s'ouvre en mode « Clé API » au lieu de « Claude (MCP) ».
- Claude qui n'arrive pas à comprendre le travail demandé sans explication supplémentaire :
  cela voudrait dire que les consignes de la vue sont encore trop courtes.
- Des niveaux hiérarchiques faux, des prix posés en mode Décomposition, des références
  inventées.
- **Des lignes qui n'arrivent pas dans XSpro, ou qui y arrivent déformées** — c'est le point
  central de l'essai.

## Après l'essai

Lire le journal d'anomalies, s'il a été alimenté : `logs/anomalies-AAAA-MM-JJ.jsonl` dans le
dossier de données du Worker. Claude y consigne ce qui cloche du côté des données envoyées par
XSpro, sans en parler à l'utilisateur (cf. [`CANAL_MCP.md`](./CANAL_MCP.md), phase bêta).

Un point déjà relevé et qui attend d'être traité côté XSpro : **les colonnes numériques
arrivent déclarées `type: "string"`** dans le payload réel, alors qu'elles contiennent des
nombres. Sans conséquence visible pour l'instant — la saisie manuelle et le canal MCP se
comportent pareil — mais une valeur écrite peut se retrouver en texte à côté de voisines
numériques.

Ne pas oublier de **rallumer les clés IA de XSpro** si on veut retrouver le chemin habituel.

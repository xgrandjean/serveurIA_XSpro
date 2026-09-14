#!/usr/bin/env node
/**
 * AI Worker — tools/mcp-worker/server.js
 *
 * Point d'entrée MCP du dépôt : il ne fait que démarrer la façade. Celle-ci vit
 * à la racine (mcpStdio.js), seul endroit d'où `pkg` l'embarque dans
 * serveurIA.exe — c'est-à-dire d'où elle existe chez l'utilisateur, qui n'a ni
 * le dépôt ni Node. Là-bas, le même code se lance par `serveurIA.exe --mcp`.
 *
 * Usage : déclaré dans .mcp.json à la racine du dépôt.
 */

'use strict';

require('../../mcpStdio').demarrer();

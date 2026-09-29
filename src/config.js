'use strict';

/**
 * Centralised configuration. The Figma token is read from the environment so it
 * never lives in source control. Set it in a local .env (git-ignored) or export
 * it in your shell:  export FIGMA_API_KEY=figd_xxx
 */

// Minimal .env loader (no dependency). Reads KEY=VALUE lines from ./.env if present.
const fs = require('fs');
const path = require('path');

function parseEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return false;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
  return true;
}

/**
 * Look for .env in the project root (one level up from src/) AND in the current
 * working directory. The project-root lookup matters when an MCP host (Cowork,
 * Claude Desktop, Cursor) spawns the server from a different cwd.
 */
function loadDotEnv() {
  const candidates = [
    path.join(__dirname, '..', '.env'), // project root, regardless of cwd
    path.join(process.cwd(), '.env'),
  ];
  for (const p of candidates) parseEnvFile(p);
}

loadDotEnv();

const FIGMA_API_KEY = process.env.FIGMA_API_KEY || '';

function requireApiKey() {
  if (!FIGMA_API_KEY) {
    throw new Error(
      'FIGMA_API_KEY is not set. Create a .env file with FIGMA_API_KEY=figd_... ' +
      'or export it in your shell. Never commit the key to source.'
    );
  }
  return FIGMA_API_KEY;
}

module.exports = {
  FIGMA_API_KEY,
  requireApiKey,
  // Default fetch depths — overridable per call.
  FETCH: {
    fileDepth: Number(process.env.FIGMA_FILE_DEPTH || 4),
    nodeDepth: Number(process.env.FIGMA_NODE_DEPTH || 12),
  },
};

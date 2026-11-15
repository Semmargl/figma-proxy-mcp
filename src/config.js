'use strict';

/**
 * Centralised configuration. The Figma token is read from the environment so it
 * never lives in source control. Set it in a local .env (git-ignored) or export
 * it in your shell:  export FIGMA_API_KEY=<your token>
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
 * Resolution order (first value wins, later sources never override):
 *   1. real environment variables (e.g. the MCP client's `env` block)
 *   2. .env in the current working directory
 *   3. .env next to the package (useful for a git clone; under npx this is the
 *      npm cache and normally has no .env)
 * Values are only ever read into process.env; they are never logged.
 */
function loadDotEnv() {
  const candidates = [
    path.join(process.cwd(), '.env'),
    path.join(__dirname, '..', '.env'),
  ];
  const seen = new Set();
  for (const p of candidates) {
    const abs = path.resolve(p);
    if (seen.has(abs)) continue;
    seen.add(abs);
    try { parseEnvFile(abs); } catch (_) { /* unreadable .env: ignore */ }
  }
}

loadDotEnv();

const os = require('os');

const FIGMA_API_KEY = (process.env.FIGMA_API_KEY || '').trim();

/**
 * Where the server may write. Everything defaults to the OS temp dir so that
 * nothing lands in the npx cache or an unexpected working directory.
 *   FIGMA_PROXY_CACHE_DIR  base dir (default: <os.tmpdir()>/figma-proxy-mcp)
 *   FIGMA_PROXY_DATA_DIR   component registry (default: <cache>/data)
 *   FIGMA_PROXY_VERIFY_DIR verify_render diff images (default: <cache>/verify-out)
 *   FIGMA_PROXY_SVG_DIR    export_svg / migrate_all_svgs default outputDir
 *                          (default: ./exported-svgs, relative to the cwd)
 */
const CACHE_DIR = process.env.FIGMA_PROXY_CACHE_DIR || path.join(os.tmpdir(), 'figma-proxy-mcp');
const PATHS = {
  cacheDir: CACHE_DIR,
  dataDir: process.env.FIGMA_PROXY_DATA_DIR || path.join(CACHE_DIR, 'data'),
  verifyDir: process.env.FIGMA_PROXY_VERIFY_DIR || path.join(CACHE_DIR, 'verify-out'),
  svgDir: process.env.FIGMA_PROXY_SVG_DIR || './exported-svgs',
};

/** Remove any occurrence of the token from a string before it is shown or logged. */
function redact(text) {
  const s = String(text == null ? '' : text);
  if (!FIGMA_API_KEY || FIGMA_API_KEY.length < 8) return s;
  return s.split(FIGMA_API_KEY).join('[REDACTED]');
}

function requireApiKey() {
  if (!FIGMA_API_KEY) {
    throw new Error(
      'FIGMA_API_KEY is not set. Pass it via the MCP client env block, export it in your shell, ' +
      'or put FIGMA_API_KEY=<token> in a .env file in the working directory. ' +
      'Run `npx figma-proxy-mcp --check` to diagnose.'
    );
  }
  return FIGMA_API_KEY;
}

module.exports = {
  FIGMA_API_KEY,
  requireApiKey,
  redact,
  PATHS,
  // Default fetch depths — overridable per call.
  FETCH: {
    fileDepth: Number(process.env.FIGMA_FILE_DEPTH || 4),
    nodeDepth: Number(process.env.FIGMA_NODE_DEPTH || 12),
  },
};

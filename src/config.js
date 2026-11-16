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
    if (!process.env[key]) process.env[key] = val; // empty env var counts as unset
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

/**
 * Hosted mode (FIGMA_PROXY_HOSTED=1): the server runs as a shared/remote service
 * (e.g. an Apify Standby Actor). Then:
 *   - .env files and the global FIGMA_API_KEY are ignored; every request must
 *     carry the caller's own token (see runWithToken / tokenFromHttpRequest);
 *   - nothing is read from or written outside the OS temp dir (htmlPath,
 *     figmaPngPath, outDir, outputDir, save are rejected or ignored);
 *   - SVGs and diff images are returned inline in the response.
 */
const HOSTED = process.env.FIGMA_PROXY_HOSTED === '1';

// FIGMA_PROXY_NO_DOTENV=1 disables .env loading entirely (env vars only).
if (!HOSTED && process.env.FIGMA_PROXY_NO_DOTENV !== '1') loadDotEnv();

const os = require('os');
const { AsyncLocalStorage } = require('async_hooks');

const FIGMA_API_KEY = HOSTED ? '' : (process.env.FIGMA_API_KEY || '').trim();

// Per-request token (hosted mode / HTTP header). Held only in memory for the
// duration of the request; never logged, never written to disk.
const tokenStore = new AsyncLocalStorage();

/** Run fn with a per-request Figma token. A falsy token runs fn without one. */
function runWithToken(token, fn) {
  const t = typeof token === 'string' ? token.trim() : '';
  return tokenStore.run(t ? { token: t } : {}, fn);
}

function currentRequestToken() {
  const s = tokenStore.getStore();
  return (s && s.token) || '';
}

/**
 * Extract a caller-supplied token from an HTTP request (Express-like object):
 * header `x-figma-token` (preferred) or query parameter `figmaToken`.
 * The Authorization header is deliberately NOT used: gateways such as Apify
 * consume it for their own authentication.
 */
function tokenFromHttpRequest(req) {
  const h = req && req.headers && req.headers['x-figma-token'];
  if (typeof h === 'string' && h.trim()) return h.trim();
  const q = req && req.query && req.query.figmaToken;
  if (typeof q === 'string' && q.trim()) return q.trim();
  return '';
}

/**
 * Where the server may write. Everything defaults to the OS temp dir so that
 * nothing lands in the npx cache or an unexpected working directory.
 *   FIGMA_PROXY_CACHE_DIR  base dir (default: <os.tmpdir()>/figma-proxy-mcp)
 *   FIGMA_PROXY_DATA_DIR   component registry (default: <cache>/data)
 *   FIGMA_PROXY_VERIFY_DIR verify_render diff images (default: <cache>/verify-out)
 *   FIGMA_PROXY_SVG_DIR    export_svg / migrate_all_svgs default outputDir
 *                          (default: ./exported-svgs, relative to the cwd)
 */
// In hosted mode every path is forced under the OS temp dir.
const CACHE_DIR = HOSTED
  ? path.join(os.tmpdir(), 'figma-proxy-mcp')
  : (process.env.FIGMA_PROXY_CACHE_DIR || path.join(os.tmpdir(), 'figma-proxy-mcp'));
const PATHS = HOSTED ? {
  cacheDir: CACHE_DIR,
  dataDir: path.join(CACHE_DIR, 'data'),
  verifyDir: path.join(CACHE_DIR, 'verify-out'),
  svgDir: path.join(CACHE_DIR, 'svg'),
} : {
  cacheDir: CACHE_DIR,
  dataDir: process.env.FIGMA_PROXY_DATA_DIR || path.join(CACHE_DIR, 'data'),
  verifyDir: process.env.FIGMA_PROXY_VERIFY_DIR || path.join(CACHE_DIR, 'verify-out'),
  svgDir: process.env.FIGMA_PROXY_SVG_DIR || './exported-svgs',
};

/** Remove any occurrence of a token (global or per-request) from a string before it is shown or logged. */
function redact(text) {
  let s = String(text == null ? '' : text);
  for (const t of [FIGMA_API_KEY, currentRequestToken()]) {
    if (t && t.length >= 8) s = s.split(t).join('[REDACTED]');
  }
  return s;
}

function requireApiKey() {
  const perRequest = currentRequestToken();
  if (perRequest) return perRequest;
  if (HOSTED) {
    throw new Error(
      'No Figma token in this request. Send your Figma personal access token in the ' +
      '`x-figma-token` HTTP header (or the `figmaToken` query parameter) when connecting to this server.'
    );
  }
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
  HOSTED,
  requireApiKey,
  runWithToken,
  tokenFromHttpRequest,
  redact,
  PATHS,
  // Default fetch depths — overridable per call.
  FETCH: {
    fileDepth: Number(process.env.FIGMA_FILE_DEPTH || 4),
    nodeDepth: Number(process.env.FIGMA_NODE_DEPTH || 12),
  },
};

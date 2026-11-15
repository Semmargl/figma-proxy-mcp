#!/usr/bin/env node
'use strict';

/**
 * figma-proxy-mcp setup doctor.
 *
 *   npx figma-proxy-mcp --check        (or: npx -p figma-proxy-mcp figma-proxy-mcp-doctor)
 *
 * Checks: Node version, FIGMA_API_KEY presence (the value is never printed),
 * token validity via GET https://api.figma.com/v1/me (only the HTTP status is
 * reported, no account data), and Playwright Chromium for verify_render.
 * Exit code 0 = required checks passed, 1 = something required failed.
 */

const fs = require('fs');

const MIN_NODE_MAJOR = 20;

function line(status, label, detail) {
  const tag = { ok: '[ OK ]', fail: '[FAIL]', warn: '[WARN]' }[status];
  process.stdout.write(`${tag} ${label}${detail ? ' - ' + detail : ''}\n`);
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= MIN_NODE_MAJOR) {
    line('ok', 'Node.js', `v${process.versions.node}`);
    return true;
  }
  line('fail', 'Node.js', `v${process.versions.node} found, ${MIN_NODE_MAJOR}+ required (https://nodejs.org)`);
  return false;
}

function checkKeyPresent(key) {
  if (key) {
    line('ok', 'FIGMA_API_KEY', `set (${key.length} chars, value hidden)`);
    return true;
  }
  line('fail', 'FIGMA_API_KEY', 'not set. Add it to the MCP client env block, export it in your shell, or put FIGMA_API_KEY=<token> in .env in the working directory');
  return false;
}

async function checkFigmaApi(key) {
  if (!key) {
    line('warn', 'Figma API', 'skipped (no token)');
    return false;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch('https://api.figma.com/v1/me', {
      headers: { 'X-Figma-Token': key },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    // Discard the body: it contains account details we do not need to show.
    await res.arrayBuffer().catch(() => null);
    if (res.ok) {
      line('ok', 'Figma API', `token accepted (HTTP ${res.status})`);
      return true;
    }
    if (res.status === 403 || res.status === 401) {
      line('fail', 'Figma API', `HTTP ${res.status}: token invalid, expired or revoked. Generate a new one (Figma > Settings > Security > Personal access tokens)`);
    } else {
      line('fail', 'Figma API', `HTTP ${res.status} from api.figma.com`);
    }
    return false;
  } catch (e) {
    const reason = e && e.name === 'AbortError' ? 'timeout' : (e && e.cause && e.cause.code) || (e && e.message) || 'network error';
    line('fail', 'Figma API', `cannot reach api.figma.com (${reason}). Check network / proxy settings`);
    return false;
  }
}

function checkChromium() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    line('warn', 'Playwright', 'package not installed; verify_render will not work (npm install playwright)');
    return;
  }
  try {
    const exe = chromium.executablePath();
    if (exe && fs.existsSync(exe)) {
      line('ok', 'Chromium (verify_render)', 'installed');
    } else {
      line('warn', 'Chromium (verify_render)', 'not installed. Run once: npx playwright install chromium (other tools work without it)');
    }
  } catch (e) {
    line('warn', 'Chromium (verify_render)', 'not installed. Run once: npx playwright install chromium (other tools work without it)');
  }
}

async function main() {
  let pkgVersion = '';
  try { pkgVersion = require('../package.json').version; } catch (_) { /* ignore */ }
  process.stdout.write(`figma-proxy-mcp ${pkgVersion} setup check\n`);

  const nodeOk = checkNode();
  // Loads env vars first, then .env from the cwd, then .env next to the package.
  const { FIGMA_API_KEY } = require('../src/config');
  const keyOk = checkKeyPresent(FIGMA_API_KEY);
  const apiOk = await checkFigmaApi(FIGMA_API_KEY);
  checkChromium();

  const ok = nodeOk && keyOk && apiOk;
  process.stdout.write(ok ? '\nAll required checks passed.\n' : '\nSetup incomplete: fix the [FAIL] items above.\n');
  return ok ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => {
    process.stdout.write(`[FAIL] unexpected error - ${e && e.message}\n`);
    process.exit(1);
  });
}

module.exports = { main };

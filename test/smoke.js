#!/usr/bin/env node
'use strict';

/**
 * Offline smoke test (no Figma token needed):
 *  1. stdio: initialize (+ instructions), notification gets no reply, ping, tools/list,
 *     tools/call without a token returns a clear error without leaking anything.
 *  2. --check exits 1 gracefully without a token.
 *  3. HTTP mode starts on loopback and answers tools/list.
 *  4. compareBuffers works on two tiny generated PNGs (no Chromium needed).
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'proxy-mcp.js');
// Run from an empty temp dir with the token stripped and .env loading disabled,
// so a developer's real token is never picked up or sent anywhere by the tests.
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'fpm-smoke-'));
const ENV = { ...process.env, FIGMA_API_KEY: '', FIGMA_PROXY_NO_DOTENV: '1', FIGMA_PROXY_CACHE_DIR: path.join(CWD, 'cache') };

let failures = 0;
function ok(name) { process.stdout.write(`ok   - ${name}\n`); }
function fail(name, e) { failures++; process.stdout.write(`FAIL - ${name}: ${e && e.message}\n`); }
async function step(name, fn) { try { await fn(); ok(name); } catch (e) { fail(name, e); } }

function stdioSession(messages, expectCount, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, '--stdio'], { cwd: CWD, env: ENV });
    const responses = [];
    let buf = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timeout; got ${responses.length} responses; stderr: ${stderr}`)); }, timeoutMs);
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const lineStr = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!lineStr) continue;
        responses.push(JSON.parse(lineStr));
        if (responses.length >= expectCount) {
          clearTimeout(timer);
          // give a moment for any unexpected extra output
          setTimeout(() => { child.kill(); resolve({ responses, stderr }); }, 300);
        }
      }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    // Send everything in one write to exercise multi-message chunks, and split
    // the last message across two writes to exercise buffering.
    const payload = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
    const cut = payload.length - 10;
    child.stdin.write(payload.slice(0, cut));
    setTimeout(() => child.stdin.write(payload.slice(cut)), 100);
  });
}

async function main() {
  let toolsList;

  await step('stdio: initialize, notification, ping, tools/list, tools/call', async () => {
    const { responses } = await stdioSession([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_figma_component', arguments: { figmaUrl: 'https://www.figma.com/design/AbCdEfGhIjKlMnOp/Example?node-id=1-2', summary: true } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_figma_file', arguments: { fileId: '../../v1/me' } } },
    ], 5);
    const byId = Object.fromEntries(responses.map((r) => [r.id, r]));
    assert.strictEqual(responses.length, 5, 'notifications must not be answered');
    const init = byId[1].result;
    assert.strictEqual(init.serverInfo.name, 'figma-proxy-mcp');
    assert.strictEqual(init.serverInfo.version, require('../package.json').version);
    assert.strictEqual(init.protocolVersion, '2025-06-18');
    assert.ok(/node-id/.test(init.instructions) && /verify_render/.test(init.instructions), 'instructions present');
    assert.deepStrictEqual(byId[2].result, {});
    toolsList = byId[3].result.tools;
    assert.ok(Array.isArray(toolsList) && toolsList.length === 9, `9 tools, got ${toolsList && toolsList.length}`);
    const t4 = byId[4].result.content[0].text;
    assert.ok(/FIGMA_API_KEY is not set/.test(t4), 'clear missing-token error');
    const t5 = byId[5].result.content[0].text;
    assert.ok(/Invalid Figma file key/.test(t5), 'file key validated');
  });

  await step('--check without token exits 1 with clear output', async () => {
    const r = spawnSync(process.execPath, [SERVER, '--check'], { cwd: CWD, env: ENV, encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(r.status, 1, `exit code ${r.status}`);
    assert.ok(/\[FAIL\] FIGMA_API_KEY/.test(r.stdout), r.stdout);
    assert.ok(/\[ OK \] Node\.js/.test(r.stdout), r.stdout);
  });

  await step('--check never prints the token', async () => {
    const fake = 'figd_SMOKE_TEST_NOT_A_REAL_TOKEN_123456';
    const r = spawnSync(process.execPath, [SERVER, '--check'], { cwd: CWD, env: { ...ENV, FIGMA_API_KEY: fake }, encoding: 'utf8', timeout: 30000 });
    assert.ok(!(r.stdout + r.stderr).includes(fake), 'token leaked');
    assert.strictEqual(r.status, 1, 'fake token must fail');
  });

  await step('HTTP mode answers tools/list on 127.0.0.1', async () => {
    const port = 40000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, [SERVER], { cwd: CWD, env: { ...ENV, FIGMA_PROXY_PORT: String(port) } });
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('HTTP server did not start')), 10000);
        child.stdout.on('data', (d) => { if (/HTTP endpoint/.test(String(d))) { clearTimeout(t); resolve(); } });
        child.on('exit', (c) => reject(new Error(`exited ${c}`)));
      });
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      const json = await res.json();
      assert.strictEqual(json.result.tools.length, 9);
      const init = await (await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }),
      })).json();
      assert.ok(init.result.instructions, 'instructions over HTTP');
      const note = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      assert.strictEqual(note.status, 204);
    } finally {
      child.kill();
    }
  });

  await step('compareBuffers diff on generated PNGs', async () => {
    const { PNG } = require('pngjs');
    const mk = (fill) => {
      const p = new PNG({ width: 40, height: 40 });
      for (let i = 0; i < p.data.length; i += 4) { p.data[i] = fill; p.data[i + 1] = fill; p.data[i + 2] = fill; p.data[i + 3] = 255; }
      return p;
    };
    const a = mk(255);
    const b = mk(255);
    for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) { const i = (y * 40 + x) * 4; b.data[i] = 0; b.data[i + 1] = 0; b.data[i + 2] = 0; }
    const { compareBuffers } = require('../src/visual/verify');
    const outDir = path.join(CWD, 'verify');
    const r = compareBuffers(PNG.sync.write(a), PNG.sync.write(b), { scale: 1, outDir, label: 'smoke' });
    assert.ok(r.diffPixels > 0 && r.diffRegions.length >= 1, 'diff detected');
    assert.ok(r.diffImagePath && fs.existsSync(r.diffImagePath), 'diff image written to outDir');
  });

  await step('verify_render tool via stdio (full render if a browser is available)', async () => {
    const { PNG } = require('pngjs');
    const W = 200, H = 100;
    const ref = new PNG({ width: W, height: H });
    for (let i = 0; i < ref.data.length; i += 4) { ref.data[i] = 255; ref.data[i + 1] = 255; ref.data[i + 2] = 255; ref.data[i + 3] = 255; }
    const htmlPath = path.join(CWD, 'page.html');
    fs.writeFileSync(htmlPath, '<!doctype html><html><body style="margin:0;background:#fff"><div style="width:200px;height:100px"></div></body></html>');
    const { responses } = await stdioSession([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verify_render', arguments: { htmlPath, frameWidth: W, scale: 1, figmaPngBase64: PNG.sync.write(ref).toString('base64') } } },
    ], 1, 60000);
    const r = responses[0].result;
    const text = r.content[0].text;
    let browser = false;
    try { const { chromium } = require('playwright'); browser = fs.existsSync(chromium.executablePath()); } catch (_) { /* none */ }
    if (process.env.FIGMA_PROXY_CHROME_PATH) browser = fs.existsSync(process.env.FIGMA_PROXY_CHROME_PATH);
    if (browser) {
      assert.ok(r.structuredContent && typeof r.structuredContent.ssim === 'number', text);
      assert.ok(r.structuredContent.pass, `blank page vs blank reference should pass: ${text}`);
      process.stdout.write(`     (rendered: SSIM ${r.structuredContent.ssim}, diff ${r.structuredContent.pixelDiffPct}%)\n`);
    } else {
      assert.ok(/playwright install chromium/.test(text), `friendly error expected: ${text}`);
      process.stdout.write('     (no Chromium available: checked the install hint instead)\n');
    }
  });

  if (toolsList && process.argv.includes('--print-tools')) {
    process.stdout.write(JSON.stringify(toolsList, null, 2) + '\n');
  }

  fs.rmSync(CWD, { recursive: true, force: true });
  process.stdout.write(failures ? `\n${failures} test(s) failed\n` : '\nall smoke tests passed\n');
  process.exit(failures ? 1 : 0);
}

main();

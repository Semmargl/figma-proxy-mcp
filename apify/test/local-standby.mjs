/**
 * Local end-to-end test of the Standby Actor without an Apify account.
 *
 * Starts src/main.js as Apify would in Standby mode (APIFY_META_ORIGIN=STANDBY,
 * ACTOR_WEB_SERVER_PORT), with local pay-per-event simulation
 * (ACTOR_TEST_PAY_PER_EVENT + ACTOR_USE_CHARGING_LOG_DATASET), then talks MCP
 * Streamable HTTP to it with the official SDK client:
 *   readiness probe, initialize, tools/list, verify_render with inline html
 *   (reference PNG rendered from the same HTML with Playwright, so no Figma
 *   token is needed), a deliberately different page, the hosted file:// guard,
 *   a failing Figma call (must not be charged), a rejected htmlPath call, and
 *   finally the local charging log.
 *
 * Usage: node test/local-standby.mjs   (set FIGMA_PROXY_CHROME_PATH if Playwright's
 * own Chromium is not installed)
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'fpm-actor-test-'));
const PORT = 41000 + Math.floor(Math.random() * 10000);
const FAKE_FIGMA_TOKEN = 'fake-local-test-token-not-real-0123456789';

let failures = 0;
async function step(name, fn) {
    try {
        await fn();
        console.log(`ok   - ${name}`);
    } catch (e) {
        failures++;
        console.log(`FAIL - ${name}: ${e?.stack || e}`);
    }
}

async function renderReference(html, width, scale) {
    const { chromium } = require('playwright');
    const executablePath = process.env.FIGMA_PROXY_CHROME_PATH || undefined;
    const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    try {
        const page = await (await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: scale })).newPage();
        await page.setContent(html, { waitUntil: 'networkidle' });
        return (await page.screenshot({ fullPage: true, type: 'png' })).toString('base64');
    } finally {
        await browser.close();
    }
}

const child = spawn(process.execPath, ['src/main.js'], {
    cwd: ROOT,
    env: {
        ...process.env,
        APIFY_META_ORIGIN: 'STANDBY',
        ACTOR_WEB_SERVER_PORT: String(PORT),
        ACTOR_TEST_PAY_PER_EVENT: 'true',
        ACTOR_USE_CHARGING_LOG_DATASET: 'true',
        CRAWLEE_STORAGE_DIR: path.join(WORK, 'storage'),
        APIFY_LOCAL_STORAGE_DIR: path.join(WORK, 'storage'),
        FIGMA_API_KEY: 'fake-env-token-must-be-ignored-0123456789',
    },
});
let logs = '';
child.stdout.on('data', (d) => { logs += d; });
child.stderr.on('data', (d) => { logs += d; });

try {
    await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`server did not start:\n${logs}`)), 30000);
        const iv = setInterval(() => {
            if (/listening on port/.test(logs)) { clearTimeout(t); clearInterval(iv); resolve(); }
        }, 100);
        child.on('exit', (c) => { clearTimeout(t); clearInterval(iv); reject(new Error(`exited ${c}:\n${logs}`)); });
    });

    const base = `http://127.0.0.1:${PORT}`;

    await step('readiness probe', async () => {
        const r = await fetch(`${base}/`, { headers: { 'x-apify-container-server-readiness-probe': '1' } });
        assert.strictEqual(r.status, 200);
        assert.strictEqual((await r.text()).trim(), 'ok');
    });

    const client = new Client({ name: 'local-test', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { 'x-figma-token': FAKE_FIGMA_TOKEN } },
    });

    await step('initialize over Streamable HTTP', async () => {
        await client.connect(transport);
        const info = client.getServerVersion();
        assert.strictEqual(info.name, 'figma-proxy-mcp');
        assert.strictEqual(info.version, require('figma-proxy-mcp/package.json').version);
        assert.ok(/hosted server/.test(client.getInstructions() || ''), 'hosted instructions');
        assert.ok(transport.sessionId, 'session id assigned');
    });

    await step('tools/list (hosted schema)', async () => {
        const { tools } = await client.listTools();
        assert.strictEqual(tools.length, 9);
        const vr = tools.find((t) => t.name === 'verify_render');
        assert.ok(vr.inputSchema.properties.html && !vr.inputSchema.properties.htmlPath);
    });

    const W = 320;
    const SCALE = 2;
    const html = `<!doctype html><html><head><style>body{margin:0;font-family:sans-serif;background:#f4f6fb}
.card{position:absolute;left:24px;top:24px;width:272px;height:120px;border-radius:12px;background:#1f6feb;color:#fff;padding:16px;box-sizing:border-box}
</style></head><body><div style="height:180px"></div><div class="card"><b>Hello</b><p>Figma to code</p></div></body></html>`;
    let refB64;

    await step('verify_render: inline html vs identical reference -> PASS', async () => {
        refB64 = await renderReference(html, W, SCALE);
        const r = await client.callTool({ name: 'verify_render', arguments: { html, frameWidth: W, scale: SCALE, figmaPngBase64: refB64 } });
        assert.ok(!r.isError, r.content?.[0]?.text);
        assert.ok(r.structuredContent.pass, `expected pass: ssim ${r.structuredContent.ssim}`);
        const img = r.content.find((c) => c.type === 'image');
        assert.ok(img && img.mimeType === 'image/png', 'diff image returned inline (hosted default)');
        console.log(`     SSIM ${r.structuredContent.ssim}, diff ${r.structuredContent.pixelDiffPct}%, diff image ${Math.round(img.data.length / 1024)} KB b64`);
    });

    await step('verify_render: changed html -> diff regions + diff image', async () => {
        const changed = html.replace('#1f6feb', '#d73a49').replace('left:24px', 'left:40px');
        const r = await client.callTool({ name: 'verify_render', arguments: { html: changed, frameWidth: W, scale: SCALE, figmaPngBase64: refB64, threshold: 0.99 } });
        assert.ok(!r.isError, r.content?.[0]?.text);
        const sc = r.structuredContent;
        assert.ok(!sc.pass && sc.diffPixels > 0 && sc.diffRegions.length > 0, JSON.stringify({ ssim: sc.ssim, diff: sc.pixelDiffPct }));
        fs.writeFileSync(path.join(WORK, 'diff.png'), Buffer.from(r.content.find((c) => c.type === 'image').data, 'base64'));
        console.log(`     SSIM ${sc.ssim}, diff ${sc.pixelDiffPct}%, ${sc.diffRegions.length} regions; diff image saved to ${path.join(WORK, 'diff.png')}`);
    });

    await step('hosted guard: caller HTML cannot load other file:// paths (not charged twice: counted below)', async () => {
        // A red PNG on the server's disk. If the guard failed, onload would paint the page red.
        const { PNG } = require('pngjs');
        const red = new PNG({ width: 2, height: 2 });
        for (let i = 0; i < red.data.length; i += 4) { red.data[i] = 255; red.data[i + 3] = 255; }
        const redPath = path.join(WORK, 'red.png');
        fs.writeFileSync(redPath, PNG.sync.write(red));
        const blank = '<!doctype html><html><body style="margin:0;background:#fff"><div style="height:100px"></div></body></html>';
        const probeHtml = blank.replace('</body>', `<img src="file://${redPath}" style="display:none" onload="document.body.style.background='#f00'"></body>`);
        const ref = await renderReference(blank, 200, 1);
        const r = await client.callTool({ name: 'verify_render', arguments: { html: probeHtml, frameWidth: 200, scale: 1, figmaPngBase64: ref, returnImage: false } });
        assert.ok(!r.isError, r.content?.[0]?.text);
        assert.ok(r.structuredContent.pass, `file:// load was NOT blocked (ssim ${r.structuredContent.ssim})`);
    });

    await step('failed Figma call -> isError, token not echoed, not charged', async () => {
        const r = await client.callTool({ name: 'get_figma_component', arguments: { figmaUrl: 'https://www.figma.com/design/AbCdEfGhIjKlMnOp/x?node-id=1-2', summary: true } });
        assert.ok(r.isError, 'expected an error (fake token / no network)');
        assert.ok(!JSON.stringify(r).includes(FAKE_FIGMA_TOKEN), 'token leaked into response');
        console.log(`     ${r.content[0].text.split('\n')[0]}`);
    });

    await step('htmlPath rejected on hosted server', async () => {
        await assert.rejects(
            client.callTool({ name: 'verify_render', arguments: { htmlPath: '/etc/hostname', frameWidth: 10, figmaPngBase64: refB64 } }),
            /not available on a hosted server/,
        );
    });

    await step('charging: exactly 3 verify events, nothing else; tokens never logged', async () => {
        await client.close();
        await new Promise((r) => setTimeout(r, 500));
        const dsRoot = path.join(WORK, 'storage', 'datasets');
        const items = [];
        for (const dir of fs.existsSync(dsRoot) ? fs.readdirSync(dsRoot) : []) {
            for (const f of fs.readdirSync(path.join(dsRoot, dir))) {
                if (f.endsWith('.json') && !f.startsWith('__')) items.push({ dataset: dir, ...JSON.parse(fs.readFileSync(path.join(dsRoot, dir, f), 'utf8')) });
            }
        }
        const charged = items.filter((i) => i.eventName);
        const names = charged.map((i) => i.eventName);
        console.log(`     charging log (${charged[0]?.dataset || 'none'}): ${JSON.stringify(names)}`);
        assert.deepStrictEqual(names, ['verify', 'verify', 'verify']);
        const chargeLines = logs.split('\n').filter((l) => /Charged event/.test(l));
        assert.strictEqual(chargeLines.length, 3, 'Actor.charge logged once per successful verify');
        assert.ok(!logs.includes(FAKE_FIGMA_TOKEN) && !logs.includes('fake-env-token'), 'token found in logs');
    });
} finally {
    child.kill('SIGINT');
    await new Promise((r) => setTimeout(r, 500));
    if (failures) console.log(`\n--- actor logs ---\n${logs}`);
    console.log(failures ? `\n${failures} test(s) failed (work dir ${WORK})` : `\nall local standby tests passed (work dir ${WORK})`);
    process.exit(failures ? 1 : 0);
}

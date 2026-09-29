'use strict';

/**
 * Capture a REAL Figma API response into a local fixture, so we can develop and
 * test the IR transform offline without the key and without hammering the API.
 *
 * Usage:
 *   node scripts/capture.js "<figma-url-with-node-id>"   # captures one node subtree
 *   node scripts/capture.js --file <fileId>              # captures whole file (shallow)
 *
 * Output: fixtures/raw-<name>.json  (raw Figma JSON, untouched)
 */

const fs = require('fs');
const path = require('path');
const { getFile, getNodes, parseFigmaUrl } = require('../src/figma/client');

async function main() {
  const args = process.argv.slice(2);
  const fixturesDir = path.join(process.cwd(), 'fixtures');
  fs.mkdirSync(fixturesDir, { recursive: true });

  let raw, name;
  if (args[0] === '--file') {
    const fileId = args[1];
    if (!fileId) throw new Error('Provide a fileId: node scripts/capture.js --file <fileId>');
    raw = await getFile(fileId);
    name = `file-${fileId.slice(0, 8)}`;
  } else {
    const url = args[0];
    if (!url) throw new Error('Provide a Figma URL or use --file <fileId>');
    const { fileId, nodeId } = parseFigmaUrl(url);
    if (!fileId || !nodeId) throw new Error('URL must contain a node-id. Use --file for whole file.');
    raw = await getNodes(fileId, nodeId);
    name = `node-${nodeId.replace(':', '-')}`;
  }

  const outPath = path.join(fixturesDir, `raw-${name}.json`);
  fs.writeFileSync(outPath, JSON.stringify(raw, null, 2));
  const bytes = Buffer.byteLength(JSON.stringify(raw));
  console.log(`✅ Captured ${name}`);
  console.log(`   → ${outPath}`);
  console.log(`   raw size: ${(bytes / 1024).toFixed(1)} KB`);
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});

'use strict';

/**
 * The core Phase-0 verification tool. Runs the IR transform on a captured
 * fixture and reports, with REAL numbers, what we feed the agent vs what Figma
 * gave us. This is how we prove the changes are correct and useful.
 *
 * Usage:  node scripts/inspect-ir.js fixtures/raw-node-1648-198101.json
 */

const fs = require('fs');
const path = require('path');
const { toIR, fileToIR } = require('../src/ir/transform');

function walk(node, fn) {
  fn(node);
  if (Array.isArray(node.children)) node.children.forEach((c) => walk(c, fn));
}

function rawWalk(node, fn) {
  fn(node);
  if (Array.isArray(node.children)) node.children.forEach((c) => rawWalk(c, fn));
}

function main() {
  const fixturePath = process.argv[2];
  if (!fixturePath) throw new Error('Usage: node scripts/inspect-ir.js <fixture.json>');
  const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

  // Locate the raw subtree(s): /nodes response vs /files response.
  let rawRoots = [];
  let ir;
  if (raw.nodes) {
    rawRoots = Object.values(raw.nodes).map((n) => n.document);
    ir = rawRoots.map((d) => toIR(d));
  } else if (raw.document) {
    rawRoots = raw.document.children || [];
    ir = fileToIR(raw);
  } else {
    rawRoots = [raw];
    ir = [toIR(raw)];
  }

  // ---- Counts ----
  let rawNodes = 0;
  const rawTypes = {};
  rawRoots.forEach((r) => rawWalk(r, (n) => { rawNodes++; rawTypes[n.type] = (rawTypes[n.type] || 0) + 1; }));

  let irNodes = 0;
  let textNodes = 0;
  let withVars = 0;
  let blackArtifacts = 0; // sanity check for the old #000000 bug
  ir.forEach((r) => walk(r, (n) => {
    irNodes++;
    if (n.text) textNodes++;
    if (n.boundVariables) withVars++;
    const blob = JSON.stringify(n.fills || '') + JSON.stringify(n.textStyle || '');
    // count literal black ONLY where the raw node had no real color — flagged manually below
    if (blob.includes('#000000')) blackArtifacts++;
  }));

  // ---- Sizes ----
  const rawBytes = Buffer.byteLength(JSON.stringify(raw));
  const irBytes = Buffer.byteLength(JSON.stringify(ir));
  const reduction = ((1 - irBytes / rawBytes) * 100).toFixed(1);

  // ---- Field coverage on IR ----
  const fieldCounts = {};
  ir.forEach((r) => walk(r, (n) => {
    for (const k of Object.keys(n)) fieldCounts[k] = (fieldCounts[k] || 0) + 1;
  }));

  console.log('\n=== FIGMA RAW ===');
  console.log(`nodes: ${rawNodes}`);
  console.log(`types:`, rawTypes);
  console.log(`raw size: ${(rawBytes / 1024).toFixed(1)} KB`);

  console.log('\n=== OUR IR ===');
  console.log(`nodes: ${irNodes}  (text: ${textNodes}, with boundVariables: ${withVars})`);
  console.log(`IR size: ${(irBytes / 1024).toFixed(1)} KB`);
  console.log(`size reduction vs raw: ${reduction}%`);
  console.log(`\nfield coverage (how many IR nodes carry each field):`);
  Object.entries(fieldCounts).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
    console.log(`  ${k.padEnd(16)} ${v}`);
  });

  console.log('\n=== SANITY CHECKS ===');
  console.log(`nodes containing literal #000000 in fills/textStyle: ${blackArtifacts}`);
  console.log('  ↳ verify these are REAL black in the design, not the old missing-color bug.');

  // Dump the IR next to the fixture for eyeballing.
  const outPath = fixturePath.replace(/raw-/, 'ir-');
  fs.writeFileSync(outPath, JSON.stringify(ir, null, 2));
  console.log(`\nIR written to: ${outPath}`);
}

main();

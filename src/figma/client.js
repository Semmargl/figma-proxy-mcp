'use strict';

/**
 * Thin Figma REST client. No key in source — pulled from config (env/.env).
 */

const { requireApiKey, FETCH } = require('../config');

const BASE = 'https://api.figma.com/v1';

async function figmaGet(pathAndQuery) {
  const key = requireApiKey();
  const res = await fetch(`${BASE}${pathAndQuery}`, { headers: { 'X-Figma-Token': key } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Figma API ${res.status} ${res.statusText} for ${pathAndQuery}\n${body.slice(0, 300)}`);
  }
  return res.json();
}

/** Parse a Figma URL into { fileId, nodeId } (nodeId in API "1648:198101" form). */
function parseFigmaUrl(url) {
  const u = new URL(url);
  const fileId = u.pathname.split('/')[2];
  const raw = u.searchParams.get('node-id');
  const nodeId = raw ? raw.replace('-', ':') : null;
  return { fileId, nodeId };
}

async function getFile(fileId, { depth = FETCH.fileDepth, geometry = 'paths' } = {}) {
  const q = new URLSearchParams({ depth: String(depth), geometry });
  return figmaGet(`/files/${fileId}?${q}`);
}

async function getNodes(fileId, nodeId, { depth = FETCH.nodeDepth, geometry = 'paths' } = {}) {
  const q = new URLSearchParams({ ids: nodeId, depth: String(depth), geometry });
  return figmaGet(`/files/${fileId}/nodes?${q}`);
}

/** Get a render URL (png/svg) for one or more node ids. */
async function getImages(fileId, ids, { format = 'png', scale = 2 } = {}) {
  const q = new URLSearchParams({ ids: Array.isArray(ids) ? ids.join(',') : ids, format, scale: String(scale) });
  return figmaGet(`/images/${fileId}?${q}`);
}

module.exports = { figmaGet, parseFigmaUrl, getFile, getNodes, getImages };

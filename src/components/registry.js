'use strict';

/**
 * Component registry — Phase 3.
 *
 * Persists the design system registry between MCP calls.
 * File: {dataDir}/component-registry.json
 *
 * Registry format:
 *   {
 *     version: 1,
 *     fileId: string | null,
 *     updatedAt: ISO string,
 *     components: {
 *       [componentId]: {
 *         id, name, instanceCount, instanceIds[], variantAxes: { prop: [val, ...] }
 *       }
 *     },
 *     textStyles: {
 *       [name]: { name, fontFamily, fontSize, fontWeight, lineHeight, color, count, nodeIds[] }
 *     }
 *   }
 */

const fs   = require('fs');
const path = require('path');

const REGISTRY_FILE = 'component-registry.json';

function registryPath(dataDir) {
  return path.join(dataDir, REGISTRY_FILE);
}

function emptyRegistry() {
  return {
    version: 1,
    fileId:     null,
    updatedAt:  new Date().toISOString(),
    components: {},
    textStyles: {},
  };
}

/**
 * Load registry from disk. Returns emptyRegistry() if file doesn't exist or is corrupt.
 * @param {string} dataDir  Absolute path to data/ folder.
 * @returns {object}
 */
function loadRegistry(dataDir) {
  const fp = registryPath(dataDir);
  try {
    if (fs.existsSync(fp)) {
      const raw = fs.readFileSync(fp, 'utf-8');
      const parsed = JSON.parse(raw);
      // Basic version check — if schema changes, reset.
      if (parsed.version === 1) return parsed;
      console.warn('[registry] Version mismatch — resetting registry');
    }
  } catch (e) {
    console.warn('[registry] Failed to load registry:', e.message);
  }
  return emptyRegistry();
}

/**
 * Write registry to disk (creates dataDir if needed).
 * @param {object} registry
 * @param {string} dataDir
 */
function saveRegistry(registry, dataDir) {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const fp = registryPath(dataDir);
    fs.writeFileSync(fp, JSON.stringify(registry, null, 2), 'utf-8');
  } catch (e) {
    console.warn('[registry] Failed to save registry:', e.message);
  }
}

/**
 * Merge fresh componentize() output into an existing registry (in-memory, pure).
 *
 * Components: update instanceCount/ids, union variantAxes values.
 * TextStyles: update count, union nodeIds.
 *
 * @param {object} existing   Registry loaded from disk (or empty).
 * @param {object} fresh      Output of a single componentize() run.
 * @returns {object}          Merged registry (new object).
 */
function mergeIntoRegistry(existing, fresh) {
  const merged = {
    version:    1,
    fileId:     fresh.fileId || existing.fileId,
    updatedAt:  fresh.updatedAt,
    components: { ...existing.components },
    textStyles: { ...existing.textStyles },
  };

  // ── Merge components ─────────────────────────────────────────────────────────
  for (const [id, comp] of Object.entries(fresh.components)) {
    const ex = merged.components[id];
    if (ex) {
      // Union instance IDs
      const ids = new Set([...ex.instanceIds, ...comp.instanceIds]);

      // Union variant axis values (per-key)
      const axes = { ...ex.variantAxes };
      for (const [k, vals] of Object.entries(comp.variantAxes)) {
        if (axes[k]) {
          const all = new Set([
            ...axes[k].map(v => JSON.stringify(v)),
            ...vals.map(v => JSON.stringify(v)),
          ]);
          axes[k] = [...all].map(v => JSON.parse(v));
        } else {
          axes[k] = vals;
        }
      }

      merged.components[id] = {
        ...comp,
        instanceIds:  [...ids],
        instanceCount: ids.size,
        variantAxes:  axes,
      };
    } else {
      merged.components[id] = comp;
    }
  }

  // ── Merge text styles ────────────────────────────────────────────────────────
  for (const [name, ts] of Object.entries(fresh.textStyles)) {
    const ex = merged.textStyles[name];
    if (ex) {
      const nodeIds = new Set([...ex.nodeIds, ...ts.nodeIds]);
      merged.textStyles[name] = { ...ts, nodeIds: [...nodeIds], count: nodeIds.size };
    } else {
      merged.textStyles[name] = ts;
    }
  }

  return merged;
}

module.exports = { loadRegistry, saveRegistry, mergeIntoRegistry };

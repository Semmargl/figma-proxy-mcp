'use strict';

/**
 * Variable alias map builder — Phase 2.
 *
 * Problem: on Figma Free/Pro plans, the Variables REST API (/v1/files/:key/variables/local)
 * is not accessible. So we can't fetch token names directly.
 *
 * Solution: walk the IR tree and correlate VARIABLE_ALIAS IDs with the resolved
 * values that co-exist on the same node. For example:
 *
 *   node.fills[0].color = "#0dccf2"
 *   node.boundVariables.fills[0].id = "VariableID:38:1693"
 *   → VariableID:38:1693 resolves to color "#0dccf2"
 *
 * We collect all such observations, then pick the mode (most frequent value)
 * per alias ID. The resulting map can be used to:
 *   1. Resolve `_strokeUnresolved` nodes (find their alias ID in the map)
 *   2. Annotate the token table with variable IDs for future Enterprise migration
 *   3. Validate frequency-analysis tokens against variable-binding evidence
 *
 * Supported correlations:
 *   fills[i]                → node.fills[i].color  (SOLID)
 *   strokes[0]              → node.stroke.color
 *   itemSpacing             → node.layout.gap
 *   opacity                 → node.opacity
 *   fontSize[0]             → node.textStyle.fontSize
 *   fontWeight[0]           → node.textStyle.fontWeight
 *   fontFamily[0]           → node.textStyle.fontFamily
 *   lineHeight[0]           → node.textStyle.lineHeight
 *   letterSpacing[0]        → node.textStyle.letterSpacing
 *   strokeWeight            → node.stroke.weight   (on VECTOR)
 *   individualStrokeWeights → node.stroke.weight
 */

/**
 * Record one observation: varId → {field, value}.
 * @param {Map} obs  varId → Map<stringifiedValue, {value, field, count}>
 */
function observe(obs, varId, field, value) {
  if (!varId || value === undefined || value === null) return;
  if (!obs.has(varId)) obs.set(varId, new Map());
  const valStr = String(value);
  const bucket = obs.get(varId);
  if (bucket.has(valStr)) {
    bucket.get(valStr).count++;
  } else {
    bucket.set(valStr, { value, field, count: 1 });
  }
}

/** Walk a single node and record all alias→value correlations. */
function collectNode(node, obs) {
  const bv = node.boundVariables;
  if (!bv) return;

  // fills[i] → node.fills[i].color
  if (Array.isArray(bv.fills) && Array.isArray(node.fills)) {
    bv.fills.forEach((alias, i) => {
      if (alias?.id && node.fills[i]?.color) {
        observe(obs, alias.id, 'color', node.fills[i].color);
      }
    });
  }

  // strokes[0] → node.stroke.color
  if (Array.isArray(bv.strokes) && node.stroke?.color) {
    const alias = bv.strokes[0];
    if (alias?.id) observe(obs, alias.id, 'color', node.stroke.color);
  }

  // itemSpacing → node.layout.gap
  if (bv.itemSpacing?.id && node.layout?.gap !== undefined) {
    observe(obs, bv.itemSpacing.id, 'spacing', node.layout.gap);
  }

  // opacity → node.opacity
  if (bv.opacity?.id && node.opacity !== undefined) {
    observe(obs, bv.opacity.id, 'opacity', node.opacity);
  }

  // strokeWeight → node.stroke.weight (VECTOR nodes)
  if (bv.strokeWeight?.id && node.stroke?.weight !== undefined) {
    observe(obs, bv.strokeWeight.id, 'borderWidth', node.stroke.weight);
  }

  // individualStrokeWeights — all sides share same weight token
  if (bv.individualStrokeWeights && node.stroke?.weight !== undefined) {
    for (const alias of Object.values(bv.individualStrokeWeights)) {
      if (alias?.id) observe(obs, alias.id, 'borderWidth', node.stroke.weight);
    }
  }

  // Typography — TEXT nodes
  if (node.textStyle) {
    const ts = node.textStyle;
    const pick = (arr) => Array.isArray(arr) ? arr[0] : null;

    if (pick(bv.fontSize)?.id && ts.fontSize !== undefined)
      observe(obs, pick(bv.fontSize).id, 'fontSize', ts.fontSize);

    if (pick(bv.fontWeight)?.id && ts.fontWeight !== undefined)
      observe(obs, pick(bv.fontWeight).id, 'fontWeight', ts.fontWeight);

    if (pick(bv.fontFamily)?.id && ts.fontFamily !== undefined)
      observe(obs, pick(bv.fontFamily).id, 'fontFamily', ts.fontFamily);

    if (pick(bv.lineHeight)?.id && ts.lineHeight !== undefined)
      observe(obs, pick(bv.lineHeight).id, 'lineHeight', ts.lineHeight);

    if (pick(bv.letterSpacing)?.id && ts.letterSpacing !== undefined)
      observe(obs, pick(bv.letterSpacing).id, 'letterSpacing', ts.letterSpacing);

    // fills on TEXT = text color
    if (Array.isArray(bv.fills) && ts.color) {
      const alias = bv.fills[0];
      if (alias?.id) observe(obs, alias.id, 'color', ts.color);
    }
  }
}

/** Recursively walk the IR tree collecting observations. */
function walkTree(node, obs) {
  collectNode(node, obs);
  if (Array.isArray(node.children)) {
    for (const child of node.children) walkTree(child, obs);
  }
}

/**
 * Build the variable alias map from an IR tree.
 *
 * @param {object} ir  Pruned IR root node.
 * @returns {Map<string, {value: any, field: string, count: number, allValues: object[]}>}
 *   varId → modal (most frequent) observation + all observations for audit.
 */
function buildVarMap(ir) {
  const obs = new Map(); // varId → Map<valueStr, {value, field, count}>
  walkTree(ir, obs);

  const result = new Map();
  for (const [varId, bucket] of obs) {
    // Pick the observation with highest count (mode).
    let best = null;
    for (const entry of bucket.values()) {
      if (!best || entry.count > best.count) best = entry;
    }
    result.set(varId, {
      value: best.value,
      field: best.field,
      count: best.count,
      allValues: [...bucket.values()],
    });
  }
  return result;
}

/**
 * Attempt to resolve `_strokeUnresolved` nodes using the varmap.
 * Returns a new IR tree (structurally identical, stroke fields patched where possible).
 *
 * @param {object} ir
 * @param {Map}    varMap  Output of buildVarMap.
 * @returns {object}  Patched IR.
 */
function resolveStrokes(ir, varMap) {
  return resolveNode(ir, varMap);
}

function resolveNode(node, varMap) {
  if (!node) return node;

  let result = node;

  // Try to resolve _strokeUnresolved via varmap
  if (node._strokeUnresolved && node.boundVariables) {
    const bv = node.boundVariables;
    const aliases = Array.isArray(bv.strokes) ? bv.strokes : [];
    for (const alias of aliases) {
      if (alias?.id && varMap.has(alias.id)) {
        const resolved = varMap.get(alias.id);
        if (resolved.field === 'color') {
          // Attempt to infer weight from individualStrokeWeights alias
          let weight = 1;
          if (bv.individualStrokeWeights) {
            const weightAlias = Object.values(bv.individualStrokeWeights)[0];
            if (weightAlias?.id && varMap.has(weightAlias.id)) {
              weight = varMap.get(weightAlias.id).value ?? 1;
            }
          }
          result = {
            ...result,
            stroke: { color: resolved.color ?? resolved.value, weight, align: 'INSIDE' },
            _strokeUnresolved: undefined,
            _strokeResolvedFrom: alias.id,
          };
          // Clean up undefined
          if (result._strokeUnresolved === undefined) {
            const { _strokeUnresolved, ...rest } = result;
            result = rest;
          }
          break;
        }
      }
    }
  }

  // Recurse
  if (Array.isArray(result.children) && result.children.length) {
    const newChildren = result.children.map((c) => resolveNode(c, varMap));
    result = { ...result, children: newChildren };
  }

  return result;
}

module.exports = { buildVarMap, resolveStrokes };

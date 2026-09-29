'use strict';

/**
 * Phase 1 — Deterministic pruning pass over an IR tree.
 *
 * Philosophy
 * ----------
 * Prefer _pruned tags over silent deletion so every change is auditable.
 * Pass `opts.strip: true` to get a compact tree with tagged nodes removed.
 * Pass `opts.verbose: true` to keep pruned nodes in the output (default).
 *
 * Rules — what is safe to remove
 * --------------------------------
 * 1. HIDDEN        node.visible === false
 * 2. ZERO-SIZE     box.w === 0 AND box.h === 0 (both zero), except VECTOR
 * 3. COLLAPSE      FRAME/GROUP, single child, no visual payload,
 *                  no meaningful layout → replace parent with child
 *
 * Protection — NEVER prune a node that has any of
 * --------------------------------------------------
 * • text                 (contains copy)
 * • boundVariables       (design-token binding — Phase 2 needs it)
 * • componentId          (Figma component identity — Phase 3 needs it)
 * • exportSettings       (asset export marker)
 * • fills / stroke       (visible styling)
 * • effects              (shadows, blurs)
 * • cornerRadius         (visible styling)
 * • opacity < 1          (intentional transparency — e.g. floating overlays)
 * • semantic name        (button*, h1*, p.*, div.*, Card, Nav, …)
 * • VECTOR type          (SVG path data — tagged for Phase 3 export)
 *
 * VECTOR tagging
 * --------------
 * VECTOR nodes with only stroke (no fills) are tagged _iconExportNeeded:true.
 * They must NOT be pruned — Phase 3 will replace them with real SVG exports.
 */

// Names that signal semantic intent the code generator relies on.
const SEMANTIC_NAME_RE =
  /^(button|Button|Card|card|Nav|nav|h[1-6]\.|p\.|div\.|span\.|section|header|footer|article|aside|ul\.|li\.|input|form)/;

/** True when a name implies semantic meaning the generator should preserve. */
function isSemantic(name = '') {
  return SEMANTIC_NAME_RE.test(name);
}

/**
 * True when a layout object adds only a container direction (mode + sizing)
 * with no gap, padding, or alignment override. Such a wrapper is a passthrough
 * that adds no CSS complexity and can be collapsed safely.
 */
function isPassthroughLayout(layout) {
  if (!layout) return true;
  const { mode, primarySizing, counterSizing, ...rest } = layout; // eslint-disable-line no-unused-vars
  return Object.keys(rest).length === 0;
}

/**
 * True when a node carries any visual or data payload that must be preserved.
 * Any one of these blocks pruning/collapsing.
 */
function isProtected(node) {
  return !!(
    node.text ||
    node.boundVariables ||
    node.componentId ||
    node.exportSettings ||
    node.fills ||
    node.stroke ||
    node._strokeUnresolved ||   // stroke bound to a variable — keep
    node.effects ||
    node.cornerRadius ||
    (typeof node.opacity === 'number' && node.opacity < 1) ||
    isSemantic(node.name) ||
    node.type === 'VECTOR' ||
    node.type === 'TEXT' ||
    node.type === 'INSTANCE'
  );
}

// ── Node counter (for stats) ──────────────────────────────────────────────────

function countNodes(node) {
  if (!node) return 0;
  let n = 1;
  if (Array.isArray(node.children)) {
    for (const c of node.children) n += countNodes(c);
  }
  return n;
}

// ── Core pruner ───────────────────────────────────────────────────────────────

/**
 * Prune one IR node (and its subtree).
 *
 * @param {object}  node
 * @param {object}  opts
 * @param {boolean} [opts.verbose=true]   Keep pruned nodes in tree with _pruned tag.
 * @param {boolean} [opts.strip=false]    Remove pruned nodes entirely (compact output).
 * @param {object}  [opts._stats]         Internal stats accumulator — do not pass.
 * @returns {object|null}  Processed node, or null if it should be dropped.
 */
function pruneNode(node, opts, parentType) {
  // strip:true silently drops / collapses (compact output).
  // verbose:true (default) keeps pruned nodes tagged for audit trail.
  // strip takes precedence: strip:true → verbose forced off.
  const verbose = !opts.strip && opts.verbose !== false;
  const stats = opts._stats;

  // ── Rule 1: hidden ────────────────────────────────────────────────────────
  if (node.visible === false) {
    stats.hidden++;
    if (verbose) return { ...node, _pruned: 'visible:false' };
    return null;
  }

  // ── Rule 2: zero bounding box (both dims), skip VECTORs ──────────────────
  if (
    node.box &&
    node.box.w === 0 &&
    node.box.h === 0 &&
    node.type !== 'VECTOR'
  ) {
    stats.zeroSize++;
    if (verbose) return { ...node, _pruned: 'zero-size' };
    return null;
  }

  // ── VECTOR tagging: icon stroke with no fill → needs SVG export ───────────
  let result = node;
  if (node.type === 'VECTOR' && node.stroke && !node.fills) {
    result = { ...node, _iconExportNeeded: true };
  }

  // ── Recurse into children first (bottom-up) ───────────────────────────────
  if (Array.isArray(result.children) && result.children.length) {
    const processedChildren = result.children
      .map((c) => pruneNode(c, opts, result.type))
      .filter(Boolean); // drop nulls (stripped hidden/zero nodes)

    result = { ...result, children: processedChildren };
    if (!processedChildren.length) {
      const { children, ...withoutChildren } = result; // eslint-disable-line no-unused-vars
      result = withoutChildren;
    }
  }

  // ── Rule 3: collapse single-child passthrough wrapper ─────────────────────
  //
  // Collapse when ALL of:
  //   • type FRAME or GROUP
  //   • exactly one child remaining after pruning children
  //   • node itself is not protected (no visual payload, no semantic name)
  //   • layout is passthrough (no gap/padding/alignment)
  //   • child is not a TEXT node (text nodes need their parent for width/constraints)
  //   • child is not a component instance (don't float up componentId)
  //
  if (
    (result.type === 'FRAME' || result.type === 'GROUP') &&
    Array.isArray(result.children) &&
    result.children.length === 1 &&
    !isProtected(result) &&
    isPassthroughLayout(result.layout) &&
    result.children[0].type !== 'TEXT' &&
    !result.children[0].componentId
  ) {
    stats.collapsed++;
    const child = result.children[0];
    if (verbose) {
      // Keep wrapper tagged so the audit trail is visible.
      return { ...result, _pruned: `collapsed-wrapper`, children: [child] };
    }
    return child;
  }

  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the Phase 1 pruning pass over a single IR node.
 *
 * @param {object} ir       Root IR node (output of toIR()).
 * @param {object} [opts]
 * @param {boolean} [opts.verbose=true]  Keep pruned nodes in tree (default).
 * @param {boolean} [opts.strip=false]   Remove pruned nodes (compact output).
 * @returns {{ pruned: object|null, stats: PruneStats }}
 */
function prune(ir, opts = {}) {
  const stats = { hidden: 0, zeroSize: 0, collapsed: 0 };
  const before = countNodes(ir);
  const pruned = pruneNode(ir, { ...opts, _stats: stats }, null);
  const after = countNodes(pruned);
  stats.before = before;
  stats.after = after;
  stats.reduction = before > 0 ? Math.round((1 - after / before) * 100) : 0;
  return { pruned, stats };
}

/**
 * Run the pruning pass over an array of IR nodes (e.g. pages from fileToIR).
 *
 * @param {object[]} irs
 * @param {object}   [opts]
 * @returns {{ pruned: object[], stats: PruneStats }}
 */
function pruneAll(irs, opts = {}) {
  const combinedStats = { hidden: 0, zeroSize: 0, collapsed: 0, before: 0, after: 0 };
  const pruned = irs.map((ir) => {
    const { pruned: p, stats } = prune(ir, opts);
    combinedStats.hidden    += stats.hidden;
    combinedStats.zeroSize  += stats.zeroSize;
    combinedStats.collapsed += stats.collapsed;
    combinedStats.before    += stats.before;
    combinedStats.after     += stats.after;
    return p;
  }).filter(Boolean);
  combinedStats.reduction = combinedStats.before > 0
    ? Math.round((1 - combinedStats.after / combinedStats.before) * 100)
    : 0;
  return { pruned, stats: combinedStats };
}

module.exports = { prune, pruneAll, isProtected, isPassthroughLayout, countNodes };

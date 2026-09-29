'use strict';

/**
 * Canonical Intermediate Representation (IR).
 *
 * Turns a raw Figma node (from the REST API) into a compact, lossless-where-it-
 * matters node. The golden rule: OMIT fields that are absent or at their
 * default. No empty {padding:{}}, no fake "#000000". This is the backbone every
 * later stage (prune / tokenize / componentize) operates on.
 */

const { colorToCss, summariseFills } = require('./color');

/** Drop keys whose value is undefined/null/empty-object/empty-array. */
function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

function boxOf(node) {
  const b = node.absoluteBoundingBox;
  if (!b) return undefined;
  return clean({
    x: round(b.x),
    y: round(b.y),
    w: round(b.width),
    h: round(b.height),
  });
}

function round(n) {
  return typeof n === 'number' ? Math.round(n * 100) / 100 : undefined;
}

function paddingOf(node) {
  const p = clean({
    t: node.paddingTop,
    r: node.paddingRight,
    b: node.paddingBottom,
    l: node.paddingLeft,
  });
  return Object.keys(p).length ? p : undefined;
}

function layoutOf(node) {
  if (!node.layoutMode || node.layoutMode === 'NONE') return undefined;
  return clean({
    mode: node.layoutMode, // HORIZONTAL | VERTICAL | GRID
    wrap: node.layoutWrap === 'WRAP' ? true : undefined,
    gap: node.itemSpacing,
    padding: paddingOf(node),
    primaryAlign: node.primaryAxisAlignItems,
    counterAlign: node.counterAxisAlignItems,
    primarySizing: node.primaryAxisSizingMode,
    counterSizing: node.counterAxisSizingMode,
    // GRID: heuristic column count = direct children count (one row assumption).
    // Phase 2 may refine via bounding-box analysis.
    columns: node.layoutMode === 'GRID' && Array.isArray(node.children) && node.children.length > 0
      ? node.children.length
      : undefined,
  });
}

function strokeOf(node) {
  // Pass the stroke paint's opacity into colorToCss so translucent (glass)
  // borders are recorded as rgba(...) rather than a solid colour. Without this,
  // white@0.1 glass borders collapse to #ffffff and render as harsh solid lines.
  const sp = node.strokes && node.strokes[0];
  const css = colorToCss(sp && sp.color, sp && sp.opacity);
  if (!css || !node.strokeWeight) return undefined;
  return clean({ color: css, weight: round(node.strokeWeight), align: node.strokeAlign });
}

function effectsOf(node) {
  if (!Array.isArray(node.effects) || node.effects.length === 0) return undefined;
  const out = [];
  for (const e of node.effects) {
    if (e.visible === false) continue;
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      out.push(clean({
        type: e.type === 'INNER_SHADOW' ? 'inner-shadow' : 'shadow',
        color: colorToCss(e.color),
        x: round(e.offset && e.offset.x),
        y: round(e.offset && e.offset.y),
        blur: round(e.radius),
        spread: round(e.spread),
      }));
    } else if (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') {
      out.push(clean({ type: e.type.toLowerCase().replace('_', '-'), blur: round(e.radius) }));
    }
  }
  return out.length ? out : undefined;
}

function cornerOf(node) {
  if (typeof node.cornerRadius === 'number' && node.cornerRadius > 0) return node.cornerRadius;
  if (Array.isArray(node.rectangleCornerRadii) && node.rectangleCornerRadii.some((r) => r > 0)) {
    return node.rectangleCornerRadii;
  }
  return undefined;
}

function textStyleOf(node) {
  const s = node.style;
  if (!s) return undefined;
  return clean({
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    fontWeight: s.fontWeight,
    lineHeight: round(s.lineHeightPx),
    letterSpacing: round(s.letterSpacing),
    align: s.textAlignHorizontal,
    decoration: s.textDecoration && s.textDecoration !== 'NONE' ? s.textDecoration : undefined,
    case: s.textCase && s.textCase !== 'ORIGINAL' ? s.textCase : undefined,
    // Pass the text fill paint's opacity so translucent text (e.g. white@0.3
    // muted/secondary labels) is recorded as rgba(...) and matches the fills
    // summary, instead of collapsing to a solid #ffffff token.
    color: colorToCss(
      node.fills && node.fills[0] && node.fills[0].color,
      node.fills && node.fills[0] && node.fills[0].opacity
    ),
  });
}

/**
 * Transform one raw Figma node (and its children) into an IR node.
 * @param {object} node raw Figma node
 * @param {{maxDepth?:number, _depth?:number}} [opts]
 * @returns {object} IR node
 */
function toIR(node, opts = {}) {
  const maxDepth = opts.maxDepth ?? Infinity;
  const depth = opts._depth ?? 0;

  const stroke = strokeOf(node);

  // Tag when a stroke is bound to a variable but the resolved color is absent.
  // Happens on Free/Pro plans where Variables REST API is unavailable:
  // Phase 2 (frequency analysis) may resolve these from sibling values.
  const strokeUnresolved =
    !stroke &&
    node.boundVariables &&
    (node.boundVariables.strokes || node.boundVariables.individualStrokeWeights)
      ? true
      : undefined;

  // Multi-colour / mixed-style text: per-character overrides mean a single
  // textStyle.color is NOT enough (e.g. an accent word, syntax-highlighted code).
  // Flag so the pipeline point-fetches segment colours instead of collapsing to one.
  const multicolor =
    node.type === 'TEXT' &&
    ((Array.isArray(node.characterStyleOverrides) && node.characterStyleOverrides.some((v) => v)) ||
      (node.styleOverrideTable && Object.keys(node.styleOverrideTable).length > 0))
      ? true
      : undefined;

  const ir = clean({
    id: node.id,
    name: node.name,
    type: node.type,
    box: boxOf(node),
    opacity: typeof node.opacity === 'number' && node.opacity < 1 ? node.opacity : undefined,
    visible: node.visible === false ? false : undefined, // only record when hidden
    layout: layoutOf(node),
    fills: summariseFills(node.fills),
    stroke,
    cornerRadius: cornerOf(node),
    effects: effectsOf(node),
    text: node.characters || undefined,
    textStyle: textStyleOf(node),
    // Preserve variable bindings and export hints verbatim — used by later stages.
    boundVariables: node.boundVariables,
    exportSettings: Array.isArray(node.exportSettings) && node.exportSettings.length
      ? node.exportSettings.map((e) => e.format)
      : undefined,
    // Component identity: the key later stages cluster on (Phase 3).
    componentId: node.componentId,
    componentKey: node.key,
    constraints: node.constraints,
    // Audit tags (set when true, omitted otherwise).
    _strokeUnresolved: strokeUnresolved,
    _multicolor: multicolor,
  });

  if (Array.isArray(node.children) && node.children.length && depth < maxDepth) {
    ir.children = node.children.map((c) => toIR(c, { maxDepth, _depth: depth + 1 }));
  }
  return ir;
}

/** Transform the top-level pages of a /files response into IR. */
function fileToIR(fileData, opts) {
  const pages = (fileData && fileData.document && fileData.document.children) || [];
  return pages.map((p) => toIR(p, opts));
}

module.exports = { toIR, fileToIR, clean };

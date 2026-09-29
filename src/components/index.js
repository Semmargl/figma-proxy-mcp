'use strict';

/**
 * Phase 3 — Component identification and text style clustering.
 *
 * Pipeline (runs on Phase 2 annotated IR):
 *   annotated IR
 *     → collectTextNodes()   gather all TEXT nodes with textStyle
 *     → buildTextStyles()    group by (fontFamily+size+weight+lineHeight) → named styles
 *     → collectInstances()   gather all INSTANCE nodes grouped by componentId
 *     → buildComponents()    compute variant axes per component
 *     → annotateNode()       tag nodes with _textStyle / _componentName / _variantProps
 *     → mergeIntoRegistry()  persist to data/component-registry.json
 *
 * Output annotations in IR:
 *   TEXT node:     _textStyle: "heading-1"
 *   INSTANCE node: _componentName: "Button"
 *                  _variantProps: { fill0: "$--color-primary", h: 48 }  (only varying axes)
 *
 * Registry format: see src/components/registry.js
 */

const { loadRegistry, saveRegistry, mergeIntoRegistry } = require('./registry');

// ── Text style classification ──────────────────────────────────────────────────

/**
 * Map font size (px) → a human-readable tier name.
 * Checked in descending order so the first match wins.
 */
const TEXT_SIZE_TIERS = [
  [56, 'heading-1'],
  [40, 'heading-2'],
  [28, 'heading-3'],
  [22, 'heading-4'],
  [18, 'heading-5'],
  [16, 'body-lg'],
  [14, 'body-base'],
  [12, 'body-sm'],
  [10, 'body-xs'],
  [0,  'body-2xs'],
];

// ── Token resolvers ────────────────────────────────────────────────────────────
// Phase 2 replaces raw values with CSS variable tokens ($--text-5xl, $--font-bold, etc.).
// The naming pipeline needs numeric values to classify styles — resolve them here.

/** Maps Phase-2 font-size tokens → pixel values. */
const TOKEN_SIZE_PX = {
  '$--text-2xs':  10,
  '$--text-xs-2': 10,
  '$--text-xs':   12,
  '$--text-sm':   13,
  '$--text-base': 14,
  '$--text-lg':   18,
  '$--text-xl':   20,
  '$--text-2xl':  24,
  '$--text-3xl':  30,
  '$--text-4xl':  36,
  '$--text-5xl':  64,
};

/** Maps Phase-2 font-weight tokens → numeric values. */
const TOKEN_WEIGHT_NUM = {
  '$--font-thin':      100,
  '$--font-light':     300,
  '$--font-regular':   400,
  '$--font-medium':    500,
  '$--font-semibold':  600,
  '$--font-bold':      700,
  '$--font-extrabold': 800,
};

/** Maps non-default numeric weights → short name suffix. */
const WEIGHT_SUFFIX = {
  100: 'thin',
  300: 'light',
  500: 'medium',
  600: 'semibold',
  700: 'bold',
  800: 'extrabold',
};

/** Resolve a fontSize value (token string or plain number) → pixels. */
function resolveSize(v) {
  if (typeof v === 'number') return v;
  return TOKEN_SIZE_PX[v] ?? 14; // fallback: body-base
}

/** Resolve a fontWeight value (token string or plain number) → numeric weight. */
function resolveWeight(v) {
  if (typeof v === 'number') return v;
  return TOKEN_WEIGHT_NUM[v] ?? 400;
}

/** Resolve a fontFamily token → plain string for regex matching. */
function resolveFamily(v) {
  if (!v) return '';
  if (!String(v).startsWith('$')) return v;
  // "$--font-jetbrains-mono" → "jetbrains mono"
  return String(v).replace(/^\$--font-/, '').replace(/-/g, ' ');
}

/** True if fontFamily (raw or token) refers to a monospace font. */
function isMono(fontFamily) {
  return /mono|code|jetbrains|courier|consolas|fira|source\s*code/i.test(
    resolveFamily(fontFamily)
  );
}

/**
 * Derive a semantic text style name from fontFamily + fontSize + fontWeight.
 *
 * Rules:
 *  - prefix "mono-" for monospace families
 *  - size tier from TEXT_SIZE_TIERS (uses resolved px, not token string)
 *  - weight suffix appended when weight ≠ default:
 *      heading-1/2/3 → default is bold (700); semibold also skipped for those tiers
 *      all other tiers → default is regular (400)
 *
 * Examples:
 *   Inter / $--text-5xl / $--font-bold      → "heading-1"
 *   Inter / $--text-lg  / $--font-regular   → "heading-5"
 *   Inter / $--text-lg  / $--font-bold      → "heading-5-bold"
 *   Mono  / $--text-base/ $--font-medium    → "mono-body-base-medium"
 *   Mono  / $--text-base/ $--font-regular   → "mono-body-base"
 *   Inter / $--text-xs  / $--font-regular   → "body-sm"
 */
function baseTextStyleName(fontFamily, fontSize, fontWeight) {
  const prefix   = isMono(fontFamily) ? 'mono-' : '';
  const sizePx   = resolveSize(fontSize);
  const weightN  = resolveWeight(fontWeight);

  // Find size tier
  let tier = 'body-xs';
  for (const [threshold, name] of TEXT_SIZE_TIERS) {
    if (sizePx >= threshold) { tier = name; break; }
  }

  // Determine default weight for this tier
  const isLargeHeading = tier === 'heading-1' || tier === 'heading-2' || tier === 'heading-3';
  const defaultWeight  = isLargeHeading ? 700 : 400;
  // Large headings: also skip suffix for semibold (both 600 and 700 are "heading bold")
  const skipSuffix = isLargeHeading && weightN >= 600;

  const suffix = (skipSuffix || weightN === defaultWeight)
    ? ''
    : `-${WEIGHT_SUFFIX[weightN] || weightN}`;

  return prefix + tier + suffix;
}

/**
 * Stable grouping key for a textStyle object.
 * Two text nodes with the same key get the same style name.
 */
function textStyleKey(ts) {
  return `${ts.fontFamily || ''}|${ts.fontSize || 0}|${ts.fontWeight || 400}|${Math.round(ts.lineHeight || 0)}`;
}

/** Recursively collect all TEXT nodes that have a valid textStyle. */
function collectTextNodes(node, acc) {
  if (!acc) acc = [];
  if (!node) return acc;
  if (
    node.type === 'TEXT' &&
    node.textStyle &&
    node.textStyle.fontFamily &&
    node.textStyle.fontSize
  ) {
    acc.push({ id: node.id, name: node.name || '', textStyle: node.textStyle });
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectTextNodes(child, acc);
  }
  return acc;
}

/**
 * Group TEXT nodes by textStyleKey → assign unique names → build textStyles map.
 * Names are unique; collisions get a numeric suffix (heading-2, heading-2-2, …).
 *
 * @param {object[]} textNodes  Output of collectTextNodes().
 * @returns {object}  { [name]: { name, fontFamily, fontSize, fontWeight, lineHeight, color, count, nodeIds[] } }
 */
function buildTextStyles(textNodes) {
  // Group by key
  const groups = new Map();
  for (const n of textNodes) {
    const key = textStyleKey(n.textStyle);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }

  // Sort groups by resolved fontSize DESC, then by weight DESC (bold headings before regular)
  const sorted = [...groups.entries()].sort(([, a], [, b]) => {
    const sizeDiff = resolveSize(b[0].textStyle.fontSize) - resolveSize(a[0].textStyle.fontSize);
    if (sizeDiff !== 0) return sizeDiff;
    return resolveWeight(b[0].textStyle.fontWeight) - resolveWeight(a[0].textStyle.fontWeight);
  });

  const usedNames = new Set();
  const textStyles = {};

  for (const [, nodes] of sorted) {
    const ts = nodes[0].textStyle;
    const base = baseTextStyleName(ts.fontFamily, ts.fontSize, ts.fontWeight);

    let name = base;
    let i = 2;
    while (usedNames.has(name)) name = `${base}-${i++}`;
    usedNames.add(name);

    textStyles[name] = {
      name,
      fontFamily:   ts.fontFamily,
      fontSize:     ts.fontSize,
      fontWeight:   ts.fontWeight,
      lineHeight:   ts.lineHeight,
      color:        ts.color || null,
      count:        nodes.length,
      nodeIds:      nodes.map(n => n.id),
    };
  }

  return textStyles;
}

/** Build a Map<textStyleKey, styleName> for fast O(1) annotation lookups. */
function buildTextStyleLookup(textStyles) {
  const lookup = new Map();
  for (const [name, ts] of Object.entries(textStyles)) {
    const key = `${ts.fontFamily || ''}|${ts.fontSize || 0}|${ts.fontWeight || 400}|${Math.round(ts.lineHeight || 0)}`;
    lookup.set(key, name);
  }
  return lookup;
}

// ── Component identification ───────────────────────────────────────────────────

/**
 * Parse a Figma node name into a base component name.
 * "Button / Primary" → "Button"
 * "Icon/Arrow right" → "Icon"
 * "Badge"            → "Badge"
 */
function parseComponentName(nodeName) {
  if (!nodeName) return 'Unknown';
  const slashIdx = nodeName.indexOf('/');
  if (slashIdx > 0) return nodeName.slice(0, slashIdx).trim();
  return nodeName.trim();
}

/**
 * Extract a flat property map from a single INSTANCE node.
 * These props are used to detect variant axes across instances.
 * Values may be raw or annotated ($--color-primary) from Phase 2.
 */
function extractInstanceProps(node) {
  const props = {};
  const set = (k, v) => { if (v !== null && v !== undefined) props[k] = v; };

  // Fills
  if (Array.isArray(node.fills)) {
    if (node.fills[0]) set('fill0', node.fills[0].color);
    if (node.fills[1]) set('fill1', node.fills[1].color);
  }

  // Stroke
  set('strokeColor',  node.stroke?.color);
  set('strokeWeight', node.stroke?.weight);

  // Shape
  set('cornerRadius', node.cornerRadius);
  if (typeof node.opacity === 'number' && node.opacity < 1) set('opacity', node.opacity);
  set('w', node.box?.w);
  set('h', node.box?.h);

  // Text on the node itself (rare for INSTANCE but possible)
  set('text', node.text);
  set('textColor',   node.textStyle?.color);
  set('fontSize',    node.textStyle?.fontSize);
  set('fontWeight',  node.textStyle?.fontWeight);

  // First TEXT child (button label, card title, etc.)
  if (Array.isArray(node.children)) {
    const tc = node.children.find(c => c.type === 'TEXT');
    if (tc) {
      set('childText',      tc.text);
      set('childTextColor', tc.textStyle?.color);
      set('childFontSize',  tc.textStyle?.fontSize);
      set('childFontWeight',tc.textStyle?.fontWeight);
    }
  }

  return props;
}

/**
 * Compute variant axes from a list of instances.
 * An axis is any property that has more than one distinct value across instances.
 *
 * @param {Array<{id, name, props}>} instances
 * @returns {{ [propKey]: any[] }}  propKey → array of unique values seen
 */
function computeVariantAxes(instances) {
  if (instances.length <= 1) return {};

  const allKeys = new Set();
  for (const inst of instances) Object.keys(inst.props).forEach(k => allKeys.add(k));

  const axes = {};
  for (const key of allKeys) {
    const values = instances.map(inst => JSON.stringify(inst.props[key] ?? null));
    const unique = [...new Set(values)].map(v => JSON.parse(v));
    if (unique.length > 1) axes[key] = unique;
  }
  return axes;
}

/** Recursively collect INSTANCE nodes grouped by componentId. */
function collectInstances(node, groups) {
  if (!groups) groups = new Map();
  if (!node) return groups;
  if (node.componentId) {
    if (!groups.has(node.componentId)) groups.set(node.componentId, []);
    groups.get(node.componentId).push({
      id:    node.id,
      name:  node.name || '',
      props: extractInstanceProps(node),
    });
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectInstances(child, groups);
  }
  return groups;
}

/**
 * Build component map from grouped instances.
 * @param {Map<string, Array>} instanceGroups
 * @returns {{ [componentId]: { id, name, instanceCount, instanceIds[], variantAxes } }}
 */
function buildComponents(instanceGroups) {
  const components = {};
  for (const [componentId, instances] of instanceGroups) {
    const variantAxes = computeVariantAxes(instances);
    components[componentId] = {
      id:           componentId,
      name:         parseComponentName(instances[0].name),
      instanceCount: instances.length,
      instanceIds:  instances.map(i => i.id),
      variantAxes,
    };
  }
  return components;
}

// ── IR annotation ──────────────────────────────────────────────────────────────

/**
 * Walk IR tree and add Phase 3 annotations to each node (immutable — new objects).
 *
 * TEXT node:     _textStyle: "heading-1"
 * INSTANCE node: _componentName: "Button"
 *                _variantProps: { fill0: "$--color-primary" }  (only the axes that vary)
 */
function annotateNode(node, textStyleLookup, components) {
  if (!node) return node;
  let n = { ...node };

  // Annotate TEXT nodes
  if (n.type === 'TEXT' && n.textStyle?.fontFamily && n.textStyle?.fontSize) {
    const key = textStyleKey(n.textStyle);
    const tsName = textStyleLookup.get(key);
    if (tsName) n._textStyle = tsName;
  }

  // Annotate INSTANCE nodes
  if (n.componentId) {
    const comp = components[n.componentId];
    if (comp) {
      n._componentName = comp.name;
      // Only add _variantProps if this component has axes
      const axisKeys = Object.keys(comp.variantAxes);
      if (axisKeys.length > 0) {
        const myProps = extractInstanceProps(n);
        const variant = {};
        for (const k of axisKeys) {
          variant[k] = myProps[k] ?? null;
        }
        n._variantProps = variant;
      }
    }
  }

  // Recurse
  if (Array.isArray(n.children)) {
    n.children = n.children.map(c => annotateNode(c, textStyleLookup, components));
  }

  return n;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Run the Phase 3 componentization pipeline on a Phase-2-annotated IR.
 *
 * @param {object} ir     Annotated IR from Phase 2 (tokenize output).
 * @param {object} [opts]
 * @param {string} [opts.dataDir]   Absolute path to data/ folder.  If provided,
 *                                  registry is loaded and (if persist=true) saved.
 * @param {string} [opts.fileId]    Figma file ID — stored in registry metadata.
 * @param {boolean}[opts.persist]   Write updated registry to disk.
 *                                  Defaults to true when dataDir is provided.
 * @returns {{
 *   annotatedIR: object,
 *   registry: object,
 *   stats: {
 *     textNodes: number,
 *     textStyles: number,
 *     instanceNodes: number,
 *     componentIds: number,
 *     variantComponents: number
 *   }
 * }}
 */
function componentize(ir, opts = {}) {
  const { dataDir, fileId, persist = !!opts.dataDir } = opts;

  // 1. Text styles
  const textNodes    = collectTextNodes(ir);
  const textStyles   = buildTextStyles(textNodes);
  const tsLookup     = buildTextStyleLookup(textStyles);

  // 2. Components
  const instanceGroups = collectInstances(ir);
  const components     = buildComponents(instanceGroups);

  // 3. Annotate IR
  const annotatedIR = annotateNode(ir, tsLookup, components);

  // 4. Build fresh registry snapshot
  const fresh = {
    version:    1,
    fileId:     fileId || null,
    updatedAt:  new Date().toISOString(),
    components,
    textStyles,
  };

  // 5. Merge with persisted registry
  let registry = fresh;
  if (dataDir) {
    const existing = loadRegistry(dataDir);
    registry = mergeIntoRegistry(existing, fresh);
    if (persist) saveRegistry(registry, dataDir);
  }

  // 6. Stats
  const totalInstances = [...instanceGroups.values()].reduce((s, v) => s + v.length, 0);
  const stats = {
    textNodes:          textNodes.length,
    textStyles:         Object.keys(textStyles).length,
    instanceNodes:      totalInstances,
    componentIds:       Object.keys(components).length,
    variantComponents:  Object.values(components).filter(
      c => Object.keys(c.variantAxes).length > 0
    ).length,
  };

  return { annotatedIR, registry, stats };
}

module.exports = { componentize };

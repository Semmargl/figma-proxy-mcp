'use strict';

/**
 * Phase 2 — Design token extraction and IR annotation.
 *
 * Pipeline:
 *   pruned IR
 *     → extractRawValues()   collect all values with occurrence counts
 *     → buildTokenTable()    frequency threshold + semantic naming
 *     → annotateIR()         replace raw values with CSS var() references
 *     → toCssVars()          render :root { --var: value } block
 *
 * Token table format (flat, CSS-vars-ready):
 *   {
 *     colors:       { '--color-primary': '#0dccf2', ... },
 *     spacing:      { '--spacing-8': '8px', ... },
 *     fontSizes:    { '--text-base': '14px', ... },
 *     fontFamilies: { '--font-sans': 'Inter', ... },
 *     fontWeights:  { '--font-bold': '700', ... },
 *     lineHeights:  { '--leading-normal': '20px', ... },
 *     radii:        { '--radius-md': '14px', ... },
 *     borderWidths: { '--border-sm': '1px', ... },
 *   }
 *
 * Annotation format in IR: raw values are replaced with "$--var-name".
 * e.g.  fills[0].color = "$--color-primary"
 *        layout.gap     = "$--spacing-24"
 */

const {
  nameColor,
  nameSpacing,
  nameFontSize,
  nameRadius,
} = require('./naming');

const { buildVarMap, resolveStrokes } = require('./varmap');

// ── Value collection ──────────────────────────────────────────────────────────

/** Increment a tally map. */
function tally(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

/**
 * Walk the IR tree and collect raw values with occurrence counts.
 * Returns an object of Maps: { colors, spacing, fontSizes, fontFamilies,
 *   fontWeights, lineHeights, letterSpacings, radii, borderWidths, opacities }
 */
function extractRawValues(node, acc) {
  if (!acc) {
    acc = {
      colors:        new Map(), // css string → count
      spacing:       new Map(), // number → count
      fontSizes:     new Map(),
      fontFamilies:  new Map(),
      fontWeights:   new Map(),
      lineHeights:   new Map(),
      letterSpacings:new Map(),
      radii:         new Map(),
      borderWidths:  new Map(),
      opacities:     new Map(),
    };
  }
  if (!node) return acc;

  // Fills
  if (Array.isArray(node.fills)) {
    for (const f of node.fills) {
      if (f.color) tally(acc.colors, f.color);
    }
  }

  // Stroke
  if (node.stroke) {
    if (node.stroke.color)  tally(acc.colors,       node.stroke.color);
    if (node.stroke.weight) tally(acc.borderWidths,  node.stroke.weight);
  }

  // Effects (shadow/blur colors)
  if (Array.isArray(node.effects)) {
    for (const e of node.effects) {
      if (e.color) tally(acc.colors, e.color);
    }
  }

  // Layout
  if (node.layout) {
    if (node.layout.gap != null) tally(acc.spacing, node.layout.gap);
    if (node.layout.padding) {
      for (const v of Object.values(node.layout.padding)) {
        if (v != null) tally(acc.spacing, v);
      }
    }
  }

  // Corner radius
  if (typeof node.cornerRadius === 'number') tally(acc.radii, node.cornerRadius);

  // Opacity
  if (typeof node.opacity === 'number') tally(acc.opacities, node.opacity);

  // Text style
  if (node.textStyle) {
    const ts = node.textStyle;
    if (ts.color)        tally(acc.colors,         ts.color);
    if (ts.fontSize)     tally(acc.fontSizes,      ts.fontSize);
    if (ts.fontFamily)   tally(acc.fontFamilies,   ts.fontFamily);
    if (ts.fontWeight)   tally(acc.fontWeights,    ts.fontWeight);
    if (ts.lineHeight)   tally(acc.lineHeights,    ts.lineHeight);
    if (ts.letterSpacing != null) tally(acc.letterSpacings, ts.letterSpacing);
  }

  // Recurse
  if (Array.isArray(node.children)) {
    for (const child of node.children) extractRawValues(child, acc);
  }
  return acc;
}

// ── Token table builder ───────────────────────────────────────────────────────

/**
 * Build the token table from raw value maps.
 *
 * @param {object} raw        Output of extractRawValues().
 * @param {object} [opts]
 * @param {number} [opts.minFreq=2]   Min occurrences to become a token.
 * @param {boolean}[opts.allSpacing]  Include single-occurrence spacing too.
 * @returns {object} tokenTable — nested {category: {'--var-name': value}}
 */
function buildTokenTable(raw, opts = {}) {
  const minFreq = opts.minFreq ?? 2;

  const colorUsed    = new Set();
  const colorCache   = new Map(); // css → name (for consistency)
  const fontSizeUsed = new Set();
  const radiiSeen    = new Set();

  const table = {
    colors:        {},
    spacing:       {},
    fontSizes:     {},
    fontFamilies:  {},
    fontWeights:   {},
    lineHeights:   {},
    letterSpacings:{},
    radii:         {},
    borderWidths:  {},
  };

  // Colors — all colours with freq ≥ minFreq, plus singletons used by stroke/effect
  for (const [css, count] of raw.colors) {
    if (count < minFreq) continue;
    const name = nameColor(css, colorUsed, colorCache);
    table.colors[`--${name}`] = css;
  }

  // Spacing — all spacing values (often many singletons for padding)
  const spacingMin = opts.allSpacing ? 1 : minFreq;
  for (const [value, count] of raw.spacing) {
    if (count < spacingMin) continue;
    const varName = `--${nameSpacing(value)}`;
    table.spacing[varName] = value;
  }

  // Font sizes — all (they're small in number, all useful)
  for (const [value] of raw.fontSizes) {
    const name = nameFontSize(value, fontSizeUsed);
    table.fontSizes[`--${name}`] = value;
  }

  // Font families — all
  for (const [value] of raw.fontFamilies) {
    const slug = value.toLowerCase().replace(/\s+/g, '-');
    table.fontFamilies[`--font-${slug}`] = value;
  }

  // Font weights — all
  const weightNames = { 400: 'regular', 500: 'medium', 600: 'semibold', 700: 'bold', 800: 'extrabold', 300: 'light' };
  for (const [value] of raw.fontWeights) {
    const name = weightNames[value] || `w${value}`;
    table.fontWeights[`--font-${name}`] = value;
  }

  // Border widths — all
  for (const [value, count] of raw.borderWidths) {
    if (count < minFreq) continue;
    table.borderWidths[`--border-${value}`] = value;
  }

  // Corner radii — all (small set, all useful)
  for (const [value] of raw.radii) {
    if (radiiSeen.has(value)) continue;
    radiiSeen.add(value);
    const name = nameRadius(value);
    table.radii[`--${name}`] = value;
  }

  // Line heights — with freq ≥ 2 (lots of one-offs)
  for (const [value, count] of raw.lineHeights) {
    if (count < minFreq) continue;
    table.lineHeights[`--leading-${value}`] = value;
  }

  return table;
}

// ── IR annotation ─────────────────────────────────────────────────────────────

/**
 * Build a reverse lookup: raw value → CSS var name, per category.
 * Used by annotateIR to do O(1) replacements.
 */
function buildLookup(table) {
  const lookup = { colors: new Map(), spacing: new Map(), fontSizes: new Map(),
    fontFamilies: new Map(), fontWeights: new Map(), radii: new Map(), borderWidths: new Map() };

  for (const [varName, value] of Object.entries(table.colors))
    lookup.colors.set(String(value), varName);
  for (const [varName, value] of Object.entries(table.spacing))
    lookup.spacing.set(String(value), varName);
  for (const [varName, value] of Object.entries(table.fontSizes))
    lookup.fontSizes.set(String(value), varName);
  for (const [varName, value] of Object.entries(table.fontFamilies))
    lookup.fontFamilies.set(String(value), varName);
  for (const [varName, value] of Object.entries(table.fontWeights))
    lookup.fontWeights.set(String(value), varName);
  for (const [varName, value] of Object.entries(table.radii))
    lookup.radii.set(String(value), varName);
  for (const [varName, value] of Object.entries(table.borderWidths))
    lookup.borderWidths.set(String(value), varName);

  return lookup;
}

/** Replace a raw value with "$<varName>" if it exists in the lookup map. */
function ref(map, value) {
  const key = String(value);
  return map.has(key) ? `$${map.get(key)}` : value;
}

/** Annotate one node with token references. Returns new node (immutable). */
function annotateNode(node, lk) {
  let n = { ...node };

  // Fills
  if (Array.isArray(n.fills)) {
    n.fills = n.fills.map((f) =>
      f.color ? { ...f, color: ref(lk.colors, f.color) } : f
    );
  }

  // Stroke
  if (n.stroke) {
    n.stroke = {
      ...n.stroke,
      color:  n.stroke.color  ? ref(lk.colors,       n.stroke.color)  : n.stroke.color,
      weight: n.stroke.weight ? ref(lk.borderWidths,  n.stroke.weight) : n.stroke.weight,
    };
  }

  // Effects
  if (Array.isArray(n.effects)) {
    n.effects = n.effects.map((e) =>
      e.color ? { ...e, color: ref(lk.colors, e.color) } : e
    );
  }

  // Layout
  if (n.layout) {
    n.layout = { ...n.layout };
    if (n.layout.gap != null) n.layout.gap = ref(lk.spacing, n.layout.gap);
    if (n.layout.padding) {
      n.layout.padding = Object.fromEntries(
        Object.entries(n.layout.padding).map(([side, v]) =>
          [side, v != null ? ref(lk.spacing, v) : v]
        )
      );
    }
  }

  // Corner radius
  if (typeof n.cornerRadius === 'number') {
    n.cornerRadius = ref(lk.radii, n.cornerRadius);
  }

  // Text style
  if (n.textStyle) {
    n.textStyle = {
      ...n.textStyle,
      color:      n.textStyle.color      ? ref(lk.colors,       n.textStyle.color)      : n.textStyle.color,
      fontSize:   n.textStyle.fontSize   ? ref(lk.fontSizes,    n.textStyle.fontSize)   : n.textStyle.fontSize,
      fontFamily: n.textStyle.fontFamily ? ref(lk.fontFamilies, n.textStyle.fontFamily) : n.textStyle.fontFamily,
      fontWeight: n.textStyle.fontWeight ? ref(lk.fontWeights,  n.textStyle.fontWeight) : n.textStyle.fontWeight,
    };
  }

  // Recurse
  if (Array.isArray(n.children)) {
    n.children = n.children.map((c) => annotateNode(c, lk));
  }

  return n;
}

/**
 * Walk the pruned IR and replace raw values with "$--var-name" token references.
 *
 * @param {object} ir         Pruned IR root.
 * @param {object} tokenTable Output of buildTokenTable().
 * @returns {object}          Annotated IR (new object, original unchanged).
 */
function annotateIR(ir, tokenTable) {
  const lk = buildLookup(tokenTable);
  return annotateNode(ir, lk);
}

// ── CSS output ────────────────────────────────────────────────────────────────

/**
 * Render the token table as a CSS :root block.
 *
 * @param {object} tokenTable
 * @returns {string}  e.g. ":root {\n  --color-primary: #0dccf2;\n  ...\n}"
 */
function toCssVars(tokenTable) {
  const lines = [];
  const categories = [
    ['colors',        (v) => v],
    ['spacing',       (v) => `${v}px`],
    ['fontSizes',     (v) => `${v}px`],
    ['fontFamilies',  (v) => v],
    ['fontWeights',   (v) => String(v)],
    ['lineHeights',   (v) => `${v}px`],
    ['radii',         (v) => v >= 9999 ? '9999px' : `${v}px`],
    ['borderWidths',  (v) => `${v}px`],
  ];

  for (const [cat, fmt] of categories) {
    const entries = Object.entries(tokenTable[cat] || {});
    if (!entries.length) continue;
    lines.push(`  /* ${cat} */`);
    for (const [varName, value] of entries) {
      lines.push(`  ${varName}: ${fmt(value)};`);
    }
    lines.push('');
  }
  return `:root {\n${lines.join('\n')}}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the full Phase 2 tokenisation pipeline on a pruned IR.
 *
 * @param {object} ir     Pruned IR from Phase 1.
 * @param {object} [opts]
 * @param {number} [opts.minFreq=2]     Frequency threshold for tokens.
 * @param {boolean}[opts.annotate=true] Add token references to IR.
 * @param {boolean}[opts.resolveVars=true] Attempt to resolve _strokeUnresolved via varmap.
 * @returns {{
 *   tokenTable: object,
 *   cssVars: string,
 *   annotatedIR: object,
 *   varMap: Map,
 *   stats: object
 * }}
 */
function tokenize(ir, opts = {}) {
  const {
    minFreq = 2,
    annotate = true,
    resolveVars = true,
    allSpacing = false,
  } = opts;

  // 1. Build variable alias map (correlates boundVariables IDs with values)
  const varMap = buildVarMap(ir);

  // 2. Resolve unresolved strokes via varmap
  const resolvedIR = resolveVars ? resolveStrokes(ir, varMap) : ir;

  // 3. Frequency analysis
  const raw = extractRawValues(resolvedIR);

  // 4. Build token table
  const tokenTable = buildTokenTable(raw, { minFreq, allSpacing });

  // 5. Generate CSS vars
  const cssVars = toCssVars(tokenTable);

  // 6. Annotate IR
  const annotatedIR = annotate ? annotateIR(resolvedIR, tokenTable) : resolvedIR;

  // 7. Stats
  const stats = {
    varMapSize:    varMap.size,
    uniqueColors:  raw.colors.size,
    tokenColors:   Object.keys(tokenTable.colors).length,
    uniqueSpacing: raw.spacing.size,
    tokenSpacing:  Object.keys(tokenTable.spacing).length,
    fontFamilies:  Object.keys(tokenTable.fontFamilies).length,
    fontSizes:     Object.keys(tokenTable.fontSizes).length,
    radii:         Object.keys(tokenTable.radii).length,
  };

  return { tokenTable, cssVars, annotatedIR, varMap, stats };
}

// ── Tailwind theme output (Phase 2 addon) ─────────────────────────────────────

/**
 * Convert a tokenTable into a Tailwind CSS theme.extend object.
 *
 * Usage in tailwind.config.js:
 *   module.exports = { theme: { extend: require('./tailwind-theme.json') } }
 *
 * @param {object} tokenTable  Output of buildTokenTable().
 * @returns {object}           theme.extend-compatible object.
 */
function toTailwindTheme(tokenTable) {
  if (!tokenTable) return {};

  // Helper: strip the CSS var prefix for Tailwind keys
  // '--color-primary' → 'primary', '--spacing-8' → '8', '--text-base' → 'base'
  function stripPrefix(varName, prefix) {
    return varName.replace(new RegExp(`^--${prefix}-?`), '');
  }

  // Colors: '--color-*' → colors: { primary: '#hex', ... }
  const colors = {};
  for (const [varName, value] of Object.entries(tokenTable.colors || {})) {
    const key = stripPrefix(varName, 'color');
    colors[key || varName] = value;
  }

  // Spacing: '--spacing-8' → spacing: { '8': '8px', ... }
  const spacing = {};
  for (const [varName, value] of Object.entries(tokenTable.spacing || {})) {
    const key = stripPrefix(varName, 'spacing');
    spacing[key || varName] = `${value}px`;
  }

  // Font sizes: '--text-*' → fontSize: { base: '14px', ... }
  const fontSize = {};
  for (const [varName, value] of Object.entries(tokenTable.fontSizes || {})) {
    const key = stripPrefix(varName, 'text');
    fontSize[key || varName] = `${value}px`;
  }

  // Font families: '--font-inter' → fontFamily: { inter: ['Inter', 'sans-serif'], ... }
  const fontFamily = {};
  for (const [varName, value] of Object.entries(tokenTable.fontFamilies || {})) {
    const key = stripPrefix(varName, 'font');
    fontFamily[key || varName] = [value, 'sans-serif'];
  }

  // Border radius: '--radius-*' → borderRadius: { md: '14px', ... }
  const borderRadius = {};
  for (const [varName, value] of Object.entries(tokenTable.radii || {})) {
    const key = stripPrefix(varName, 'radius');
    borderRadius[key || varName] = value >= 9999 ? '9999px' : `${value}px`;
  }

  // Border widths: '--border-*' → borderWidth: { '1': '1px', ... }
  const borderWidth = {};
  for (const [varName, value] of Object.entries(tokenTable.borderWidths || {})) {
    const key = stripPrefix(varName, 'border');
    borderWidth[key || varName] = `${value}px`;
  }

  return {
    ...(Object.keys(colors).length       ? { colors }       : {}),
    ...(Object.keys(spacing).length      ? { spacing }      : {}),
    ...(Object.keys(fontSize).length     ? { fontSize }     : {}),
    ...(Object.keys(fontFamily).length   ? { fontFamily }   : {}),
    ...(Object.keys(borderRadius).length ? { borderRadius } : {}),
    ...(Object.keys(borderWidth).length  ? { borderWidth }  : {}),
  };
}

module.exports = { tokenize, extractRawValues, buildTokenTable, annotateIR, toCssVars, buildVarMap, toTailwindTheme };

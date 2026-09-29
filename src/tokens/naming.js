'use strict';

/**
 * Token naming helpers for Phase 2.
 *
 * Color naming strategy: HSL-based classification → semantic name.
 * Spacing / font-size / radius: value-based scale names (spacing-4, text-sm, etc.)
 * Collision handling: append numeric suffix (-2, -3) when names clash.
 */

// ── Color parsing ─────────────────────────────────────────────────────────────

/** Parse "#rrggbb" or "#rgb" → {r,g,b} (0-255). Returns null on failure. */
function hexToRgb(hex) {
  const s = hex.replace('#', '');
  if (s.length === 3) {
    return {
      r: parseInt(s[0] + s[0], 16),
      g: parseInt(s[1] + s[1], 16),
      b: parseInt(s[2] + s[2], 16),
    };
  }
  if (s.length === 6) {
    return {
      r: parseInt(s.slice(0, 2), 16),
      g: parseInt(s.slice(2, 4), 16),
      b: parseInt(s.slice(4, 6), 16),
    };
  }
  return null;
}

/** Parse "rgba(r,g,b,a)" or "rgb(r,g,b)" → {r,g,b,a}. Returns null on failure. */
function parseRgba(str) {
  const m = str.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/);
  if (!m) return null;
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] !== undefined ? +m[4] : 1 };
}

/**
 * Parse any CSS color string this IR may contain.
 * Returns {r, g, b, a} (0-255 channels, a 0-1) or null.
 */
function parseColor(css) {
  if (!css || typeof css !== 'string') return null;
  if (css.startsWith('#')) {
    const rgb = hexToRgb(css);
    return rgb ? { ...rgb, a: 1 } : null;
  }
  if (css.startsWith('rgb')) return parseRgba(css);
  return null;
}

/** RGB (0-255) → HSL (h: 0-360, s: 0-100, l: 0-100). */
function rgbToHsl(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn)      h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else                 h = ((rn - gn) / d + 4) / 6;
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

// ── Color classification ──────────────────────────────────────────────────────

/**
 * Classify a parsed color → a base semantic name (without suffix).
 *
 * Design-system aware:
 *   Cyan   (H 175-210, S>60) → primary
 *   Purple (H 255-295, S>60) → purple / accent
 *   Amber  (H 30-55,  S>80) → amber
 *   Near-black (L<6)        → bg
 *   Very dark (L 6-20)      → surface
 *   Mid-gray (L 40-65, S<15)→ muted / border
 *   Near-white (L>90, S<20) → text
 *   White  (L>97)           → white
 *   Semi-transparent (a<1)  → overlay / glass
 */
function classifyColor({ r, g, b, a }) {
  const { h, s, l } = rgbToHsl(r, g, b);

  // Semi-transparent surfaces — classify by alpha tier
  if (a < 0.999) {
    if (a < 0.08) return 'glass-subtle';
    if (a < 0.20) return 'glass';
    if (a < 0.50) return 'overlay';
    return 'overlay-strong';
  }

  // Achromatic / very low saturation
  if (s < 12) {
    if (l < 6)  return 'bg';
    if (l < 18) return 'surface';
    if (l < 35) return 'surface-mid';
    if (l < 60) return 'border';
    if (l < 90) return 'muted';
    if (l < 99) return 'text';   // #fafafa (L≈98) is text, #ffffff (L=100) is white
    return 'white';
  }

  // Chromatic — classify by hue
  if (h >= 175 && h <= 210 && s > 60) return 'primary';    // #0dccf2, #00d3f2
  if (h >= 210 && h <= 245 && s > 50) return 'blue';
  if (h >= 245 && h <= 295 && s > 50) return 'purple';     // #a684ff, #4f39f6, #7f22fe
  if (h >= 295 && h <= 340 && s > 50) return 'pink';
  if (h >= 30  && h <= 55  && s > 70) return 'amber';      // #ffb900
  if (h >= 55  && h <= 155 && s > 50) return 'green';
  if (h >= 0   && h < 30   && s > 50) return 'red';
  if (h >= 340)                         return 'red';

  // Fallback: use lightness zone
  if (l < 6)  return 'bg';
  if (l < 30) return 'surface';
  if (l < 65) return 'muted';
  return 'text';
}

/**
 * Generate a unique token name for a color, deduplicating against `used`.
 *
 * @param {string}      css     Raw CSS color string.
 * @param {Set<string>} used    Already-taken names (mutated to include new name).
 * @param {Map}         cache   css→name memo so same color always gets same name.
 * @returns {string}  e.g. "color-primary", "color-purple-2"
 */
function nameColor(css, used, cache) {
  if (cache.has(css)) return cache.get(css);

  const parsed = parseColor(css);
  const base = parsed ? `color-${classifyColor(parsed)}` : 'color-unknown';

  let name = base;
  let i = 2;
  while (used.has(name)) name = `${base}-${i++}`;

  used.add(name);
  cache.set(css, name);
  return name;
}

// ── Spacing / size naming ─────────────────────────────────────────────────────

/**
 * Name a spacing value (gap, padding, etc.) as "spacing-{value}".
 * Uses raw pixel value so the name is self-documenting and collision-free.
 */
function nameSpacing(value) {
  return `spacing-${value}`;
}

/**
 * Name a font-size value.
 * Maps known sizes to readable aliases; unknown sizes get numeric name.
 */
const FONT_SIZE_ALIASES = new Map([
  [10, 'text-xs'],
  [11, 'text-xs'],       // same tier
  [12, 'text-sm'],
  [14, 'text-base'],
  [16, 'text-md'],
  [18, 'text-lg'],
  [20, 'text-xl'],
  [24, 'text-2xl'],
  [32, 'text-3xl'],
  [48, 'text-4xl'],
  [64, 'text-5xl'],
  [72, 'text-6xl'],
]);

function nameFontSize(value, used) {
  const alias = FONT_SIZE_ALIASES.get(value);
  let base = alias || `text-${value}`;
  let name = base;
  let i = 2;
  while (used.has(name)) name = `${base}-${i++}`;
  used.add(name);
  return name;
}

/**
 * Name a border-radius value.
 * Very large values (≥ 9999) → "radius-full" (Figma's pill trick).
 */
function nameRadius(value) {
  if (value >= 9999) return 'radius-full';
  if (value < 1) return `radius-${String(value).replace('.', '_')}`;
  return `radius-${Math.round(value)}`;
}

module.exports = {
  parseColor,
  rgbToHsl,
  classifyColor,
  nameColor,
  nameSpacing,
  nameFontSize,
  nameRadius,
};

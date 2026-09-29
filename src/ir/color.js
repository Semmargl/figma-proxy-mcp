'use strict';

/**
 * Color helpers for the IR layer.
 *
 * IMPORTANT design decision (fixes the v1 bug where missing colors became
 * "#000000"): when a color is absent we return `null`, never a fake black.
 * Callers must omit the field entirely when this returns null, so a transparent
 * / fill-less node is never painted black downstream.
 */

/** Clamp a 0..1 channel to a two-digit hex byte. */
function channelToHex(x) {
  const v = Math.round(Math.max(0, Math.min(1, x)) * 255);
  return v.toString(16).padStart(2, '0');
}

/**
 * Convert a Figma RGBA color object to a CSS string, or null if absent.
 * @param {{r:number,g:number,b:number,a?:number}|undefined|null} color
 * @param {number} [layerOpacity] optional fill/layer opacity multiplier (0..1)
 * @returns {string|null} "#rrggbb", "rgba(r,g,b,a)", or null
 */
function colorToCss(color, layerOpacity) {
  if (!color || typeof color.r !== 'number') return null;
  const alpha = (typeof color.a === 'number' ? color.a : 1) *
                (typeof layerOpacity === 'number' ? layerOpacity : 1);
  const hex = `#${channelToHex(color.r)}${channelToHex(color.g)}${channelToHex(color.b)}`;
  if (alpha >= 0.999) return hex;
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  return `rgba(${r}, ${g}, ${b}, ${Number(alpha.toFixed(3))})`;
}

/**
 * Summarise a Figma fills[] array into a compact, null-safe representation.
 * Handles solid, gradient and image fills. Returns null when there is no
 * visible fill at all (so the field can be omitted from the IR).
 * @param {Array|undefined} fills
 * @returns {Array<object>|null}
 */
function summariseFills(fills) {
  if (!Array.isArray(fills) || fills.length === 0) return null;
  const out = [];
  for (const f of fills) {
    if (f.visible === false) continue;
    const opacity = typeof f.opacity === 'number' ? f.opacity : 1;
    if (f.type === 'SOLID') {
      const css = colorToCss(f.color, opacity);
      if (css) out.push({ type: 'solid', color: css });
    } else if (typeof f.type === 'string' && f.type.startsWith('GRADIENT')) {
      out.push({
        type: 'gradient',
        gradient: f.type.replace('GRADIENT_', '').toLowerCase(),
        stops: Array.isArray(f.gradientStops)
          ? f.gradientStops.map((s) => ({
              position: s.position,
              color: colorToCss(s.color),
            }))
          : undefined,
      });
    } else if (f.type === 'IMAGE') {
      out.push({ type: 'image', imageRef: f.imageRef, scaleMode: f.scaleMode });
    }
  }
  return out.length ? out : null;
}

module.exports = { colorToCss, summariseFills, channelToHex };

'use strict';

/**
 * Flat IR extract (format:'flat').
 *
 * Turns the nested annotated IR into a FLAT array of compact node records with
 * only render-relevant fields and coordinates RELATIVE to the root frame. This
 * exists so the agent never has to hand-read a multi-thousand-line nested JSON
 * tree (the cause of context loss + layout misreads). A flat list is smaller
 * than the nested tree (no structural nesting overhead) and machine-consumable.
 *
 * Each record: { id, type, name, parent?, order?, rel?:{x,y,w,h}, text?, font?,
 *                fills?, stroke?, radius?, layout?, opacity? }
 * Colours/spacing/fonts keep their $--var references from tokenisation.
 */

const { clean } = require('./transform');

function round(n) {
  return typeof n === 'number' ? Math.round(n * 100) / 100 : undefined;
}

/**
 * @param {object} root annotated IR root node (its box is the origin)
 * @returns {Array<object>} flat list of compact node records
 */
function flattenIR(root) {
  const rb = (root && root.box) || {};
  const rx = typeof rb.x === 'number' ? rb.x : 0;
  const ry = typeof rb.y === 'number' ? rb.y : 0;
  const out = [];

  function walk(node, parentId, order) {
    if (!node) return;
    const b = node.box || {};
    const rec = clean({
      id: node.id,
      type: node.type,
      name: node.name,
      parent: parentId || undefined,
      order: typeof order === 'number' ? order : undefined,
      rel: typeof b.x === 'number'
        ? clean({ x: round(b.x - rx), y: round(b.y - ry), w: b.w, h: b.h })
        : undefined,
      text: node.text,
      font: node.textStyle
        ? clean({
            family: node.textStyle.fontFamily,
            size: node.textStyle.fontSize,
            weight: node.textStyle.fontWeight,
            color: node.textStyle.color,
            lineHeight: node.textStyle.lineHeight,
            align: node.textStyle.align,
          })
        : undefined,
      fills: node.fills,        // already $--var / rgba
      stroke: node.stroke,      // { color, weight }
      radius: node.cornerRadius,
      layout: node.layout,      // { mode, gap, padding, ... }
      opacity: node.opacity,
      _strokeUnresolved: node._strokeUnresolved,
      _multicolor: node._multicolor,
      _pruned: node._pruned,
    });
    out.push(rec);
    if (Array.isArray(node.children)) {
      node.children.forEach((c, i) => walk(c, node.id, i));
    }
  }

  walk(root, null, undefined);
  return out;
}

module.exports = { flattenIR };

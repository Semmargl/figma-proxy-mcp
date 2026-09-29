'use strict';

/**
 * Phase 5 — Visual verification (verify_render).
 *
 * Deterministic "is the rendered HTML close to the Figma design?" check.
 * MEASUREMENT ONLY: returns numbers + diff regions. It does NOT regenerate code
 * or drive an autonomous loop — the agent reads the regions and decides.
 *
 * Pipeline:
 *   renderHtml()    Playwright headless Chromium → screenshot of the HTML file
 *                   (runs INSIDE this MCP process — does NOT depend on the user's
 *                    Chrome / Control_Chrome being open).
 *   compareBuffers() pngjs + pixelmatch → pixel diff %, windowed SSIM,
 *                    clustered diff regions (bounding boxes of disagreement).
 *
 * Heavy deps (playwright) are required LAZILY so ordinary data tools
 * (get_figma_component etc.) never pay the load cost.
 */

const fs = require('fs');
const path = require('path');

// ── HTML render (lazy Playwright) ─────────────────────────────────────────────

/**
 * Render an HTML file to a PNG buffer with headless Chromium.
 * @param {string} htmlPath absolute path to the .html file
 * @param {{frameWidth:number, scale?:number, maxHeight?:number}} opts
 * @returns {Promise<Buffer>} PNG buffer (width = frameWidth * scale)
 */
async function renderHtml(htmlPath, opts = {}) {
  const frameWidth = opts.frameWidth || 1440;
  const scale = opts.scale || 2;

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    throw new Error(
      'playwright is not installed. Run `npm install` in proxy-mcp and ' +
      '`npx playwright install chromium`, then retry verify_render.'
    );
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: frameWidth, height: 900 },
      deviceScaleFactor: scale,
    });
    const page = await context.newPage();
    const fileUrl = 'file://' + path.resolve(htmlPath);
    await page.goto(fileUrl, { waitUntil: 'networkidle' });
    // Give web fonts / late layout a beat.
    await page.waitForTimeout(300);
    const buf = await page.screenshot({ fullPage: true, type: 'png' });
    return buf;
  } finally {
    await browser.close();
  }
}

// ── Image helpers (pngjs) ─────────────────────────────────────────────────────

function readPng(buffer) {
  const { PNG } = require('pngjs');
  return PNG.sync.read(buffer);
}

function writePng(png) {
  const { PNG } = require('pngjs');
  return PNG.sync.write(png);
}

/** Crop an RGBA PNG object to the top-left W×H region (new buffer). */
function cropTo(png, W, H) {
  const { PNG } = require('pngjs');
  const out = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const si = (png.width * y + x) << 2;
      const di = (W * y + x) << 2;
      out.data[di] = png.data[si];
      out.data[di + 1] = png.data[si + 1];
      out.data[di + 2] = png.data[si + 2];
      out.data[di + 3] = png.data[si + 3];
    }
  }
  return out;
}

/** Crop an RGBA PNG to an arbitrary sub-rectangle (new buffer). */
function cropRect(png, px, py, W, H) {
  const { PNG } = require('pngjs');
  const out = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const si = (png.width * (py + y) + (px + x)) << 2;
      const di = (W * y + x) << 2;
      out.data[di] = png.data[si];
      out.data[di + 1] = png.data[si + 1];
      out.data[di + 2] = png.data[si + 2];
      out.data[di + 3] = png.data[si + 3];
    }
  }
  return out;
}

/** Composite RGBA pixels onto an opaque background in place (alpha → bg blend). */
function flattenAlpha(data, bg) {
  const [br, bg_, bb] = bg;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    if (a >= 1) continue;
    data[i]     = Math.round(data[i] * a + br * (1 - a));
    data[i + 1] = Math.round(data[i + 1] * a + bg_ * (1 - a));
    data[i + 2] = Math.round(data[i + 2] * a + bb * (1 - a));
    data[i + 3] = 255;
  }
}

/** Mean SSIM over non-overlapping 8×8 grayscale windows. */
function meanSSIM(aData, bData, W, H) {
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const win = 8;
  const gray = (data, i) =>
    0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

  let total = 0;
  let count = 0;
  for (let wy = 0; wy + win <= H; wy += win) {
    for (let wx = 0; wx + win <= W; wx += win) {
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      const n = win * win;
      for (let y = 0; y < win; y++) {
        for (let x = 0; x < win; x++) {
          const idx = ((wy + y) * W + (wx + x)) << 2;
          const ga = gray(aData, idx);
          const gb = gray(bData, idx);
          sa += ga; sb += gb;
          saa += ga * ga; sbb += gb * gb; sab += ga * gb;
        }
      }
      const muA = sa / n, muB = sb / n;
      const varA = saa / n - muA * muA;
      const varB = sbb / n - muB * muB;
      const cov = sab / n - muA * muB;
      const ssim =
        ((2 * muA * muB + C1) * (2 * cov + C2)) /
        ((muA * muA + muB * muB + C1) * (varA + varB + C2));
      total += ssim;
      count++;
    }
  }
  return count ? total / count : 1;
}

/**
 * Cluster diff pixels (alpha-flagged in the pixelmatch output) into bounding
 * boxes via a coarse cell grid + flood fill. Coords returned in LOGICAL pixels
 * (divided by `scale`) for agent-friendliness.
 */
function clusterRegions(diffData, W, H, scale, cell = 32, maxRegions = 12) {
  const cols = Math.ceil(W / cell);
  const rows = Math.ceil(H / cell);
  const counts = new Int32Array(cols * rows);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) << 2;
      // pixelmatch paints diffs red with full alpha; treat strong red as diff
      if (diffData[i] > 200 && diffData[i + 1] < 100 && diffData[i + 3] > 0) {
        counts[(Math.floor(y / cell)) * cols + Math.floor(x / cell)]++;
      }
    }
  }
  const cellArea = cell * cell;
  const hot = new Uint8Array(cols * rows);
  for (let c = 0; c < counts.length; c++) {
    if (counts[c] / cellArea > 0.02) hot[c] = 1; // ≥2% — catches thin text/borders, not just solid fills
  }

  const seen = new Uint8Array(cols * rows);
  const regions = [];
  for (let r0 = 0; r0 < rows; r0++) {
    for (let c0 = 0; c0 < cols; c0++) {
      const start = r0 * cols + c0;
      if (!hot[start] || seen[start]) continue;
      // BFS flood fill over the hot-cell grid
      const stack = [start];
      seen[start] = 1;
      let minC = c0, maxC = c0, minR = r0, maxR = r0, diffPx = 0;
      while (stack.length) {
        const cur = stack.pop();
        const cc = cur % cols, cr = (cur - cc) / cols;
        diffPx += counts[cur];
        if (cc < minC) minC = cc; if (cc > maxC) maxC = cc;
        if (cr < minR) minR = cr; if (cr > maxR) maxR = cr;
        const neigh = [cur - 1, cur + 1, cur - cols, cur + cols];
        for (const nb of neigh) {
          if (nb < 0 || nb >= cols * rows || seen[nb] || !hot[nb]) continue;
          // avoid horizontal wrap
          if ((nb === cur - 1 && cc === 0) || (nb === cur + 1 && cc === cols - 1)) continue;
          seen[nb] = 1;
          stack.push(nb);
        }
      }
      regions.push({
        x: Math.round((minC * cell) / scale),
        y: Math.round((minR * cell) / scale),
        w: Math.round(((maxC - minC + 1) * cell) / scale),
        h: Math.round(((maxR - minR + 1) * cell) / scale),
        diffPixels: diffPx,
      });
    }
  }
  regions.sort((a, b) => b.diffPixels - a.diffPixels);
  return regions.slice(0, maxRegions);
}

// ── Region enrichment (so a browser-less agent can fix by numbers) ────────────

function hex(c) {
  return '#' + [0, 1, 2].map((k) => Math.round(c[k]).toString(16).padStart(2, '0')).join('');
}

/** Mean RGB over a pixel rectangle (clamped to bounds). */
function meanColor(data, W, H, px, py, pw, ph) {
  let r = 0, g = 0, b = 0, n = 0;
  const x1 = Math.max(0, px), y1 = Math.max(0, py);
  const x2 = Math.min(W, px + pw), y2 = Math.min(H, py + ph);
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      const i = (y * W + x) << 2;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
  }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}

/**
 * Annotate each diff region with rendered vs reference mean colour, the colour
 * delta, and a coarse type. region coords are LOGICAL px → multiply by scale to
 * index the pixel buffers. Mutates in place.
 */
function enrichRegions(regions, aData, bData, W, H, scale) {
  for (const reg of regions) {
    const mr  = meanColor(aData, W, H, reg.x * scale, reg.y * scale, reg.w * scale, reg.h * scale);
    const mrf = meanColor(bData, W, H, reg.x * scale, reg.y * scale, reg.w * scale, reg.h * scale);
    const dist = Math.round(Math.sqrt((mr[0] - mrf[0]) ** 2 + (mr[1] - mrf[1]) ** 2 + (mr[2] - mrf[2]) ** 2));
    reg.renderColor = hex(mr);
    reg.refColor = hex(mrf);
    reg.colorDelta = dist;
    // Large mean-colour gap → likely a wrong fill/text colour; otherwise a
    // position/size/text-render difference where colours roughly agree.
    reg.type = dist >= 40 ? 'color' : 'layout';
  }
  return regions;
}

// ── Compare ───────────────────────────────────────────────────────────────────

/**
 * Compare two PNG buffers. No Playwright needed — pure image math, so this is
 * unit-testable on its own.
 * @param {Buffer} renderBuf  rendered-HTML PNG
 * @param {Buffer} refBuf     reference (Figma) PNG
 * @param {{scale?:number, outDir?:string, label?:string}} opts
 * @returns {{ssim:number, pixelDiffPct:number, diffPixels:number,
 *            dims:{w:number,h:number}, diffImagePath:(string|null),
 *            diffRegions:Array}}
 */
function compareBuffers(renderBuf, refBuf, opts = {}) {
  const pixelmatch = require('pixelmatch');
  const { PNG } = require('pngjs');
  const scale = opts.scale || 2;

  let a = readPng(renderBuf);
  let b = readPng(refBuf);

  let W = Math.min(a.width, b.width);
  let H = Math.min(a.height, b.height);
  if (a.width !== W || a.height !== H) a = cropTo(a, W, H);
  if (b.width !== W || b.height !== H) b = cropTo(b, W, H);

  // Flatten alpha onto an opaque background BEFORE comparing. Figma PNGs are
  // frequently exported with a transparent background; the HTML render is opaque.
  // Without flattening, every "transparent vs solid" pixel reads as a full diff and
  // SSIM collapses to ~0.1 even when the layout matches perfectly. Default bg white;
  // pass opts.bg = [r,g,b] to match the design's real background.
  const bg = Array.isArray(opts.bg) ? opts.bg : [255, 255, 255];
  flattenAlpha(a.data, bg);
  flattenAlpha(b.data, bg);

  // F1: optional clip (logical px [x,y,w,h]) — compare only a sub-rectangle (e.g.
  // the content area) to exclude dead parent-canvas background that would otherwise
  // dominate the regions and mask real content diffs. Region coords are offset back
  // to full-frame logical space at the end.
  let offX = 0, offY = 0;
  if (Array.isArray(opts.clip) && opts.clip.length === 4) {
    const [cx, cy, cw, ch] = opts.clip;
    const px = Math.max(0, Math.round(cx * scale));
    const py = Math.max(0, Math.round(cy * scale));
    const pw = Math.min(W - px, Math.round(cw * scale));
    const ph = Math.min(H - py, Math.round(ch * scale));
    if (pw > 0 && ph > 0) {
      a = cropRect(a, px, py, pw, ph);
      b = cropRect(b, px, py, pw, ph);
      W = pw; H = ph; offX = cx; offY = cy;
    }
  }

  const diff = new PNG({ width: W, height: H });
  const diffPixels = pixelmatch(a.data, b.data, diff.data, W, H, {
    threshold: 0.1,
    includeAA: false,
  });

  const pixelDiffPct = diffPixels / (W * H);
  const ssim = meanSSIM(a.data, b.data, W, H);
  const diffRegions = clusterRegions(diff.data, W, H, scale);
  enrichRegions(diffRegions, a.data, b.data, W, H, scale);
  if (offX || offY) for (const r of diffRegions) { r.x += offX; r.y += offY; }

  // Writing the diff image is BEST-EFFORT: a bad/read-only outDir (e.g. the
  // server's cwd is not writable) must NOT fail the whole verification — the
  // numbers (ssim / pixelDiffPct / diffRegions) are the primary result. Try the
  // requested dir, then fall back to the OS temp dir, then give up gracefully.
  let diffImagePath = null;
  if (opts.outDir) {
    const name = (opts.label || 'verify') + '-diff.png';
    const candidates = [opts.outDir, path.join(require('os').tmpdir(), 'figma-verify')];
    for (const dir of candidates) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const p = path.join(dir, name);
        fs.writeFileSync(p, writePng(diff));
        diffImagePath = p;
        break;
      } catch (e) {
        diffImagePath = null; // try the next candidate
      }
    }
  }

  return {
    ssim: Number(ssim.toFixed(4)),
    pixelDiffPct: Number((pixelDiffPct * 100).toFixed(3)),
    diffPixels,
    dims: { w: W, h: H },
    diffImagePath,
    diffRegions,
  };
}

/**
 * Full verify: render the HTML, then compare against a reference PNG buffer.
 * @param {{htmlPath:string, referencePngBuffer:Buffer, frameWidth:number,
 *          scale?:number, outDir?:string, label?:string, threshold?:number}} opts
 */
async function verifyRender(opts) {
  const { htmlPath, referencePngBuffer, frameWidth } = opts;
  const scale = opts.scale || 2;
  const threshold = opts.threshold ?? 0.95;
  if (!htmlPath || !referencePngBuffer || !frameWidth) {
    throw new Error('verifyRender requires htmlPath, referencePngBuffer and frameWidth');
  }
  const renderBuf = await renderHtml(htmlPath, { frameWidth, scale });
  const result = compareBuffers(renderBuf, referencePngBuffer, {
    scale,
    outDir: opts.outDir,
    label: opts.label,
    bg: opts.bg,
    clip: opts.clip,
  });
  result.pass = result.ssim >= threshold;
  result.threshold = threshold;
  return result;
}

module.exports = { verifyRender, compareBuffers, renderHtml, meanSSIM, clusterRegions, flattenAlpha, enrichRegions };

'use strict';

/**
 * Text returned in the MCP `initialize` response (`instructions` field).
 * MCP clients may show it to the model as server-level guidance. Keep it short
 * and generic: it describes how to use the tools, not any particular project.
 */
const INSTRUCTIONS = [
  'figma-proxy-mcp: read-only Figma -> code tools. Recommended workflow:',
  '1. Links must contain node-id (in Figma: right-click a frame -> Copy link to selection). A file link without node-id cannot be used with get_figma_component / render_node_png / verify_render.',
  '2. Summary first: get_figma_component {figmaUrl, summary:true}. Keep its CSS variables, Tailwind theme and component registry, the root box (frameWidth = root w) and the sections list with relativeBox.',
  '3. Fetch each section by its own node link: get_figma_component {figmaUrl, format:"flat", lean:true}. lean omits the global token blocks you already have; flat gives render fields with coords relative to the root. Do not fetch the whole frame as a nested tree.',
  '4. Build the markup from the flat records, using the $--var tokens and relativeBox for layout. Export icons with export_svg when needed.',
  '5. Get the reference image: render_node_png {figmaUrl, scale:2}.',
  '6. Verify: write a self-contained HTML file, then verify_render {htmlPath (absolute), frameWidth, figmaUrl, scale:2}. Fix only the reported diff regions and repeat until SSIM >= threshold (default 0.95) or pixel diff stops improving. For dark designs pass bg; use clip to exclude dead margins.',
  'The server never modifies Figma files. verify_render needs Playwright Chromium (npx playwright install chromium).',
].join('\n');

module.exports = { INSTRUCTIONS };

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
  '6. Verify: write a self-contained HTML document, then verify_render {htmlPath (absolute) OR html (the document itself), frameWidth, figmaUrl, scale:2}. Fix only the reported diff regions and repeat until SSIM >= threshold (default 0.95) or pixel diff stops improving. For dark designs pass bg; use clip to exclude dead margins. Pass returnImage:true to also get the diff image.',
  'The server never modifies Figma files. verify_render needs Playwright Chromium (npx playwright install chromium).',
].join('\n');

// Hosted (remote) variant: the server cannot see the client's disk, so HTML is
// sent inline and SVGs / diff images come back in the response.
const HOSTED_INSTRUCTIONS = INSTRUCTIONS
  .replace(/verify_render \{htmlPath \(absolute\) OR html \(the document itself\)/, 'verify_render {html (the full self-contained document as a string)')
  .replace(' Pass returnImage:true to also get the diff image.', ' The diff image is returned inline.')
  + '\nThis is a hosted server: it cannot read or write files on your machine. Send HTML inline (html), save returned SVGs yourself.';

function getInstructions(hosted) {
  return hosted ? HOSTED_INSTRUCTIONS : INSTRUCTIONS;
}

module.exports = { INSTRUCTIONS, HOSTED_INSTRUCTIONS, getInstructions };

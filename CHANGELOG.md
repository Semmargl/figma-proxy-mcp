# Changelog

## 1.2.0

### Added
- `verify_render` accepts `html` (the full HTML document as a string) as an alternative to
  `htmlPath`; exactly one of the two is required. Inline HTML is written to a private temp
  dir and removed after the render.
- `verify_render` `returnImage: true` attaches the diff image as MCP image content (PNG,
  downscaled to logical px so responses stay small; diff pixels are preserved).
- `export_svg` / `migrate_all_svgs` `inline: true` return the full SVG markup in the
  response (`structuredContent`) instead of a preview / file paths. `migrate_all_svgs`
  gets `maxIcons`.
- Hosted mode (`FIGMA_PROXY_HOSTED=1`) for running the server as a shared/remote service:
  the token comes per request (`x-figma-token` header or `figmaToken` query parameter),
  `FIGMA_API_KEY` and `.env` are ignored, filesystem parameters (`htmlPath`, `figmaPngPath`,
  `outDir`, `outputDir`, `save`, `fileName`) are hidden from `tools/list` and rejected,
  writes stay in the OS temp dir, SVGs and diff images are returned inline, and the
  render of caller HTML may only load the page itself, `data:` URLs and public `https` URLs.
- HTTP mode accepts a per-request token in the `x-figma-token` header.
- Apify Actor in `apify/` (hosted, pay-per-event version of this server).

### Changed
- Tool failures now set `isError: true` on the result (text unchanged).
- `migrate_all_svgs` error entries are redacted like every other error.


## 1.1.1

- Add `mcpName` and `server.json` for the official MCP Registry (io.github.Semmargl/figma-proxy-mcp).

## 1.1.0

### Added
- Run without cloning: `npx -y figma-proxy-mcp --stdio`.
- MCP `instructions` in the `initialize` response (stdio and HTTP): the summary → flat/lean
  sections → build → render → verify loop, and the "links must contain node-id" rule.
- Setup doctor: `npx figma-proxy-mcp --check` (also the `figma-proxy-mcp-doctor` bin). It checks
  Node, the token (value never printed), `GET /v1/me` status and Chromium. Exit codes 0/1.
- `--help` and `--version` flags; `ping` method.
- `SECURITY.md`: hosts contacted, files written, token scope.
- Env vars: `FIGMA_PROXY_CACHE_DIR`, `FIGMA_PROXY_DATA_DIR`, `FIGMA_PROXY_VERIFY_DIR`,
  `FIGMA_PROXY_SVG_DIR`, `FIGMA_PROXY_CHROME_PATH`, `FIGMA_PROXY_PORT`, `FIGMA_PROXY_HOST`,
  `FIGMA_PROXY_NO_DOTENV`.
- Offline smoke tests (`npm test`).
- Support for Figma branch URLs and instance node ids (`I1-2;3-4`).

### Changed
- `.env` lookup: environment variable → `.env` in the working directory → `.env` next to the package.
  An empty env var no longer hides a `.env` value.
- Component registry and `verify_render` diff images now go to the OS temp dir by default
  (previously inside the package folder, which is the npm cache under npx).
- The HTTP mode binds to `127.0.0.1` by default (previously all interfaces).
- Clearer errors for 403/404/429 and for a missing Chromium.
- Node.js 20+ required.

### Security
- Token is redacted from every error message; logs contain error messages only, not full error objects.
- File keys are validated before they are used in API paths; image URLs must be `https://`.
- Removed the `postinstall` script and unused dependencies (`axios`, `eventsource`, `node-fetch`).
- npm package ships only the runtime files (`files` whitelist).

### Fixed
- Stdio: messages split across chunks are buffered correctly.
- JSON-RPC notifications no longer receive error responses.

## 1.0.0
- Initial release.

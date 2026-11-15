# Changelog

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

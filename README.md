# figma-proxy-mcp

MCP server for **Figma → code** pipelines. It reads Figma through the REST API and returns
data an agent can use directly, instead of the raw Figma tree:

| Tool | What it gives the agent |
|---|---|
| `get_figma_component` | Normalised IR of a node: `summary:true` (sections + boxes + tokens), `format:"flat", lean:true` (flat node list with coordinates relative to the root), CSS variables and a ready **Tailwind theme** |
| `render_node_png` | Reference render of a node (PNG, base64 + image URL) |
| `verify_render` | Renders your HTML in headless Chromium and diffs it against the Figma render → SSIM, pixel-diff %, clustered diff regions |
| `export_svg`, `migrate_all_svgs`, `list_svg_cache` | Icon / vector export |
| `get_figma_file`, `get_cached_components`, `get_component_by_name` | File tree and component cache |

**Read-only**: it never writes to your Figma files. Every host it contacts and every file
it writes is listed in [SECURITY.md](SECURITY.md).

---

## 1. Requirements
- **Node.js 20+** (https://nodejs.org, LTS). Check with `node -v`.
- A **Figma personal access token** (next section).
- Optional, only for `verify_render`: Chromium for Playwright (step 4).

## 2. Get your Figma token (2 minutes)
1. Open Figma (web or desktop) → click your **avatar** → **Settings**.
2. Tab **Security** → **Personal access tokens** → **Generate new token**.
3. Name: `figma-proxy-mcp`. Expiration: your choice (90 days is fine).
4. Scopes: **File content → Read-only** (enough for everything here). Optionally *Dev resources → Read-only*.
5. Click **Generate token** and **copy it now**. It starts with `figd_` and is shown only once.

The token can read every file *your account* can open. To work with someone else's file,
ask them to share it with your Figma account (view access is enough).

## 3. Connect to your AI tool (npx, recommended)
No clone needed. `npx` downloads and runs the published package.

**Claude Code** (run in your project folder):
```bash
claude mcp add figma-proxy -e FIGMA_API_KEY=figd_your_token -- npx -y figma-proxy-mcp --stdio
```
Add `--scope project` to share the server with your team via `.mcp.json`, but then
**do not** put the token in that file: export `FIGMA_API_KEY` in your shell instead.

**Cursor** (`.cursor/mcp.json` or `~/.cursor/mcp.json`) / **Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "figma-proxy": {
      "command": "npx",
      "args": ["-y", "figma-proxy-mcp", "--stdio"],
      "env": { "FIGMA_API_KEY": "figd_your_token" }
    }
  }
}
```
Restart the app after editing the config.

Token lookup order: environment variable (the `env` block above) → `.env` in the working
directory → `.env` next to the package. Never commit a real token.

## 4. Check your setup
```bash
FIGMA_API_KEY=figd_your_token npx -y figma-proxy-mcp --check
```
It checks the Node version, that the token is set (the value is never printed), that Figma
accepts it (`GET /v1/me`, only the HTTP status is shown), and whether Chromium is available.
Exit code `0` = ready, `1` = something required is missing.

For `verify_render`, install Chromium once:
```bash
npx playwright install chromium
```
Already have Chrome/Chromium and cannot download? Set `FIGMA_PROXY_CHROME_PATH` to its binary.

## 5. Alternative: run from a git clone
```bash
git clone https://github.com/Semmargl/figma-proxy-mcp.git
cd figma-proxy-mcp
npm install
npx playwright install chromium     # only for verify_render
cp .env.example .env                # then put your token in .env
npm run check
```
Connect with the **absolute** path to `proxy-mcp.js`:
```bash
claude mcp add figma-proxy -- node /ABS/PATH/figma-proxy-mcp/proxy-mcp.js --stdio
```
```json
{ "mcpServers": { "figma-proxy": { "command": "node", "args": ["/ABS/PATH/figma-proxy-mcp/proxy-mcp.js", "--stdio"] } } }
```
The `.env` next to `proxy-mcp.js` is found whatever the working directory is.

## 6. HTTP mode (scripts / agents that start it on demand)
```bash
npx -y figma-proxy-mcp     # → http://127.0.0.1:4444/mcp  (JSON-RPC: initialize, tools/list, tools/call)
```
```bash
curl -s 127.0.0.1:4444/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_figma_component","arguments":{"figmaUrl":"<link with node-id>","summary":true}}}'
```
It binds to loopback only. Change with `FIGMA_PROXY_PORT` / `FIGMA_PROXY_HOST`.

## 7. Recommended workflow
The server also sends this to MCP clients as `instructions` on initialize.
1. Links must contain `node-id`: in Figma right-click a frame → **Copy link to selection**.
2. `get_figma_component {figmaUrl, summary:true}`: tokens, Tailwind theme, registry, root box, sections with `relativeBox`.
3. Per section: `get_figma_component {figmaUrl, format:"flat", lean:true}`.
4. Build the markup with the `$--var` tokens and `relativeBox` coordinates.
5. `render_node_png {figmaUrl, scale:2}` for the reference image.
6. `verify_render {htmlPath, frameWidth, figmaUrl, scale:2}`, fix only the reported regions, repeat until SSIM ≥ threshold (default 0.95).

`verify_render` needs `htmlPath` (absolute path to a self-contained HTML file) and `frameWidth`
(the Figma frame width = root `w` from the summary).

## 8. Environment variables
| Variable | Default | Purpose |
|---|---|---|
| `FIGMA_API_KEY` | (required) | Figma personal access token |
| `FIGMA_FILE_DEPTH` / `FIGMA_NODE_DEPTH` | 4 / 12 | Fetch depth for helper scripts |
| `FIGMA_PROXY_CACHE_DIR` | `<os temp>/figma-proxy-mcp` | Base dir for everything the server writes |
| `FIGMA_PROXY_DATA_DIR` | `<cache>/data` | Component registry |
| `FIGMA_PROXY_VERIFY_DIR` | `<cache>/verify-out` | `verify_render` diff images |
| `FIGMA_PROXY_SVG_DIR` | `./exported-svgs` | Default SVG output dir |
| `FIGMA_PROXY_CHROME_PATH` | (Playwright's Chromium) | Use an existing Chrome/Chromium binary |
| `FIGMA_PROXY_PORT` / `FIGMA_PROXY_HOST` | 4444 / 127.0.0.1 | HTTP mode |
| `FIGMA_PROXY_NO_DOTENV` | unset | `1` = ignore `.env` files |

## Troubleshooting
| Symptom | Fix |
|---|---|
| `FIGMA_API_KEY is not set` | Add it to the client's `env` block, or to `.env` (section 3 / 5). Run `--check`. |
| `403` / token invalid | Token expired, revoked or wrong: generate a new one. |
| `404` on a node | No access to the file, or wrong `node-id`. |
| `Invalid Figma file key` | Use the key from the file URL: `figma.com/design/<fileKey>/...` |
| `verify_render`: Chromium not installed | `npx playwright install chromium`, or set `FIGMA_PROXY_CHROME_PATH`. |
| `--check`: cannot reach api.figma.com | Network/firewall. Behind an HTTP proxy, Node 22.21+/24 needs `NODE_USE_ENV_PROXY=1` with `HTTPS_PROXY` set. |
| `EADDRINUSE :4444` | HTTP mode already running, or set `FIGMA_PROXY_PORT`. |

## Development
```bash
npm test     # offline smoke tests: stdio + HTTP JSON-RPC, doctor, image diff
```
`scripts/capture.js` and `scripts/inspect-ir.js` are dev-only helpers (not in the npm package):
they save a raw Figma response to `./fixtures/` and print IR statistics for it.

## Security
See [SECURITY.md](SECURITY.md). Changes: [CHANGELOG.md](CHANGELOG.md).

## License
MIT

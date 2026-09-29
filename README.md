# figma-proxy-mcp

MCP server for **Figma → code** pipelines. Reads Figma through the REST API and returns
agent-friendly data instead of the raw Figma tree:

| Tool | What it gives the agent |
|---|---|
| `get_figma_component` | Normalised IR of a node: `summary:true` (sections + boxes + tokens), `format:"flat", lean:true` (flat node list with coordinates relative to the root), CSS variables and a ready **Tailwind theme** |
| `render_node_png` | Reference render of a node (PNG, base64 + image URL) |
| `verify_render` | Renders your HTML in headless Chromium and diffs it against the Figma render → SSIM, pixel-diff %, clustered diff regions |
| `export_svg`, `migrate_all_svgs`, `list_svg_cache` | Icon / vector export |
| `get_figma_file`, `get_cached_components`, `get_component_by_name` | File tree and component cache |

Read-only: it never writes to your Figma files.

---

## 1. Requirements
- **Node.js 20+** — https://nodejs.org (LTS). Check: `node -v`
- **git**
- A **Figma personal access token** (next section)

## 2. Get your Figma token (2 minutes)
1. Open Figma (web or desktop) → click your **avatar** (top-left) → **Settings**.
2. Tab **Security** → section **Personal access tokens** → **Generate new token**.
3. Name: `figma-proxy-mcp`. Expiration: your choice (90 days is fine).
4. Scopes: **File content → Read-only** (enough for everything here). Optionally *Dev resources → Read-only*.
5. Click **Generate token** and **copy it now** — it starts with `figd_` and is shown only once.

The token can read every file *your account* can open. To work with someone else's file, ask them to share it with your Figma account (view access is enough).

## 3. Install
```bash
git clone https://github.com/Semmargl/figma-proxy-mcp.git
cd figma-proxy-mcp
npm install
npx playwright install chromium     # needed only for verify_render
cp .env.example .env
```

## 4. Put the token in `.env`
Open **`figma-proxy-mcp/.env`** in any text editor (macOS: `open -e .env`) and replace the placeholder:
```
FIGMA_API_KEY=figd_your_new_token_here      ← before
FIGMA_API_KEY=figd_AbCdEf...your real token ← after
```
Save. `.env` is git-ignored — never commit it, never paste the token into code or MCP configs.
(Alternative: set `FIGMA_API_KEY` in the MCP client's `env` block or in your shell.)

Check the token:
```bash
curl -s -H "X-Figma-Token: $(grep FIGMA_API_KEY .env | cut -d= -f2)" https://api.figma.com/v1/me
```
→ JSON with your email = OK. `403` = wrong/expired token.

## 5. Connect to your AI tool (stdio)
Use the **absolute** path to `proxy-mcp.js`.

**Claude Code** (in your project folder):
```bash
claude mcp add figma-proxy --scope project -- node /ABS/PATH/figma-proxy-mcp/proxy-mcp.js --stdio
```
**Claude Desktop / Cursor** (`claude_desktop_config.json` / `.cursor/mcp.json`):
```json
{ "mcpServers": { "figma-proxy": { "command": "node", "args": ["/ABS/PATH/figma-proxy-mcp/proxy-mcp.js", "--stdio"] } } }
```
Restart the app. The key is read from `.env` next to `proxy-mcp.js`, whatever the working directory.

## 6. HTTP mode (scripts / agents that start it on demand)
```bash
node proxy-mcp.js            # → http://localhost:4444/mcp  (JSON-RPC: tools/list, tools/call)
```
```bash
curl -s localhost:4444/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_figma_component","arguments":{"figmaUrl":"<link with node-id>","summary":true}}}'
```

## 7. Usage tips
- Links must contain `node-id`: in Figma right-click a frame → **Copy link to selection**.
- Start with `summary:true`, then fetch each section with `format:"flat", lean:true`. Use `relativeBox` for layout.
- `verify_render` needs `htmlPath` (absolute, a self-contained HTML file) + `frameWidth` (Figma frame width).
- Optional env: `FIGMA_FILE_DEPTH` (default 4), `FIGMA_NODE_DEPTH` (default 12).

## Troubleshooting
| Symptom | Fix |
|---|---|
| `FIGMA_API_KEY is not set` | `.env` missing or still has the placeholder (step 4) |
| `403` / `Invalid token` | token expired or wrong — generate a new one |
| `404` on a node | no access to the file, or wrong `node-id` |
| `verify_render`: executable doesn't exist | `npx playwright install chromium` |
| `EADDRINUSE :4444` | HTTP mode already running (or another app on 4444) |

## License
MIT

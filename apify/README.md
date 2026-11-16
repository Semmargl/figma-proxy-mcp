# Figma Proxy MCP — Figma to code with visual diff

A hosted, read-only **MCP server for Figma → code**. Connect Claude Code, Cursor or any MCP client
and your agent gets compact, code-ready design data instead of the raw Figma tree, plus an
objective **visual check** of the HTML it wrote against the Figma frame.

Nothing to install: no Node.js, no Chromium download, no local server. Bring your own Figma token.

## What it does

| Tool | What your agent gets |
|---|---|
| `get_figma_component` | Normalised node IR: `summary:true` (sections with boxes, tokens), `format:"flat", lean:true` (flat node list, coordinates relative to the root), CSS variables and a ready **Tailwind theme** |
| `render_node_png` | Reference render of a node (PNG, base64) |
| `verify_render` | Renders your HTML in headless Chromium and compares it with the Figma render: **SSIM**, pixel diff %, clustered diff regions and a **diff image** |
| `export_svg`, `migrate_all_svgs` | Icon / vector export, SVG markup returned in the response |
| `get_figma_file`, `get_cached_components`, `get_component_by_name`, `list_svg_cache` | File tree and the session's cache |

The agent loop it is built for: summary → per-section flat data → build markup → render
reference → `verify_render` → fix only the reported regions → repeat until SSIM ≥ 0.95.
The server sends this workflow to the client as MCP `instructions`.

## Connect

You need two tokens:

1. **Apify API token**: [Apify Console → Settings → API & Integrations](https://console.apify.com/settings/integrations).
2. **Figma personal access token**: Figma → Settings → Security → *Personal access tokens*.
   Scope *File content: Read-only* is enough.

MCP endpoint (Streamable HTTP):

```
https://semmargl--figma-proxy-mcp.apify.actor/mcp
```

Send the Apify token as `Authorization: Bearer <APIFY_TOKEN>` and the Figma token as
`x-figma-token: <FIGMA_TOKEN>`.

**Claude Code**

```bash
claude mcp add --transport http figma-proxy https://semmargl--figma-proxy-mcp.apify.actor/mcp \
  --header "Authorization: Bearer <APIFY_TOKEN>" \
  --header "x-figma-token: <FIGMA_TOKEN>"
```

**Cursor** (`~/.cursor/mcp.json` or `.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "figma-proxy": {
      "url": "https://semmargl--figma-proxy-mcp.apify.actor/mcp",
      "headers": {
        "Authorization": "Bearer <APIFY_TOKEN>",
        "x-figma-token": "<FIGMA_TOKEN>"
      }
    }
  }
}
```

If your client cannot set custom headers, append `?figmaToken=<FIGMA_TOKEN>` to the URL
(the header is safer: URLs end up in logs more often).

### Usage notes for a remote server

- Links must contain `node-id`: in Figma right-click a frame → **Copy link to selection**.
- `verify_render` takes the page **inline**: `{ html: "<!doctype html>…", frameWidth, figmaUrl, scale: 2 }`.
  Use a self-contained document (inline CSS; images as `data:` or public `https://` URLs). Max 5 MB.
  The diff image comes back as MCP image content (logical px, red = differs).
- SVGs come back in the response; your agent saves them in your project.
- The server cannot read or write files on your machine, so `htmlPath`, `figmaPngPath`, `outDir`,
  `outputDir` and `save` are not available here (they are in the self-hosted version).

## Pricing (pay per event)

You pay only for **successful** tool calls. Failed calls, `initialize`, `tools/list` and the
cache tools are free.

| Event | Tools | Price |
|---|---|---|
| `tool-call` | `get_figma_component`, `get_figma_file`, `export_svg`; `migrate_all_svgs` per exported icon | $0.005 |
| `render` | `render_node_png` | $0.02 |
| `verify` | `verify_render` | $0.05 |

Plus Apify's standard Actor start fee (`apify-actor-start`, fractions of a cent per run).

Typical page: 1 summary + 6 sections + 1 reference render + 3 verify rounds ≈
7 × $0.005 + $0.02 + 3 × $0.05 = **about $0.21**.

Set a maximum cost per run in Apify Console; when it is reached the server refuses paid calls
with a clear message instead of doing unpaid work.

## Privacy and security

- **Read-only**: only `GET` requests to the Figma REST API. Nothing in Figma is changed.
- Your **Figma token** is kept in memory for your session only, sent only to `api.figma.com`
  (`X-Figma-Token` header), never logged and never stored. Error messages are redacted.
- Your **Apify token** is checked by the Apify platform and removed before the request reaches the Actor.
- Standby runs are **not shared** between users.
- Rendered images and SVGs are downloaded from Figma's image storage via short-lived signed URLs,
  without your token.
- Your HTML is rendered in a sandboxed headless Chromium that may load only the page itself,
  `data:` URLs and public `https://` URLs. Inline HTML is written to a temp dir and deleted after
  the render. Nothing is written to a dataset or key-value store.
- Full list of hosts and files: [SECURITY.md](https://github.com/Semmargl/figma-proxy-mcp/blob/main/SECURITY.md).

## Limitations

- Needs a Figma token with access to the file; Figma's own API rate limits apply (429 → wait and retry).
- `verify_render` compares against a frame rendered by Figma: fonts that are not available in the
  render (non-web fonts) and anti-aliasing cause small diffs; use `clip` and `bg` to focus the comparison.
- One request must answer within 5 minutes (Apify Standby limit). Very large frames: fetch by section.
- `migrate_all_svgs` exports at most 50 icons per call by default (`maxIcons` to change).
- The first request after idle can take a few seconds while a Standby run starts.

## Free self-hosted version

The same server is open source (MIT) and free to run on your own machine:

```bash
npx -y figma-proxy-mcp --stdio
```

Source, docs and issues: [github.com/Semmargl/figma-proxy-mcp](https://github.com/Semmargl/figma-proxy-mcp) ·
npm: [figma-proxy-mcp](https://www.npmjs.com/package/figma-proxy-mcp).

## For maintainers: build and local test

The Actor depends on the published `figma-proxy-mcp` npm package (`^1.2.0`), runs it in-process
in hosted mode (`FIGMA_PROXY_HOSTED=1`) behind MCP Streamable HTTP, and charges events with
`Actor.charge` after each successful tool call (`src/billing.js`).

Local test without an Apify account (simulated Standby and pay-per-event):

```bash
cd apify
npm install                       # needs figma-proxy-mcp >= 1.2.0 on npm
# before 1.2.0 is published, install the local checkout instead:
#   npm pack .. && npm install --no-save --no-package-lock apify @modelcontextprotocol/sdk express ./figma-proxy-mcp-1.2.0.tgz
node test/local-standby.mjs       # set FIGMA_PROXY_CHROME_PATH if Playwright's Chromium is missing
```

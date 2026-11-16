# Security and privacy

figma-proxy-mcp is a local MCP server. It runs on your machine, uses your Figma
personal access token, and only **reads** from Figma. (A hosted variant exists; see
*Hosted mode* below.) It has no telemetry and no
analytics, and sends nothing anywhere except the requests listed below.

## Read-only

The server only calls `GET` endpoints of the Figma REST API. It never creates,
edits, comments on or deletes anything in Figma.

## Token handling

- The token is read only from the `FIGMA_API_KEY` environment variable or a `.env` file,
  or, in HTTP / hosted mode, from the `x-figma-token` header (or `figmaToken` query
  parameter) of the request, for that request only.
  Resolution order: real environment variable → `.env` in the current working directory
  → `.env` next to the installed package. Set `FIGMA_PROXY_NO_DOTENV=1` to use env vars only.
- The token is sent only to `api.figma.com` in the `X-Figma-Token` header.
- It is never logged, never written to disk, and never included in tool output.
  Error messages pass through a redaction step as an extra safeguard.
- `--check` / `figma-proxy-mcp-doctor` reports only whether the token is set (and its
  length) plus the HTTP status of `GET /v1/me`. The response body (your account
  details) is thrown away, not printed.

**Recommended token scope:** *File content: Read-only*. Nothing else is needed.
(*Dev resources: Read-only* is optional.) Use an expiry date and revoke the token
when you stop using the server. The token can read every file your Figma account can
open, so treat it like a password.

## Network: every host contacted

| Host | When | What |
|---|---|---|
| `api.figma.com` | every Figma tool call, and `--check` | `GET /v1/files/:key`, `GET /v1/files/:key/nodes`, `GET /v1/images/:key`, `GET /v1/me` (doctor only). Token sent. |
| Figma image storage, currently `*.s3.*.amazonaws.com` (for example `figma-alpha-api.s3.us-west-2.amazonaws.com`) | `render_node_png`, `export_svg`, `migrate_all_svgs`, `verify_render` with `figmaUrl` | Downloads the PNG/SVG at the short-lived signed URL that `GET /v1/images` returned. **No token is sent.** Only `https://` URLs are accepted. The host is chosen by Figma and may change. |
| Whatever your HTML page loads | `verify_render` | Headless Chromium opens your local HTML file (`file://`). If that page references remote fonts, scripts or images, Chromium fetches them, exactly as a browser would. Use a self-contained HTML file to avoid this. |
| Playwright's browser CDN | only when **you** run `npx playwright install chromium` | One-time Chromium download. The server never triggers this itself, and there is no `postinstall` script. |

The HTTP mode (`figma-proxy-mcp` without `--stdio`) listens on **`127.0.0.1:4444`**
only. Change it with `FIGMA_PROXY_PORT` / `FIGMA_PROXY_HOST`. Do not bind it to a
public interface: anyone who can reach it can use your token through it.

## Files written

| What | Default location | Override |
|---|---|---|
| Component registry (component names, variant axes, text styles and node ids from the designs you fetched, plus the file key; no token) | `<os temp dir>/figma-proxy-mcp/data/component-registry.json` | `FIGMA_PROXY_DATA_DIR` or `FIGMA_PROXY_CACHE_DIR` |
| `verify_render` diff image (`<html-name>-diff.png`) | `<os temp dir>/figma-proxy-mcp/verify-out/` | per call `outDir`, or `FIGMA_PROXY_VERIFY_DIR` / `FIGMA_PROXY_CACHE_DIR` |
| SVG files, only when `export_svg` is called with `save:true`, or `migrate_all_svgs` runs | `./exported-svgs` relative to the server's working directory | per call `outputDir`, or `FIGMA_PROXY_SVG_DIR` |

`<os temp dir>` is `os.tmpdir()`, for example `/tmp` on Linux or `/var/folders/...` on macOS.
SVG and PNG data fetched from Figma is otherwise kept **in memory only** (the SVG
cache shown by `list_svg_cache` is lost when the process exits). The server writes nothing else.

## Files read

- `.env` (see *Token handling*).
- `verify_render` reads the `htmlPath` you pass and, if given, `figmaPngPath`.
  The server reads these local paths on behalf of the MCP client, so only connect it
  to clients and agents you trust.

## Hosted mode (`FIGMA_PROXY_HOSTED=1`, used by the Apify Actor)

- `FIGMA_API_KEY` and `.env` files are ignored. Each MCP request must carry the caller's
  own token (`x-figma-token` header preferred; the `figmaToken` query parameter works
  but URLs are more likely to end up in logs). The token is kept in memory for the
  request/session only, sent only to `api.figma.com`, never logged and never stored.
- No file outside the OS temp dir is read or written: `htmlPath`, `figmaPngPath`,
  `outDir`, `outputDir`, `save` and `fileName` are rejected. Inline `html` is written to
  a private temp dir and deleted after the render; SVGs and the diff image are returned
  in the response and not written to disk.
- The caller's HTML is untrusted: while rendering it, Chromium may load only the page
  itself, `data:`/`blob:` URLs and `https://` URLs on public hosts. Other `file://` paths,
  plain `http://` and localhost/private/link-local addresses are blocked.

## Dependencies

Runtime: `express` (HTTP mode only), `playwright` (only for `verify_render`; Chromium
is not downloaded automatically), `pixelmatch`, `pngjs`. No install scripts.

## Reporting a vulnerability

Please open a private security advisory on GitHub:
https://github.com/Semmargl/figma-proxy-mcp/security/advisories/new
(or an issue without exploit details if advisories are unavailable).

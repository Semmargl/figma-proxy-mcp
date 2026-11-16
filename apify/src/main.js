/**
 * figma-proxy-mcp as an Apify Standby Actor.
 *
 * Serves the figma-proxy-mcp tools over MCP Streamable HTTP at /mcp, in-process
 * (no stdio child), so that each session can carry its own Figma token and each
 * successful tool call can be charged with Actor.charge (pay per event).
 *
 * Auth:
 *   - Apify token: `Authorization: Bearer <APIFY_TOKEN>` (or Apify OAuth). The
 *     platform checks it and strips it before the request reaches this code.
 *   - Figma token: `x-figma-token: <FIGMA_TOKEN>` header (preferred) or the
 *     `figmaToken` query parameter. Held in memory per session, sent only to
 *     api.figma.com, never logged, never stored.
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
    CallToolRequestSchema,
    isInitializeRequest,
    ListToolsRequestSchema,
    McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { Actor, log } from 'apify';
import express from 'express';

import { canAfford, chargeToolCall, eventForTool } from './billing.js';

// Hosted mode must be on before the server module (and its config) loads.
process.env.FIGMA_PROXY_HOSTED = '1';
const require = createRequire(import.meta.url);
const { MCPProxyServer, runWithToken, tokenFromHttpRequest } = require('figma-proxy-mcp');

const STANDBY_MODE = process.env.APIFY_META_ORIGIN === 'STANDBY';
const SERVER_PORT = parseInt(process.env.ACTOR_WEB_SERVER_PORT || process.env.ACTOR_STANDBY_PORT || '3001', 10);
const SESSION_IDLE_MS = 30 * 60 * 1000;

/**
 * verify_render needs Chromium. Prefer Playwright's own build; if the installed
 * playwright version has no matching browser in the image, fall back to a
 * system Chrome/Chromium.
 */
function ensureBrowser() {
    if (process.env.FIGMA_PROXY_CHROME_PATH) return;
    try {
        const { chromium } = require('playwright');
        if (fs.existsSync(chromium.executablePath())) return;
    } catch {
        /* fall through */
    }
    const candidates = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
    const found = candidates.find((p) => fs.existsSync(p));
    if (found) {
        process.env.FIGMA_PROXY_CHROME_PATH = found;
        log.info('Using system browser for verify_render', { path: found });
    } else {
        log.warning('No Chromium found: verify_render will return an install error');
    }
}

// Static server info (version, instructions) taken from the server itself.
const probe = await new MCPProxyServer().handleRequest({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
const SERVER_INFO = { name: 'figma-proxy-mcp', version: probe.result.serverInfo.version };
const INSTRUCTIONS = probe.result.instructions;

/** sessionId -> { transport, server, proxy, token, lastSeen } */
const sessions = new Map();

function createSession(initialToken) {
    const session = { token: initialToken || '', proxy: new MCPProxyServer(), lastSeen: Date.now(), transport: null, server: null };

    const server = new Server(SERVER_INFO, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

    // Forward one JSON-RPC call to the in-process figma-proxy-mcp server with this session's token.
    const call = (method, params) =>
        runWithToken(session.token, () => session.proxy.handleRequest({ jsonrpc: '2.0', id: 1, method, params }));

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        const resp = await call('tools/list', {});
        return resp.result;
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const toolName = request.params?.name;
        const eventName = eventForTool(toolName);
        if (eventName && !canAfford(eventName)) {
            return {
                content: [{ type: 'text', text: `Your Apify spending limit does not cover another "${eventName}" event. Raise the maximum cost per run for this Actor in Apify Console and retry.` }],
                isError: true,
            };
        }
        const started = Date.now();
        const resp = await call('tools/call', request.params);
        if (resp.error) {
            log.info('Tool call rejected', { tool: toolName, ms: Date.now() - started });
            throw new McpError(resp.error.code, resp.error.message);
        }
        const { result } = resp;
        log.info('Tool call done', { tool: toolName, ok: !result.isError, ms: Date.now() - started });
        await chargeToolCall(toolName, result);
        return result;
    });

    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
            sessions.set(sessionId, session);
            log.info('Session initialized', { sessionId, hasFigmaToken: Boolean(session.token) });
        },
    });
    transport.onclose = () => {
        if (transport.sessionId && sessions.delete(transport.sessionId)) {
            log.info('Session closed', { sessionId: transport.sessionId });
        }
    };
    session.transport = transport;
    session.server = server;
    return session;
}

function jsonRpcError(res, status, message, code = -32000) {
    res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

async function mcpPost(req, res) {
    const sessionId = req.headers['mcp-session-id'];
    const token = tokenFromHttpRequest(req);
    try {
        if (sessionId && sessions.has(sessionId)) {
            const session = sessions.get(sessionId);
            session.lastSeen = Date.now();
            if (token) session.token = token; // latest token wins (e.g. after rotation)
            await session.transport.handleRequest(req, res, req.body);
            return;
        }
        if (!sessionId && isInitializeRequest(req.body)) {
            const session = createSession(token);
            await session.server.connect(session.transport);
            await session.transport.handleRequest(req, res, req.body);
            return;
        }
        jsonRpcError(res, 400, sessionId ? 'Unknown or expired session. Reconnect (send initialize again).' : 'Bad Request: No valid session ID provided');
    } catch (error) {
        log.error('Error handling MCP request', { error: String(error?.message || error) });
        if (!res.headersSent) jsonRpcError(res, 500, 'Internal server error', -32603);
    }
}

async function mcpGetOrDelete(req, res) {
    const sessionId = req.headers['mcp-session-id'];
    const session = sessionId && sessions.get(sessionId);
    if (!session) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }
    session.lastSeen = Date.now();
    try {
        await session.transport.handleRequest(req, res);
    } catch (error) {
        log.error('Error handling MCP stream/termination', { error: String(error?.message || error) });
        if (!res.headersSent) res.status(500).end();
    }
}

function startServer() {
    const app = express();

    app.get('/', (req, res) => {
        if (req.headers['x-apify-container-server-readiness-probe']) {
            res.end('ok\n');
            return;
        }
        res.type('text/plain').send(
            'figma-proxy-mcp MCP server. Connect an MCP client (Streamable HTTP) to /mcp with headers:\n' +
                '  Authorization: Bearer <APIFY_TOKEN>\n  x-figma-token: <FIGMA_PERSONAL_ACCESS_TOKEN>\n',
        );
    });

    app.get('/favicon.ico', (_req, res) => {
        res.writeHead(301, { Location: 'https://apify.com/favicon.ico' });
        res.end();
    });

    // Lets MCP clients authenticate to Apify with OAuth (as in Apify's MCP templates).
    app.get('/.well-known/oauth-authorization-server', async (_req, res) => {
        try {
            const response = await fetch('https://api.apify.com/.well-known/oauth-authorization-server');
            res.status(200).json(await response.json());
        } catch {
            res.status(502).end();
        }
    });

    // Inline HTML (up to 5 MB) plus a base64 reference PNG fit comfortably.
    app.use(express.json({ limit: '25mb' }));
    app.post('/mcp', mcpPost);
    app.get('/mcp', mcpGetOrDelete);
    app.delete('/mcp', mcpGetOrDelete);

    const httpServer = app.listen(SERVER_PORT, () => {
        log.info(`figma-proxy-mcp ${SERVER_INFO.version} listening on port ${SERVER_PORT} (path /mcp)`);
    });

    // Drop sessions that went quiet (clients that never sent DELETE).
    const sweeper = setInterval(() => {
        const now = Date.now();
        for (const [id, s] of sessions) {
            if (now - s.lastSeen > SESSION_IDLE_MS) {
                sessions.delete(id);
                s.transport.close().catch(() => {});
            }
        }
    }, 60 * 1000);
    sweeper.unref();

    const shutdown = async () => {
        log.info('Shutting down');
        for (const s of sessions.values()) await s.transport.close().catch(() => {});
        sessions.clear();
        httpServer.close();
        await Actor.exit();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

await Actor.init();

if (!STANDBY_MODE) {
    const msg = 'This Actor is an MCP server and runs in Standby mode only. Connect your MCP client to the Standby URL (see the README).';
    log.error(msg);
    await Actor.exit({ statusMessage: msg });
}

ensureBrowser();
startServer();

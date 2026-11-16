/**
 * Pay-per-event billing for figma-proxy-mcp tool calls.
 *
 * Events (prices live in .actor/pay_per_event.json and in Apify Console):
 *   tool-call  - a successful Figma metadata / SVG call (cheap: one or two REST requests)
 *   render     - a successful render_node_png (Figma image render + PNG download)
 *   verify     - a successful verify_render (headless Chromium render + SSIM/pixel diff)
 *
 * Rules:
 *   - charge only after the tool succeeded (result without isError);
 *   - protocol traffic (initialize, tools/list, ping) and the in-memory cache tools are free;
 *   - migrate_all_svgs is charged one tool-call per exported icon;
 *   - before running a paid tool, refuse it when the user's spending limit
 *     cannot cover one more event, so no work is done that cannot be paid for.
 * The run start itself is covered by Apify's synthetic `apify-actor-start` event,
 * which is charged automatically (never call it from code).
 */
import { Actor, log } from 'apify';

export const TOOL_EVENTS = {
    get_figma_file: 'tool-call',
    get_figma_component: 'tool-call',
    export_svg: 'tool-call',
    migrate_all_svgs: 'tool-call',
    render_node_png: 'render',
    verify_render: 'verify',
    // free: served from the session's in-memory cache, no Figma request
    get_cached_components: null,
    get_component_by_name: null,
    list_svg_cache: null,
};

export function eventForTool(toolName) {
    return TOOL_EVENTS[toolName] ?? null;
}

/** How many events a successful result is worth. */
export function chargeCount(toolName, result) {
    if (toolName === 'migrate_all_svgs') {
        const exported = Number(result?.structuredContent?.exported);
        return Number.isFinite(exported) && exported > 0 ? exported : 1;
    }
    return 1;
}

/** True when the user's budget still covers at least one event of this type. */
export function canAfford(eventName) {
    try {
        return Actor.getChargingManager().calculateMaxEventChargeCountWithinLimit(eventName) >= 1;
    } catch (error) {
        // Fail open on SDK errors: the platform enforces the limit on charge() anyway.
        log.warning('Could not check the spending limit', { eventName, error: String(error?.message || error) });
        return true;
    }
}

/** Charge a successful tool call. Never throws (a billing hiccup must not break the response). */
export async function chargeToolCall(toolName, result) {
    const eventName = eventForTool(toolName);
    if (!eventName || !result || result.isError) return null;
    const count = chargeCount(toolName, result);
    try {
        const res = await Actor.charge({ eventName, count });
        log.info('Charged event', { eventName, count, tool: toolName, chargedCount: res?.chargedCount, limitReached: res?.eventChargeLimitReached });
        return res;
    } catch (error) {
        log.error('Charging failed', { eventName, count, tool: toolName, error: String(error?.message || error) });
        return null;
    }
}

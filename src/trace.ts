/**
 * Where a turn landed on the platform: Studio links for the session's thread
 * and a turn's trace, and a summary of what the gateway recorded, including
 * the `auto-router` span a smart router leaves behind. This is how platform
 * routing becomes visible in the terminal without a client-side classifier.
 *
 * Link shapes are Studio's own (`getting-started.ng.ts` builds the trace
 * outlet route; the threads table opens a thread with `?id=`).
 */

/** Studio lives on `my.`, the API on `api.` or `my.`: `https://api.orq.ai` → `https://my.orq.ai`. */
export function studioHost(server: string): string {
	return server.replace(/\/+$/, "").replace(/^(https?:\/\/)api\./, "$1my.");
}

export function threadUrl(host: string, workspace: string, threadId: string): string {
	return `${host}/${workspace}/traces/threads?id=${encodeURIComponent(threadId)}`;
}

export function traceUrl(host: string, workspace: string, traceId: string, spanId?: string): string {
	return `${host}/${workspace}/traces/(trace:${traceId}${spanId ? `//span:${spanId}` : ""})`;
}

export function agentUrl(host: string, workspace: string, key: string): string {
	return `${host}/${workspace}/agents/${encodeURIComponent(key)}`;
}

/** `30b08a66f5e9…0185`: long ids shortened for one-line notices. */
export function shortId(id: string): string {
	return id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

/** One router call the session made, from its `x-orq-trace-id` response header. */
export interface TraceRef {
	turn: number;
	traceId: string;
	spanId?: string;
}

interface Span {
	name?: string;
	duration?: number;
	total_cost?: number;
	total_tokens?: number;
	span_id?: string;
	attributes?: Record<string, any>;
}

/** The `orq.auto_router.*` attributes a smart router writes, when it answered. */
export function autoRouter(spans: Span[]): Record<string, unknown> | undefined {
	for (const span of spans) {
		const attrs = span.attributes?.orq?.auto_router;
		if (attrs && typeof attrs === "object") return attrs;
	}
	return undefined;
}

const sec = (ms: number | undefined) => (ms === undefined ? "" : `${(ms / 1000).toFixed(1)} s`);
const usd = (n: number | undefined) => (n === undefined ? "" : n < 0.001 ? `$${n.toFixed(5)}` : `$${n.toFixed(3)}`);

/**
 * The /trace overlay body: the smart router's decision first (when there
 * was one), then one line per span with duration, tokens and cost.
 */
export function traceSummary(spans: Span[]): string[] {
	const lines: string[] = [];
	const router = autoRouter(spans);
	if (router) {
		const pick = (key: string) => (router[key] === undefined ? undefined : String(router[key]));
		const head = [pick("profile") && `profile ${pick("profile")}`, pick("tier") && `tier ${pick("tier")}`, pick("selected_band") && `band ${pick("selected_band")}`]
			.filter(Boolean)
			.join(" · ");
		lines.push(`auto-router   ${head}`);
		lines.push(`              → ${pick("selected_model") ?? "?"} · fallback ${pick("fallback_used") === "true" ? "yes" : "no"}`);
	}
	for (const span of spans) {
		if (span.name === "auto-router") continue;
		const usage = span.attributes?.gen_ai?.usage;
		const tokens = usage ? ` · ↑${usage.prompt_tokens ?? usage.input_tokens ?? 0} ↓${usage.completion_tokens ?? usage.output_tokens ?? 0}` : "";
		lines.push(`${(span.name ?? "span").padEnd(13)} ${sec(span.duration)}${tokens}${span.total_cost ? ` · ${usd(span.total_cost)}` : ""}`);
	}
	return lines;
}

/** `orq traces conversation <id> -o json`, as `role  text` rows. */
export function conversationLines(json: string, width = 70): string[] {
	try {
		const parsed = JSON.parse(json) as { messages?: { role: string; content?: { type: string; text?: string; name?: string }[] | string }[] };
		return (parsed.messages ?? []).map((message) => {
			const content = typeof message.content === "string"
				? message.content
				: (message.content ?? []).map((part) => (part.type === "text" ? part.text : `[${part.type}${part.name ? ` ${part.name}` : ""}]`)).join(" ");
			return `${message.role.padEnd(10)} ${String(content ?? "").replace(/\s+/g, " ").slice(0, width)}`;
		});
	} catch {
		return [json.trim().split("\n")[0] ?? "no conversation"];
	}
}

/**
 * The orq MCP server, through pi's own MCP support.
 *
 * pi 1.2 connects MCP servers natively: retries on network errors and
 * 408/429/5xx, reconnects a dropped connection on the next call, a per-request
 * timeout, `${ENV}` headers, tool exposure, `/mcp` to inspect and reconnect,
 * and OAuth (`/mcp login orq`; the orq server publishes its resource metadata).
 * orqi registers one server, `orq`, so its tools reach the model as
 * `mcp__orq__<tool>`, the same names any pi user gets.
 *
 * What orqi still owns:
 * - which credential: the candidates (the /login key, a profile, ORQ_API_KEY,
 *   the CLI login) are tried in order with one cheap REST call each, and the
 *   winner goes into ORQ_API_KEY, which the server's Authorization header reads;
 * - the denylist (three invocation tools, hidden through `toolExposure`);
 * - how a call and its result are drawn (one line each, ctrl+o expands);
 * - constraints the server's schema leaves out (TOOL_HINTS, now in the prompt);
 * - one direct call for slash commands, which pi gives no way to run tools.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { apiBaseUrl, mcpUrl, type Credential } from "./auth.ts";
import { VERSION } from "./branding.ts";
import { argSummary } from "./trajectory.ts";

/** pi names MCP tools `mcp__<server>__<tool>`; orqi's server is `orq`. */
export const MCP_SERVER = "orq";
export const TOOL_PREFIX = `mcp__${MCP_SERVER}__`;

/**
 * Invocation surfaces, not orqi's job. Hiding them takes ~6 KB of the 71 KB
 * of tool schema that ships with every request. `ORQI_ALL_TOOLS=1` restores them.
 */
export const DENYLISTED_TOOLS = new Set(["invoke_model", "invoke_agent", "retrieve_agent_response"]);

/**
 * Constraints the server enforces but its schema does not express. pi gives
 * no hook to append to an MCP tool's description, so these go in the system
 * prompt beside the tool naming rule. The matrix was measured against a live
 * workspace, one call per pair. Delete an entry once the server's own schema
 * says it; a test fails if a hinted tool disappears.
 */
export const TOOL_HINTS: Record<string, string> = {
	query_analytics: [
		"- `filters.project_id` is REQUIRED when the API key spans several projects, which is the usual case.",
		"  No tool lists projects: get an id from `list_traces` at `items[].attributes.orq.project_id`, or from",
		"  the ids this tool enumerates when it rejects the call. Ask the user which project they mean.",
		"- `group_by` valid dimensions per metric; everything else fails as `Unknown expression identifier`:",
		"    usage, cost, latency, model_performance -> provider, model, project_id",
		"    errors                                  -> provider, model, project_id, http_status_code",
		"    agents                                  -> provider, model, project_id, http_status_code, agent_name",
		'- `agent_name` works ONLY with `metric: "agents"`.',
	].join("\n"),
};

/** The hints as a system prompt section. */
export function hintsSection(): string {
	return Object.entries(TOOL_HINTS)
		.map(([tool, hint]) => `\`${TOOL_PREFIX}${tool}\` has constraints its schema does not express:\n${hint}`)
		.join("\n\n");
}

/** Hidden unless ORQI_ALL_TOOLS=1 (by value: =0 still hides). */
export function keptTools<T extends { name: string }>(tools: T[], allowAll = process.env.ORQI_ALL_TOOLS === "1"): T[] {
	return allowAll ? tools : tools.filter((tool) => !DENYLISTED_TOOLS.has(tool.name));
}

/**
 * The server entry pi connects. A NEW object on every call: pi re-connects a
 * registered server when its config object changes, which is how a new
 * credential (after /login, /key, a workspace switch) takes effect.
 */
export function orqServerConfig(allowAll = process.env.ORQI_ALL_TOOLS === "1") {
	return {
		url: mcpUrl(),
		headers: { Authorization: "Bearer ${ORQ_API_KEY}" },
		// Declared to the model like built-in tools, as before; not behind codemode.
		exposure: "direct" as const,
		toolExposure: allowAll ? {} : Object.fromEntries([...DENYLISTED_TOOLS].map((name) => [name, "hidden" as const])),
		// The server stalls now and then; a stalled call fails in 30 s rather than 60.
		timeout: 30,
		description: "The user's orq.ai workspace: agents, deployments, traces, analytics, datasets, evaluators, experiments, docs.",
	};
}

/** One credential the server turned away, and what it said. */
export interface Rejection {
	source: string;
	workspace?: string;
	reason: string;
}

/** Every candidate was rejected. Carries the server's reason for each. */
export class CredentialsRejected extends Error {
	constructor(readonly rejections: Rejection[]) {
		super("every orq credential was rejected");
	}
}

/** What a reconnect produced. */
export interface Reconnected {
	credential: Credential;
	/** Kept for the commands extension's contract; tools now arrive through pi's MCP. */
	added: never[];
	note?: string;
	/** Set by the caller when the model catalogue was reloaded with this credential. */
	modelsReloaded?: boolean;
}

/** A rejected credential, as opposed to the server stalling or falling over. */
export function isAuthError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /401|403|invalid_token|Unauthorized|audience/i.test(message);
}

/** What the server said about a rejected credential: `error_description`, `message`, or the first line. */
export function authReason(error: unknown): string {
	const message = (error instanceof Error ? error.message : String(error)).trim();
	const brace = message.indexOf("{");
	if (brace >= 0) {
		try {
			const parsed = JSON.parse(message.slice(brace));
			const reason = parsed?.error_description ?? parsed?.message ?? parsed?.error;
			if (typeof reason === "string" && reason) return reason;
		} catch {
			// Not JSON: fall through to the prose.
		}
	}
	return firstLine(message);
}

/** An error's first line: what fits in a notice without the stack. */
export function firstLine(error: unknown): string {
	return String(error instanceof Error ? error.message : error)
		.trim()
		.split("\n")[0]!;
}

/** Ask the API whether a token is accepted. Throws "401 …" for a rejection, anything else for a stall. */
export async function probeCredential(token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
	const res = await fetchImpl(`${apiBaseUrl()}/v2/projects?limit=1`, {
		headers: { Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(8_000),
	});
	if (res.status === 401 || res.status === 403) throw new Error(`${res.status} ${await res.text()}`);
	if (!res.ok && res.status >= 500) throw new Error(`server ${res.status}`);
}

/**
 * The first candidate the API accepts. A 401 selects the next one; a stall or
 * a 5xx is the server's problem and no verdict on the key, so it moves on too;
 * when nothing was accepted, a stall is thrown instead of the rejections, and
 * the boot keeps the first candidate as its best guess. One
 * REST call per candidate, sub-second, where the old path needed a whole MCP
 * handshake against a server that stalls.
 */
export async function pickCredential(
	candidates: Credential[],
	probe: (token: string) => Promise<void> = (token) => probeCredential(token),
	/** Filled with the refusals (401/403) met on the way, stalls excluded, even when a later candidate wins. */
	rejections: Rejection[] = [],
): Promise<Credential> {
	let stall: unknown;
	for (const candidate of candidates) {
		try {
			await probe(candidate.token);
			return candidate;
		} catch (error) {
			if (isAuthError(error)) rejections.push({ source: candidate.source, workspace: candidate.workspace, reason: authReason(error) });
			else stall = error;
		}
	}
	if (stall !== undefined) throw stall;
	throw new CredentialsRejected(rejections);
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return JSON.stringify(content ?? null);
	return content.map((block: any) => (block?.type === "text" ? block.text : JSON.stringify(block))).join("\n");
}

/** Expanded view: indent the JSON so pi has real lines to lay out. */
function prettify(text: string): string {
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return text;
	}
}

function humanSize(bytes: number): string {
	return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * One-line summary of an orq tool result. The server answers with a single
 * unbroken line of JSON, so pi's default preview wraps a whole screen of it.
 * The model still receives the full payload; ctrl+o expands the row.
 */
export function summarize(text: string): string {
	const size = humanSize(Buffer.byteLength(text));
	try {
		const parsed = JSON.parse(text);
		const rows = Array.isArray(parsed)
			? parsed
			: Array.isArray(parsed?.data)
				? parsed.data
				: Array.isArray(parsed?.items)
					? parsed.items
					: undefined;
		if (rows) return `${rows.length} ${rows.length === 1 ? "item" : "items"} · ${size}`;
		const keys = parsed && typeof parsed === "object" ? Object.keys(parsed) : [];
		return keys.length ? `${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", …" : ""} · ${size}` : size;
	} catch {
		const lines = text.split("\n").length;
		return `${lines > 1 ? `${lines} lines · ` : ""}${size}`;
	}
}

/** The bare server tool name: `mcp__orq__list_traces` → `list_traces`. */
export const bareName = (name: string) => (name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name);

/**
 * The extension: registers the orq server with pi and draws its tools. Every
 * session re-runs it (services are per session), so `refresh` always reaches
 * the live handle.
 */
export function orqMcp(signedIn: boolean) {
	let current: ExtensionAPI | undefined;
	// Signed out, the server is not registered at all: pi would only report
	// "requires authentication · run /mcp", pointing away from /login and /key.
	let enabled = signedIn;
	return {
		extension: (pi: ExtensionAPI) => {
			current = pi;
			if (enabled) pi.registerMcpServer(MCP_SERVER, orqServerConfig());
			pi.registerToolRenderer((toolName, next) => {
				if (!toolName.startsWith(TOOL_PREFIX)) return next();
				return {
					renderCall: (args: unknown, theme: any, context: any) => {
						const seconds = context.durationMs !== undefined ? `  ${(context.durationMs / 1000).toFixed(1)} s` : "";
						const summary = argSummary(args as Record<string, unknown>);
						return new Text(
							`${theme.fg("accent", "▌")} ${theme.fg("toolTitle", bareName(toolName))}${summary ? `  ${theme.fg("muted", summary)}` : ""}${theme.fg("dim", seconds)}`,
							0,
							0,
						);
					},
					renderResult: (result: any, options: any, theme: any, context: any) => {
						const text = textOf(result.content);
						if (options.expanded) return new Text(theme.fg("toolOutput", prettify(text)), 0, 0);
						return new Text(context?.isError ? theme.fg("error", text.slice(0, 200)) : theme.fg("muted", summarize(text)), 0, 0);
					},
				};
			});
		},
		/** Reconnect with whatever credential ORQ_API_KEY holds now (the first time, connect at all). */
		refresh: () => {
			enabled = true;
			try {
				current?.registerMcpServer(MCP_SERVER, orqServerConfig());
			} catch {
				// A handle that died with its session: the next session registers afresh.
			}
		},
		/** The orq tools pi has registered and not hidden, by bare name. */
		toolNames: (): string[] => {
			try {
				return (current?.getAllTools() ?? [])
					.filter((tool) => tool.name.startsWith(TOOL_PREFIX) && tool.exposure !== "hidden")
					.map((tool) => bareName(tool.name));
			} catch {
				return [];
			}
		},
	};
}

/**
 * One tool call for a slash command (/trace, /agents): pi lets
 * tools call tools, not commands, so these open a short-lived connection of
 * their own. Retried once on a fresh connection, because the server stalls.
 */
export async function callOrqTool(
	name: string,
	args: Record<string, unknown>,
	token = process.env.ORQ_API_KEY ?? "",
): Promise<{ text: string; isError: boolean }> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= 2; attempt++) {
		const client = new Client({ name: "orqi", version: VERSION });
		client.onerror = () => {};
		try {
			await client.connect(
				new StreamableHTTPClientTransport(new URL(mcpUrl()), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
				{ timeout: 15_000 },
			);
			const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 20_000 });
			return { text: textOf(result.content), isError: Boolean(result.isError) };
		} catch (error) {
			lastError = error;
			if (isAuthError(error)) break;
		} finally {
			await client.close().catch(() => {});
		}
	}
	throw lastError;
}

/** A JSON Schema type, short: `string`, `string[]`, `a | b`, `object`. */
function typeOf(schema: any): string {
	if (!schema || typeof schema !== "object") return "any";
	if (Array.isArray(schema.enum)) return schema.enum.map((v: unknown) => JSON.stringify(v)).join(" | ");
	if (schema.const !== undefined) return JSON.stringify(schema.const);
	const variants = schema.anyOf ?? schema.oneOf;
	if (Array.isArray(variants)) return variants.map(typeOf).join(" | ");
	if (schema.type === "array") return `${typeOf(schema.items)}[]`;
	if (Array.isArray(schema.type)) return schema.type.join(" | ");
	return schema.type ?? (schema.properties ? "object" : "any");
}

/**
 * A tool's parameters as readable lines: name, type, required, default,
 * description; nested objects indented. What the /tools detail view shows;
 * `j` there shows the raw schema instead.
 */
export function schemaLines(schema: any, indent = ""): string[] {
	const properties = schema?.properties ?? {};
	const required = new Set<string>(schema?.required ?? []);
	const names = Object.keys(properties);
	if (names.length === 0) return indent ? [] : ["(no parameters)"];
	const width = Math.min(24, Math.max(...names.map((name) => name.length)));
	return names.flatMap((name) => {
		const prop = properties[name] ?? {};
		const flags = [required.has(name) ? "required" : "", prop.default !== undefined ? `default ${JSON.stringify(prop.default)}` : ""]
			.filter(Boolean)
			.join(", ");
		const description = String(prop.description ?? "")
			.replace(/\s+/g, " ")
			.trim();
		const head = `${indent}${name.padEnd(width)}  ${typeOf(prop)}${flags ? `  (${flags})` : ""}`;
		const lines = [head, ...(description ? [`${indent}${" ".repeat(width + 2)}${description}`] : [])];
		const nested = prop.type === "object" ? prop : prop.type === "array" && prop.items?.type === "object" ? prop.items : undefined;
		return nested ? [...lines, ...schemaLines(nested, `${indent}  `)] : lines;
	});
}

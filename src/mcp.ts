/**
 * orq MCP server -> pi tools.
 *
 * pi ships no MCP support by design, so every orq workspace tool is wrapped as
 * a native pi tool. The MCP JSON schema is passed straight through, which keeps
 * this bridge indifferent to the server's tool catalogue.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "typebox";
import { LOGIN_HINT, mcpUrl, type Credential } from "./auth.ts";
import { VERSION } from "./branding.ts";

// The orq MCP server answers tools/list in ~1s most of the time, but hangs
// outright often enough (roughly one call in three) that a plain fetch-on-boot
// would strand the CLI. Hence: cache, short timeout, retry, stale fallback.
const CATALOGUE_TTL_MS = 24 * 60 * 60 * 1000;
const CALL_TIMEOUT_MS = 20_000;
const ATTEMPTS = 3;

interface McpTool {
	name: string;
	title?: string;
	description?: string;
	inputSchema: object;
}

function readCache(cachePath: string): McpTool[] | undefined {
	if (!existsSync(cachePath)) return undefined;
	try {
		const tools = JSON.parse(readFileSync(cachePath, "utf8"));
		return Array.isArray(tools) && tools.length > 0 ? tools : undefined;
	} catch {
		return undefined;
	}
}

async function catalogue(
	client: Client,
	cachePath: string,
	reconnect: () => Promise<Client>,
): Promise<{ tools: McpTool[]; client: Client; note?: string }> {
	const cached = readCache(cachePath);
	const fresh =
		cached && !process.env.ORQI_REFRESH_TOOLS && Date.now() - statSync(cachePath).mtimeMs < CATALOGUE_TTL_MS;
	if (fresh) return { tools: cached, client };

	let active = client;
	for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
		try {
			const { tools } = await active.listTools(undefined, { timeout: CALL_TIMEOUT_MS });
			mkdirSync(dirname(cachePath), { recursive: true });
			writeFileSync(cachePath, JSON.stringify(tools));
			return { tools: tools as McpTool[], client: active };
		} catch (error) {
			if (attempt === ATTEMPTS) {
				if (cached) return { tools: cached, client: active, note: "orq MCP unreachable; using cached tool catalogue" };
				throw error;
			}
			// A timed-out request leaves the stream wedged; start a fresh connection.
			await active.close().catch(() => {});
			active = await reconnect();
		}
	}
	throw new Error("unreachable");
}

/** orq tool names are prefixed so they never collide with pi's built-ins. */
export const TOOL_PREFIX = "orq_";

/**
 * Invocation surfaces, not orqi's job. Dropping them takes ~6 KB of the 71 KB
 * of tool schema that ships with every request (the 96 KB they occupy in the
 * cached catalogue is mostly `outputSchema`, which is never forwarded).
 * `ORQI_ALL_TOOLS=1` restores them.
 */
export const DENYLISTED_TOOLS = new Set(["invoke_model", "invoke_agent", "retrieve_agent_response"]);

/**
 * Constraints the server enforces but its schema does not express, appended to
 * the description the model reads when it composes a call.
 *
 * `query_analytics` offers one `group_by` enum for every metric, qualified only
 * by "Not all dimensions are available for all metrics", and lists `project_id`
 * as an ordinary optional filter. Both failures that follow are the model doing
 * exactly what the schema permits, so the fix belongs where it decides. The
 * matrix below was measured against a live workspace, one call per pair.
 *
 * Delete an entry once the server's own schema says it. Upstream wants
 * per-metric enums and a required `project_id`.
 */
export const TOOL_HINTS: Record<string, string> = {
	query_analytics: [
		"",
		"CONSTRAINTS the schema does not express:",
		"- `filters.project_id` is REQUIRED when the API key spans several projects, which is the",
		"  usual case. No tool lists projects. Get an id from `list_traces` at",
		"  `items[].attributes.orq.project_id`, or from the ids this tool enumerates when it rejects",
		"  the call. Ask the user which project they mean rather than picking one silently: each id",
		"  is a slice of the workspace, so the wrong one answers confidently with the wrong data.",
		"- `group_by` valid dimensions per metric, everything else fails as `Unknown expression",
		"  identifier`:",
		"    usage, cost, latency, model_performance -> provider, model, project_id",
		"    errors                                  -> provider, model, project_id, http_status_code",
		"    agents                                  -> provider, model, project_id, http_status_code, agent_name",
		"- `agent_name` therefore works ONLY with `metric: \"agents\"`. To break another metric down",
		"  per agent, query `agents` instead of grouping the other metric by agent_name.",
	].join("\n"),
};

/** Server description plus any constraint it left unsaid. */
export function describe(tool: { name: string; description?: string }): string {
	const base = tool.description ?? tool.name;
	const hint = TOOL_HINTS[tool.name];
	return hint ? `${base}\n${hint}` : base;
}

/**
 * The tools the session actually sees.
 *
 * Filtered at wrap time, not at cache write: the cache keeps the full server
 * list, so flipping ORQI_ALL_TOOLS needs no refetch. Matches on the bare server
 * name, before `TOOL_PREFIX` goes on.
 */
export function keptTools<T extends { name: string }>(
	tools: T[],
	allowAll = process.env.ORQI_ALL_TOOLS === "1",
): T[] {
	return allowAll ? tools : tools.filter((tool) => !DENYLISTED_TOOLS.has(tool.name));
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

/** What a reconnect produced: the credential that won, and tools wrapped for the first time. */
export interface Reconnected {
	credential: Credential;
	count: number;
	added: ToolDefinition[];
	/** Set when the catalogue refresh fell back to the cache. */
	note?: string;
}

/**
 * The boot's outcome plus the live client behind the tools.
 *
 * `credential`, `rejections` and `note` describe the boot and never change:
 * the extension in `src/commands.ts` owns the live connection state, because
 * it is the one that renders it. `reconnect` reports each attempt's outcome
 * through its return value or its rejection, never through these fields.
 */
export interface OrqTools {
	tools: ToolDefinition[];
	/** The candidate the boot's server accepted; undefined when every one was rejected. */
	readonly credential?: Credential;
	/** Why the boot has no credential: one entry per candidate the server turned away. */
	readonly rejections: Rejection[];
	/** Set when the boot's catalogue came from cache because the server was unreachable. */
	readonly note?: string;
	/**
	 * Re-point the wrapped tools at the first accepted credential (login,
	 * workspace switch, or recovery from a rejected boot), then re-run the
	 * catalogue under its normal rules and wrap any tool the session lacks.
	 * Rejects with `CredentialsRejected` when no candidate is accepted, and
	 * with the stall itself when the server did not answer.
	 */
	reconnect: (candidates: Credential[]) => Promise<Reconnected>;
	close: () => Promise<void>;
}

async function connectOnce(credential: Credential): Promise<Client> {
	const client = new Client({ name: "orqi", version: VERSION });
	// A rejected connect leaves the transport open; its later error would surface
	// as an unhandled rejection and take the process down while we are calmly
	// trying the next credential.
	client.onerror = () => {};
	try {
		await client.connect(
			new StreamableHTTPClientTransport(new URL(mcpUrl()), {
				requestInit: { headers: { Authorization: `Bearer ${credential.token}` } },
			}),
			{ timeout: CALL_TIMEOUT_MS },
		);
	} catch (error) {
		await client.close().catch(() => {});
		throw error;
	}
	return client;
}

/** `initialize` hangs as readily as `tools/list` does, so it retries too. */
async function open(credential: Credential): Promise<Client> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
		try {
			return await connectOnce(credential);
		} catch (error) {
			lastError = error;
			if (isAuthError(error)) throw error;
		}
	}
	throw lastError;
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return JSON.stringify(content ?? null);
	return content
		.map((block: any) => (block?.type === "text" ? block.text : JSON.stringify(block)))
		.join("\n");
}

/** Expanded view: indent the JSON so pi has real lines to lay out. */
function prettify(text: string): string {
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return text;
	}
}

/** "12.4 KB" / "840 B" — the size of a payload the model just read. */
function humanSize(bytes: number): string {
	return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * One-line summary of an orq tool result.
 *
 * The server answers with a single unbroken line of JSON, so pi's built-in
 * 10-line preview never trims anything and the terminal soft-wraps a whole
 * screen of it. Summarise the shape instead; the model still receives the full
 * payload, and ctrl+o expands the row.
 */
export function summarize(text: string): string {
	const size = humanSize(Buffer.byteLength(text));
	try {
		const parsed = JSON.parse(text);
		const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.data) ? parsed.data : undefined;
		if (rows) return `${rows.length} ${rows.length === 1 ? "item" : "items"} · ${size}`;
		const keys = parsed && typeof parsed === "object" ? Object.keys(parsed) : [];
		return keys.length ? `${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", …" : ""} · ${size}` : size;
	} catch {
		// Not JSON: fall back to the shape of the text itself.
		const lines = text.split("\n").length;
		return `${lines > 1 ? `${lines} lines · ` : ""}${size}`;
	}
}

/** A rejected credential, as opposed to the server stalling or falling over. */
export function isAuthError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /401|403|invalid_token|Unauthorized|audience/i.test(message);
}

/**
 * What the server said about a rejected credential.
 *
 * The MCP SDK wraps the 401 body in its own prose
 * (`Streamable HTTP error: Error POSTing to endpoint: {"error":"invalid_token",
 * "error_description":"API key is not valid for this workspace…"}`), and the
 * description is the only part that tells a wrong-workspace key from an
 * expired one. Falls back to the message's first line when the body is not
 * the JSON the orq server sends.
 */
export function authReason(error: unknown): string {
	const message = (error instanceof Error ? error.message : String(error)).trim();
	const brace = message.indexOf("{");
	if (brace >= 0) {
		try {
			const parsed = JSON.parse(message.slice(brace));
			const reason = parsed?.error_description ?? parsed?.error;
			if (typeof reason === "string" && reason) return reason;
		} catch {
			// Not JSON: fall through to the prose.
		}
	}
	return message.split("\n")[0]!;
}

/**
 * Connect using the first credential the server actually accepts.
 *
 * Auth failures are immediate and explicit, so they select the next candidate.
 * A stall (the server's intermittent hangs, past `open`'s own retries) is the
 * server's problem and no verdict on that key, so it moves on too: a good
 * login session at candidate 3 must not be lost to a hang on candidate 2.
 * When nothing is accepted, a stall anywhere is reported ahead of the
 * rejections, because "every credential was rejected" would be a claim the
 * server never made. `connect` is injectable so the selection can be tested
 * without a server.
 */
export async function openFirstAccepted(
	candidates: Credential[],
	connect: (credential: Credential) => Promise<Client> = open,
): Promise<{ client: Client; credential: Credential }> {
	const rejections: Rejection[] = [];
	let stall: unknown;
	for (const candidate of candidates) {
		try {
			return { client: await connect(candidate), credential: candidate };
		} catch (error) {
			if (isAuthError(error)) {
				rejections.push({ source: candidate.source, workspace: candidate.workspace, reason: authReason(error) });
			} else {
				stall = error;
			}
		}
	}
	if (stall !== undefined) throw stall;
	throw new CredentialsRejected(rejections);
}

/**
 * Connect to the orq MCP server and expose its tools as pi tools.
 *
 * A rejected credential is not a failed boot: the session still opens, with
 * the tools wrapped from the cached catalogue (any age: stale tools beat none
 * when the server cannot be asked) or none at all, and `reconnect` fills in
 * the rest once a credential is accepted, re-running the catalogue under its
 * normal TTL so a stale cache taken at boot is refreshed then. Only the server
 * being unreachable throws. The wrapped tools read `client` lazily, per call,
 * so they need no connection to exist. `connect` is injectable for tests.
 */
export async function connectOrqTools(
	candidates: Credential[],
	cachePath: string,
	connect: (credential: Credential) => Promise<Client> = open,
): Promise<OrqTools> {
	let client: Client | undefined;
	let credential: Credential | undefined;
	let rejections: Rejection[] = [];
	let note: string | undefined;
	let tools: McpTool[] = [];
	try {
		const accepted = await openFirstAccepted(candidates, connect);
		credential = accepted.credential;
		const listed = await catalogue(accepted.client, cachePath, () => connect(accepted.credential));
		client = listed.client;
		tools = listed.tools;
		note = listed.note;
	} catch (error) {
		if (!(error instanceof CredentialsRejected)) throw error;
		rejections = error.rejections;
		tools = readCache(cachePath) ?? [];
	}

	const wrap = (tool: McpTool): ToolDefinition =>
		defineTool({
			name: `${TOOL_PREFIX}${tool.name}`,
			label: tool.title ?? tool.name,
			description: describe(tool),
			// The MCP schema is already JSON Schema; Unsafe passes it through untouched.
			parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema as object),
			execute: async (_id, params, signal) => {
				if (!client) {
					// Tell the model, so it tells the user, rather than retrying blindly.
					return {
						content: [{ type: "text" as const, text: `orq is not connected: every credential was rejected. ${LOGIN_HINT}` }],
						details: { failed: true },
						isError: true,
					};
				}
				const result = await client.callTool({ name: tool.name, arguments: params as Record<string, unknown> }, undefined, {
					signal,
				});
				const failed = Boolean(result.isError);
				return {
					content: [{ type: "text" as const, text: textOf(result.content) }],
					// pi keeps isError outside the result it hands to renderers, so the
					// flag rides along in details for renderResult below.
					details: { failed },
					isError: failed,
				};
			},
			renderResult: (result, options, theme) => {
				const text = textOf(result.content);
				if (options.expanded) return new Text(theme.fg("toolOutput", prettify(text)), 0, 0);
				const failed = (result.details as { failed?: boolean })?.failed;
				const label = failed ? theme.fg("error", text.slice(0, 200)) : theme.fg("muted", summarize(text));
				return new Text(label, 0, 0);
			},
		});
	// One array for the session's life: pi holds customTools by reference and the
	// subagent tool filters it per call, so tools pushed here reach both.
	const wrapped = keptTools(tools).map(wrap);

	return {
		tools: wrapped,
		credential,
		rejections,
		note,
		reconnect: async (next) => {
			const accepted = await openFirstAccepted(next, connect);
			await client?.close().catch(() => {});
			client = accepted.client;
			// The catalogue under its normal rules, now that the server can be
			// asked: a fresh cache is reused, a stale one (or the any-age cache a
			// rejected boot took) is refetched, and a stall keeps the cache with a
			// note. Only names the session lacks are wrapped, and they are pushed
			// into the one array pi and the subagents hold.
			// ponytail: a tool that vanished from the server stays registered and
			// fails at call time; a changed schema keeps the old one. Rebuild the
			// session's tools if the catalogue ever varies per workspace.
			const listed = await catalogue(client, cachePath, () => connect(accepted.credential));
			client = listed.client;
			const known = new Set(wrapped.map((tool) => tool.name));
			const added = keptTools(listed.tools)
				.filter((tool) => !known.has(`${TOOL_PREFIX}${tool.name}`))
				.map(wrap);
			wrapped.push(...added);
			return { credential: accepted.credential, count: wrapped.length, added, note: listed.note };
		},
		close: async () => {
			await client?.close();
		},
	};
}

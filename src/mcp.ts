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
import { MCP_URL, type Credential } from "./auth.ts";

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

export interface OrqTools {
	tools: ToolDefinition[];
	/** The candidate the server accepted. */
	credential: Credential;
	/** Set when the catalogue came from cache because the server was unreachable. */
	note?: string;
	/** Re-point the wrapped tools at a new credential (login / workspace switch). */
	reconnect: (credential: Credential) => Promise<number>;
	close: () => Promise<void>;
}

async function connectOnce(credential: Credential): Promise<Client> {
	const client = new Client({ name: "orqi", version: "0.1.0" });
	// A rejected connect leaves the transport open; its later error would surface
	// as an unhandled rejection and take the process down while we are calmly
	// trying the next credential.
	client.onerror = () => {};
	try {
		await client.connect(
			new StreamableHTTPClientTransport(new URL(MCP_URL), {
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

function isAuthError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /401|403|invalid_token|Unauthorized|audience/i.test(message);
}

/**
 * Connect using the first credential the server actually accepts.
 *
 * Auth failures are immediate and explicit, so they select the next candidate;
 * anything else (the server's intermittent hangs) is a real error.
 */
async function openFirstAccepted(candidates: Credential[]): Promise<{ client: Client; credential: Credential }> {
	let lastError: unknown = new Error("no orq credential available");
	for (const candidate of candidates) {
		try {
			return { client: await open(candidate), credential: candidate };
		} catch (error) {
			lastError = error;
			if (!isAuthError(error)) throw error;
		}
	}
	throw lastError;
}

/** Connect to the orq MCP server and expose its tools as pi tools. */
export async function connectOrqTools(candidates: Credential[], cachePath: string): Promise<OrqTools> {
	const accepted = await openFirstAccepted(candidates);
	const credential = accepted.credential;
	let client = accepted.client;

	const listed = await catalogue(client, cachePath, () => open(credential));
	client = listed.client;
	const wrapped = listed.tools.map((tool) =>
		defineTool({
			name: `${TOOL_PREFIX}${tool.name}`,
			label: tool.title ?? tool.name,
			description: tool.description ?? tool.name,
			// The MCP schema is already JSON Schema; Unsafe passes it through untouched.
			parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema as object),
			execute: async (_id, params, signal) => {
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
		}),
	);

	return {
		tools: wrapped,
		credential,
		note: listed.note,
		reconnect: async (next) => {
			const replacement = await open(next);
			await client.close().catch(() => {});
			client = replacement;
			// ponytail: assumes the catalogue is identical across workspaces, which
			// it is today. Rebuild the session's tools if that ever stops holding.
			return wrapped.length;
		},
		close: () => client.close(),
	};
}

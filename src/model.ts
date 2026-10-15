/**
 * The orq AI Router as a single pi provider called `orq`.
 *
 * This is a TypeScript port of what `orq launch pi` does in the orq CLI
 * (cli/custom/launch/pi.go + gateway.go): fetch the workspace's enabled models
 * from /v2/models, write a models.json declaring the router as one
 * openai-completions provider, and point pi at it. The key stays out of the
 * file - pi expands `$ORQ_API_KEY` at request time.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { apiBaseUrl, routerUrl } from "./auth.ts";

export const PROVIDER_ID = "orq";
/** The default chat model, and the medium rung `orq/auto` falls back to. */
export const BASE_MODEL = "openai/gpt-5.6-terra";
export const DEFAULT_MODEL = process.env.ORQI_MODEL ?? BASE_MODEL;

const CATALOGUE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export interface ModelInfo {
	id: string;
	/** `agent` is a managed agent served on the Responses API as `agent/<key>`. */
	kind?: "chat" | "agent" | "classifier";
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	responses?: boolean;
	/** USD per million tokens, from the workspace catalogue, so pi's footer and /session cost are real. */
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	/** Artificial Analysis intelligence index (`metadata.autorouter.v2`), for ranking routing rungs. */
	intelligence?: number;
	/** Agents only: status, the model it runs on, and what it carries. */
	agent?: {
		/** Studio's id for the agent (`_id`): its page is routed by this, not by the key. */
		id?: string;
		status: string;
		model?: string;
		tools: number;
		knowledgeBases: number;
		memory: number;
		team: number;
		totalCost?: number;
		updated?: string;
		description?: string;
	};
}

/** Fallback when /v2/models is unreachable: enough to start a session. */
const FALLBACK: ModelInfo[] = [{ id: DEFAULT_MODEL, responses: true }];

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/**
 * Map one `/v2/models` entry, or undefined when orqi has no use for it.
 *
 * Chat models need tool calling (as the orq CLI filters), so search models
 * and embeddings are skipped even when enabled. Classifier models
 * (`model_type: "classify"`) are kept for the Decisions API router.
 */
export function modelInfo(model: any): ModelInfo | undefined {
	if (!model?.enabled) return undefined;
	// refId is the canonical invoke id; custom models (smart routers) are
	// "workspace@orq/<name>" and cannot be rebuilt from provider/model_id.
	const id: string = model.refId || `${model.provider}/${model.model_id}`;
	const meta = model.metadata ?? {};
	if (model.model_type === "classify") return { id, kind: "classifier", contextWindow: num(meta.context_window) };
	if (model.model_type !== "chat" || !model.has_functions) return undefined;
	const input = num(meta.million_tokens_input_cost);
	const output = num(meta.million_tokens_output_cost);
	return {
		id,
		contextWindow: num(meta.context_window),
		maxTokens: num(meta.max_output_tokens),
		responses: Boolean(meta.supports_responses_api),
		...(input !== undefined || output !== undefined
			? {
					cost: {
						input: input ?? 0,
						output: output ?? 0,
						cacheRead: num(meta.million_tokens_cache_read_cost) ?? 0,
						cacheWrite: num(meta.million_tokens_cache_write_cost) ?? 0,
					},
				}
			: {}),
		...(num(meta.autorouter?.v2?.intelligence_index) !== undefined ? { intelligence: meta.autorouter.v2.intelligence_index } : {}),
	};
}

/**
 * Map one `/v2/agents` entry to a model, or undefined for drafts.
 *
 * A managed agent is a model on the Responses API: `POST /v3/router/responses`
 * with `model: "agent/<key>"`. Its context window is the window of the model
 * it runs on, looked up in `chat`.
 */
export function agentInfo(agent: any, chat: ModelInfo[]): ModelInfo | undefined {
	if (!agent?.key) return undefined;
	const status = String(agent.status ?? "");
	const modelId: string | undefined = typeof agent.model === "string" ? agent.model : agent.model?.id;
	const base = chat.find((model) => model.id === modelId);
	return {
		id: `agent/${agent.key}`,
		kind: "agent",
		name: `${agent.display_name || agent.key} (agent)`,
		responses: true,
		contextWindow: base?.contextWindow,
		maxTokens: base?.maxTokens,
		cost: base?.cost,
		agent: {
			id: typeof agent._id === "string" ? agent._id : undefined,
			status,
			model: modelId,
			tools: agent.settings?.tools?.length ?? 0,
			knowledgeBases: agent.knowledge_bases?.length ?? 0,
			memory: agent.memory_stores?.length ?? 0,
			team: agent.team_of_agents?.length ?? 0,
			totalCost: num(agent.metrics?.total_cost),
			updated: agent.updated,
			description: agent.description || undefined,
		},
	};
}

/** Agents that can be talked to: live or published. Drafts are listed, dim, but never offered as models. */
export const talkable = (model: ModelInfo) => model.kind === "agent" && ["live", "published"].includes(model.agent?.status ?? "");

async function getJson(path: string, token: string): Promise<any> {
	const res = await fetch(`${apiBaseUrl()}${path}`, {
		headers: { Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
	return res.json();
}

/** Enabled chat and classifier models, plus the workspace's agents. */
async function fetchModels(token: string): Promise<ModelInfo[]> {
	const payload = (await getJson("/v2/models", token)) as any[];
	const models = payload.map(modelInfo).filter((model): model is ModelInfo => Boolean(model));
	const chat = models.filter((model) => !model.kind);
	// Agents are a bonus: a key without agent read access still gets its models.
	const agents = await getJson("/v2/agents?limit=200", token)
		.then((body) =>
			((body?.data ?? []) as any[]).map((agent) => agentInfo(agent, chat)).filter((agent): agent is ModelInfo => Boolean(agent)),
		)
		.catch(() => [] as ModelInfo[]);
	return [...models, ...agents].sort((a, b) => a.id.localeCompare(b.id));
}

/** Which credential a cached catalogue belongs to: what one key sees, another may not. */
const ownerOf = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 16);

/**
 * The workspace's models and agents, cached for a day per credential: a cache
 * another credential wrote (a key with no agent access, say) is refetched, not
 * served, and is only the fallback when the API cannot be reached at all.
 */
export async function catalogue(token: string, cachePath: string): Promise<{ models: ModelInfo[]; note?: string }> {
	let cached: { owner?: string; models?: ModelInfo[] } | undefined;
	try {
		cached = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : undefined;
	} catch {
		// A torn write: refetch.
	}
	const fresh = existsSync(cachePath) && Date.now() - statSync(cachePath).mtimeMs < CATALOGUE_TTL_MS;
	if (cached?.models?.length && cached.owner === ownerOf(token) && fresh && !process.env.ORQI_REFRESH_MODELS) {
		return { models: cached.models };
	}
	try {
		const models = await fetchModels(token);
		if (!models.some((model) => !model.kind)) throw new Error("no enabled chat models with tool calling in this workspace");
		writeFileSync(cachePath, JSON.stringify({ owner: ownerOf(token), models }));
		return { models };
	} catch (error) {
		const note = `model catalogue unavailable (${error instanceof Error ? error.message : error})`;
		return { models: cached?.models?.length ? cached.models : FALLBACK, note };
	}
}

/**
 * Hide every provider except `orq`.
 *
 * pi composes its built-in providers from whatever credentials it finds in the
 * environment, so a machine with an HF or Anthropic key gets hundreds of models
 * in the picker that this CLI has no business routing to. There is no built-in
 * knob for that, so the model reads are filtered on the way out and everything
 * downstream (the `/model` picker, the footer, ctrl+p cycling) follows.
 */
export function onlyOrq(runtime: ModelRuntime): ModelRuntime {
	// orqi's own: the router, and the Decisions API classifiers `orq/auto` uses.
	const ours = new Set([PROVIDER_ID, "orq-decisions"]);
	const mine = (model: { provider: string }) => ours.has(model.provider);
	return new Proxy(runtime, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			const fn = value.bind(target);
			switch (prop) {
				case "getProviders":
					// Only the router: pi lists these in /login, and a key pasted against the
					// classifier provider would sit under `orq-decisions`, which nothing reads.
					// Lookups by id below still reach it, so `orq/auto` resolves.
					return () => fn().filter((provider: { id: string }) => provider.id === PROVIDER_ID);
				case "getProvider":
					return (id: string) => (ours.has(id) ? fn(id) : undefined);
				case "getModels":
				case "getAvailableSnapshot":
					return (...args: unknown[]) => fn(...args).filter(mine);
				case "getAvailable":
					return async (...args: unknown[]) => (await fn(...args)).filter(mine);
				case "getModel":
					return (provider: string, id: string) => (ours.has(provider) ? fn(provider, id) : undefined);
				default:
					return fn;
			}
		},
	});
}

export interface OrqModels {
	runtime: ModelRuntime;
	/** Chat model ids offered by the router, best-effort. */
	ids: string[];
	/** The whole catalogue: chat models, agents (drafts included) and classifiers. */
	catalogue: ModelInfo[];
	note?: string;
}

/**
 * Headers on every router call. Values are `$ENV` templates pi resolves per
 * request, so the thread id follows the session (`/new` and `/fork` mint a
 * new one, `/resume` keeps it) and subagents, which share this provider,
 * land in the parent's thread. `x-client-type: pi` is what the gateway's
 * trace-framework detection recognises; it has no `orqi` entry yet.
 */
export function routerHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	return {
		"X-ORQ-THREAD-ID": "$ORQI_THREAD_ID",
		"x-client-type": "pi",
		"X-ORQ-METADATA-source": "orqi",
		...(env.ORQI_REPO ? { "X-ORQ-METADATA-repo": "$ORQI_REPO" } : {}),
		// Workshop instructors filter the Threads tab by tag.
		...(env.ORQI_TAG ? { "X-ORQ-METADATA-tag": "$ORQI_TAG" } : {}),
	};
}

/**
 * Write models.json into the orqi agent dir and build a runtime over it.
 * The user's own ~/.pi is never touched.
 */
/** models.json: the router as one provider, the offered models with their prices. */
function writeModelsJson(agentDir: string, models: ModelInfo[]): void {
	const offered = models.filter((model) => !model.kind || talkable(model));
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify(
			{
				providers: {
					[PROVIDER_ID]: {
						baseUrl: routerUrl(),
						apiKey: "$ORQ_API_KEY",
						api: "openai-completions",
						headers: routerHeaders(),
						models: offered.map((model) => ({
							id: model.id,
							name: model.name ?? model.id,
							// An agent reasons (or not) on its own model; a reasoning effort would be rejected.
							reasoning: model.kind !== "agent",
							input: ["text"],
							contextWindow: model.contextWindow || 200000,
							maxTokens: model.maxTokens || 16384,
							cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							// Per-model override; the provider default stays chat completions.
							...(model.responses ? { api: "openai-responses" } : {}),
						})),
					},
				},
			},
			null,
			2,
		),
		{ mode: 0o600 },
	);
}

const CACHE_FILE = "model-catalogue.v3.json"; // v3: keyed to the credential that fetched it; v2 served one key's view to every key

export async function createOrqModelRuntime(agentDir: string, token: string): Promise<OrqModels> {
	mkdirSync(agentDir, { recursive: true });
	const { models, note } = await catalogue(token, join(agentDir, CACHE_FILE));
	process.env.ORQI_THREAD_ID ??= crypto.randomUUID();
	writeModelsJson(agentDir, models);
	// The resolved credential may be a login-session token rather than the
	// exported key, so make $ORQ_API_KEY agree with whatever auth resolved.
	process.env.ORQ_API_KEY = token;
	const runtime = await ModelRuntime.create({
		modelsPath: join(agentDir, "models.json"),
		authPath: join(agentDir, "auth.json"),
	});
	return { runtime: onlyOrq(runtime), ids: models.filter((model) => !model.kind).map((model) => model.id), catalogue: models, note };
}

/**
 * Fetch the catalogue again with a credential that works and reload the
 * running runtime from it. A boot with no credential (the welcome) started on
 * the one-model fallback; without this, /model, orq/auto and /agents stayed
 * that thin until a restart. Mutates `models` so every reader sees the change.
 */
export async function refreshOrqModels(agentDir: string, token: string, models: OrqModels): Promise<boolean> {
	const prior = process.env.ORQI_REFRESH_MODELS;
	process.env.ORQI_REFRESH_MODELS = "1";
	try {
		const { models: fresh, note } = await catalogue(token, join(agentDir, CACHE_FILE));
		if (note) return false;
		writeModelsJson(agentDir, fresh);
		await models.runtime.refresh();
		models.catalogue = fresh;
		models.ids = fresh.filter((model) => !model.kind).map((model) => model.id);
		models.note = undefined;
		return true;
	} finally {
		if (prior === undefined) delete process.env.ORQI_REFRESH_MODELS;
		else process.env.ORQI_REFRESH_MODELS = prior;
	}
}

/** The configured default if the workspace has it, else the first enabled model. */
export function pickModel(models: OrqModels, id = DEFAULT_MODEL) {
	// `orq/auto` is the virtual model: provider `orq`, id `auto`.
	const wanted = id.startsWith("orq/") ? id.slice(4) : id;
	return (
		models.runtime.getModel(PROVIDER_ID, wanted) ??
		models.runtime.getModel(PROVIDER_ID, BASE_MODEL) ??
		models.runtime.getModel(PROVIDER_ID, models.ids[0])
	);
}

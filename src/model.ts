/**
 * The orq AI Router as a single pi provider called `orq`.
 *
 * This is a TypeScript port of what `orq launch pi` does in the orq CLI
 * (cli/custom/launch/pi.go + gateway.go): fetch the workspace's enabled models
 * from /v2/models, write a models.json declaring the router as one
 * openai-completions provider, and point pi at it. The key stays out of the
 * file - pi expands `$ORQ_API_KEY` at request time.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { API_BASE_URL, ROUTER_URL } from "./auth.ts";

export const PROVIDER_ID = "orq";
export const DEFAULT_MODEL = process.env.ORQI_MODEL ?? "openai/gpt-5.6-terra";

const CATALOGUE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

interface ModelInfo {
	id: string;
	contextWindow?: number;
	maxTokens?: number;
	responses?: boolean;
}

/** Fallback when /v2/models is unreachable: enough to start a session. */
const FALLBACK: ModelInfo[] = [{ id: DEFAULT_MODEL, responses: true }];

/**
 * Enabled chat models for this workspace.
 *
 * Mirrors the orq CLI's filter: a coding agent needs tool calling, so models
 * without it (search models, embeddings) are skipped even when enabled.
 */
async function fetchModels(token: string): Promise<ModelInfo[]> {
	const res = await fetch(`${API_BASE_URL}/v2/models`, {
		headers: { Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`GET /v2/models: ${res.status} ${(await res.text()).slice(0, 200)}`);
	const payload = (await res.json()) as any[];
	return payload
		.filter((model) => model.enabled && model.model_type === "chat" && model.has_functions)
		.map((model) => ({
			// refId is the canonical invoke id; custom models (autorouters) are
			// "workspace@orq/<name>" and cannot be rebuilt from provider/model_id.
			id: model.refId || `${model.provider}/${model.model_id}`,
			contextWindow: model.metadata?.context_window,
			maxTokens: model.metadata?.max_output_tokens,
			responses: Boolean(model.metadata?.supports_responses_api),
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
}

async function catalogue(token: string, cachePath: string): Promise<{ models: ModelInfo[]; note?: string }> {
	const cached = existsSync(cachePath) ? (JSON.parse(readFileSync(cachePath, "utf8")) as ModelInfo[]) : undefined;
	if (cached?.length && !process.env.ORQI_REFRESH_MODELS && Date.now() - statSync(cachePath).mtimeMs < CATALOGUE_TTL_MS) {
		return { models: cached };
	}
	try {
		const models = await fetchModels(token);
		if (models.length === 0) throw new Error("no enabled chat models with tool calling in this workspace");
		writeFileSync(cachePath, JSON.stringify(models));
		return { models };
	} catch (error) {
		const note = `model catalogue unavailable (${error instanceof Error ? error.message : error})`;
		return { models: cached?.length ? cached : FALLBACK, note };
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
	const mine = (model: { provider: string }) => model.provider === PROVIDER_ID;
	return new Proxy(runtime, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			const fn = value.bind(target);
			switch (prop) {
				case "getProviders":
					return () => fn().filter((provider: { id: string }) => provider.id === PROVIDER_ID);
				case "getProvider":
					return (id: string) => (id === PROVIDER_ID ? fn(id) : undefined);
				case "getModels":
				case "getAvailableSnapshot":
					return (...args: unknown[]) => fn(...args).filter(mine);
				case "getAvailable":
					return async (...args: unknown[]) => (await fn(...args)).filter(mine);
				case "getModel":
					return (provider: string, id: string) => (provider === PROVIDER_ID ? fn(provider, id) : undefined);
				default:
					return fn;
			}
		},
	});
}

export interface OrqModels {
	runtime: ModelRuntime;
	/** Model ids offered by the router, best-effort. */
	ids: string[];
	note?: string;
}

/**
 * Write models.json into the orqi agent dir and build a runtime over it.
 * The user's own ~/.pi is never touched.
 */
export async function createOrqModelRuntime(agentDir: string, token: string): Promise<OrqModels> {
	mkdirSync(agentDir, { recursive: true });
	const { models, note } = await catalogue(token, join(agentDir, "model-catalogue.json"));

	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify(
			{
				providers: {
					[PROVIDER_ID]: {
						baseUrl: ROUTER_URL,
						apiKey: "$ORQ_API_KEY",
						api: "openai-completions",
						models: models.map((model) => ({
							id: model.id,
							name: model.id,
							reasoning: true,
							input: ["text"],
							contextWindow: model.contextWindow || 200000,
							maxTokens: model.maxTokens || 16384,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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

	// The resolved credential may be a login-session token rather than the
	// exported key, so make $ORQ_API_KEY agree with whatever auth resolved.
	process.env.ORQ_API_KEY = token;
	const runtime = await ModelRuntime.create({
		modelsPath: join(agentDir, "models.json"),
		authPath: join(agentDir, "auth.json"),
	});
	return { runtime: onlyOrq(runtime), ids: models.map((model) => model.id), note };
}

/** The configured default if the workspace has it, else the first enabled model. */
export function pickModel(models: OrqModels) {
	return models.runtime.getModel(PROVIDER_ID, DEFAULT_MODEL) ?? models.runtime.getModel(PROVIDER_ID, models.ids[0]);
}

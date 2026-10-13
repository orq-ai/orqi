/**
 * Zero-setup onboarding for a workshop: a first run with no credential opens
 * anyway and asks how to sign in, and `/learn` hands out one guided prompt per
 * platform area.
 *
 * The welcome reuses the recovery machinery in `src/commands.ts`: a pasted key
 * lands where pi's `/login orq` would store it (candidate #0), and the
 * reconnect that follows is the same one the `input` hook runs.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const WELCOME_TITLE = "orqi talks to your orq.ai workspace. How do you want to sign in?";
export const WELCOME_OPTIONS = {
	key: "Paste an API key          from my.orq.ai › Settings › API keys",
	browser: "Sign in with the browser  runs `orq auth login`",
	look: "Just look around          docs and /whatsnew only, no workspace",
} as const;
export type WelcomeChoice = keyof typeof WELCOME_OPTIONS;

/** Which option a `select` label was. */
export function welcomeChoice(label: string | undefined): WelcomeChoice | undefined {
	return (Object.keys(WELCOME_OPTIONS) as WelcomeChoice[]).find((key) => WELCOME_OPTIONS[key] === label);
}

/**
 * Store an orq API key exactly where pi's `/login orq` does: `auth.json`,
 * `{ orq: { type: "api_key", key } }`, merged with whatever else is there,
 * owner-only. pi does not export its store, and the shape is what its own
 * `readStoredCredential` reads.
 */
export function saveLoginKey(authPath: string, key: string): void {
	let data: Record<string, unknown> = {};
	if (existsSync(authPath)) {
		try {
			data = JSON.parse(readFileSync(authPath, "utf8"));
		} catch {
			// A corrupt store is replaced rather than left blocking the login.
		}
	}
	data.orq = { type: "api_key", key };
	mkdirSync(dirname(authPath), { recursive: true });
	writeFileSync(authPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
	chmodSync(authPath, 0o600);
}

/** What a pasted key looks like: no whitespace, and long enough to be one. */
export function plausibleKey(text: string | undefined): string | undefined {
	const key = text?.trim();
	return key && !/\s/.test(key) && key.length >= 20 ? key : undefined;
}

/** The browser sign-in URL out of `orq auth login` output, for terminals that cannot open one. */
export function loginUrl(output: string): string | undefined {
	return output.match(/https?:\/\/\S+/)?.[0];
}

/** `/learn`: one prompt per platform area, sent as if typed. */
export const LEARN_PROMPTS: { area: string; prompt: string }[] = [
	{ area: "Agents", prompt: "list my agents and say which ones have no evaluators" },
	{ area: "Analytics", prompt: "show cost by model for the last 7 days" },
	{ area: "Traces", prompt: "find the slowest trace today and explain why it is slow" },
	{ area: "Routing", prompt: "what would orq/auto have saved on this session so far? use /cost numbers if you can" },
	{ area: "Evaluators", prompt: "create a Pass/Fail evaluator for hallucinated prices (show me the definition first, do not create it yet)" },
	{ area: "Docs", prompt: "how do memory stores differ from knowledge bases" },
];

export function learnRows(): string[] {
	return LEARN_PROMPTS.map((item, i) => `${i + 1}  ${item.area.padEnd(12)} ${item.prompt}`);
}

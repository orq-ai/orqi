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
import { matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";

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

/**
 * How a key is drawn while it is typed or pasted: dots, then the last four
 * characters so you can tell the paste landed, then its length. The key
 * itself never reaches the screen (or a screenshot, or a recording).
 */
export function maskKey(value: string): string {
	if (!value) return "";
	const tail = value.length > 8 ? value.slice(-4) : "";
	return `${"•".repeat(Math.min(24, value.length - tail.length))}${tail}  (${value.length} chars)`;
}

/**
 * A one-line secret input. pi-tui's `Input` draws what it holds, and pi's
 * own `/login` uses it, so a pasted key shows in clear text there; this is
 * what orqi's own key prompts (`/key`, the first-run welcome) use instead.
 */
export class MaskedInput implements Component {
	private value = "";
	private pasting = false;

	constructor(
		private label: string,
		private onSubmit: (value: string) => void,
		private onCancel: () => void,
		private paint: { label(text: string): string; dim(text: string): string } = { label: (s) => s, dim: (s) => s },
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const shown = this.value ? maskKey(this.value) : this.paint.dim("paste the key, then enter");
		return [
			truncateToWidth(`${this.paint.label(this.label)}  ${shown}`, width),
			truncateToWidth(this.paint.dim("enter save · esc cancel · the key is never shown"), width),
		];
	}

	handleInput(data: string): void {
		// Bracketed paste arrives wrapped in markers, sometimes split across chunks.
		let text = data;
		if (text.includes("\x1b[200~")) {
			this.pasting = true;
			text = text.replace("\x1b[200~", "");
		}
		if (text.includes("\x1b[201~")) {
			this.pasting = false;
			text = text.replace("\x1b[201~", "");
			this.value += text.replace(/[\x00-\x1f\x7f]/g, "");
			return;
		}
		if (this.pasting) {
			this.value += text.replace(/[\x00-\x1f\x7f]/g, "");
			return;
		}
		if (matchesKey(text, "enter")) this.onSubmit(this.value.trim());
		else if (matchesKey(text, "escape")) this.onCancel();
		else if (matchesKey(text, "backspace")) this.value = this.value.slice(0, -1);
		else if (!/[\x00-\x1f\x7f]/.test(text)) this.value += text; // typed characters (or an unbracketed paste)
	}
}

/** Checks for the workshop onboarding: the welcome's three paths, /learn, the header. */

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { loginKey } from "./auth.ts";
import { normalizeCommand } from "./frontmatter.ts";
import { headerLines } from "./branding.ts";
import { NO_CREDENTIAL, orqCommands } from "./commands.ts";
import { learnRows, LEARN_PROMPTS, loginUrl, MaskedInput, maskKey, plausibleKey, saveLoginKey, WELCOME_OPTIONS, welcomeChoice } from "./onboarding.ts";

test("a pasted key lands where pi's /login orq keeps it, merged and owner-only", () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-auth-"));
	try {
		const path = join(dir, "auth.json");
		writeFileSync(path, JSON.stringify({ anthropic: { type: "api_key", key: "keep-me" } }));
		saveLoginKey(path, "sk-orq-0123456789abcdef");
		expect(loginKey(path)).toBe("sk-orq-0123456789abcdef"); // what orqi reads back as candidate #0
		expect(JSON.parse(readFileSync(path, "utf8")).anthropic.key).toBe("keep-me");
		expect(statSync(path).mode & 0o777).toBe(0o600);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the welcome's helpers", () => {
	expect(welcomeChoice(WELCOME_OPTIONS.browser)).toBe("browser");
	expect(welcomeChoice(undefined)).toBeUndefined(); // esc
	expect(plausibleKey("  sk-orq-0123456789abcdef \n")).toBe("sk-orq-0123456789abcdef");
	expect(plausibleKey("not a key")).toBeUndefined();
	expect(plausibleKey("")).toBeUndefined();
	expect(loginUrl("Open https://my.orq.ai/device?code=ABCD to sign in")).toBe("https://my.orq.ai/device?code=ABCD");
	expect(learnRows()).toHaveLength(6);
	expect(learnRows()[0]).toBe(`1  Agents       ${LEARN_PROMPTS[0]!.prompt}`);
});

/** Run the welcome through orqCommands with a scripted UI. */
async function runWelcome(answers: (string | undefined)[], reconnectOk = true) {
	const dir = mkdtempSync(join(tmpdir(), "orqi-welcome-"));
	const notices: string[] = [];
	const drawn: string[] = [];
	let reconnects = 0;
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const pi = { registerEntryRenderer: () => {}, registerCommand: () => {}, registerTool: () => {}, appendEntry: () => {}, on: (name: string, fn: any) => handlers.set(name, fn) } as any;
	const queue = [...answers];
	const ctx = {
		hasUI: true,
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: () => {},
			setWidget: () => {},
			select: async () => queue.shift(),
			input: async () => queue.shift(),
			// The masked prompt: paste the next answer, then press enter, as a user would.
			custom: (factory: any) =>
				new Promise((resolve) => {
					const component = factory(null, { fg: (_token: string, text: string) => text }, null, resolve);
					component.handleInput(`\x1b[200~${queue.shift() ?? ""}\x1b[201~`);
					drawn.push(...component.render(80));
					component.handleInput("\r");
				}),
		},
	};
	const header = { name: "orqi", version: "v0", status: "", cwd: "~" };
	const candidates = (path: string) => {
		const key = loginKey(path);
		return { candidates: key ? [{ token: key, source: "/login key" }] : [] };
	};
	orqCommands(
		async (next) => {
			reconnects++;
			if (!reconnectOk) throw new Error("stalled");
			return { credential: next[0]!, added: [] };
		},
		[],
		header,
		dir,
		{ rejections: [{ source: NO_CREDENTIAL, reason: "nothing found" }], welcome: true, readCandidates: candidates as any },
	)(pi);
	handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
	await new Promise((resolve) => setTimeout(resolve, 120));
	rmSync(dir, { recursive: true, force: true });
	return { notices, reconnects, drawn };
}

test("welcome, paste a key: stored, then the same reconnect the input hook runs", async () => {
	const { notices, reconnects, drawn } = await runWelcome([WELCOME_OPTIONS.key, "sk-orq-0123456789abcdef"]);
	expect(reconnects).toBe(1);
	expect(drawn.join("\n")).not.toContain("0123456789"); // the key is never drawn
	expect(notices).toContain("connecting to orq…");
	expect(notices.at(-1)).toStartWith("Connected to orq");
});

test("welcome, look around: no connection attempted, the next steps named", async () => {
	const { notices, reconnects } = await runWelcome([WELCOME_OPTIONS.look]);
	expect(reconnects).toBe(0);
	expect(notices.at(-1)).toContain("/whatsnew");
});

test("welcome, no key pasted: says so and keeps the hint", async () => {
	const { notices, reconnects } = await runWelcome([WELCOME_OPTIONS.key, "   "]);
	expect(reconnects).toBe(0);
	expect(notices.at(-1)).toContain("does not look like an API key");
});

test("the header names the day-one views", () => {
	const text = headerLines({ name: "orqi", version: "v0.2.0", status: "orq/auto · 44 tools", cwd: "~" }, { cols: 100, rows: 40 }).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	expect(text).toContain("orqi (aka TonyBot) v0.2.0");
	expect(text).toContain("/learn · /route · /cost · /trace · /agents · /whatsnew · alt+m minimap");
	expect(text).not.toContain("changelog https://"); // /whatsnew replaces the bare URL
});

test("a pasted key is never drawn: dots and the last four characters only", () => {
	expect(maskKey("sk-orq-01M45V72F0SX0RZM4CS2F5YZZT-96bca93010cf2938da1654")).toBe(`${"•".repeat(24)}1654  (56 chars)`);
	expect(maskKey("abc")).toBe("•••  (3 chars)");
	expect(maskKey("")).toBe("");
});

test("the masked input takes a bracketed paste, edits, submits and cancels", () => {
	let submitted: string | undefined;
	let cancelled = false;
	const input = new MaskedInput("API key", (value) => (submitted = value), () => (cancelled = true));
	input.handleInput("\x1b[200~sk-orq-0123456789abcdef\x1b[201~");
	input.handleInput("x");
	input.handleInput("\x7f"); // backspace
	const screen = input.render(60).join("\n");
	expect(screen).not.toContain("0123456789");
	expect(screen).toContain("cdef");
	input.handleInput("\r");
	expect(submitted).toBe("sk-orq-0123456789abcdef");
	new MaskedInput("API key", () => {}, () => (cancelled = true)).handleInput("\x1b");
	expect(cancelled).toBe(true);
});

test("plugin command frontmatter that YAML rejects is quoted, everything else is left alone", () => {
	const bad = "---\nname: orq-manage-skills\nargument-hint: [list|get|create] [name-or-id]\nallowed-tools: AskUserQuestion, orq*\n---\n# Body $ARGUMENTS\n";
	const fixed = normalizeCommand(bad);
	expect(parse(fixed.split("---\n")[1]!)).toEqual({ name: "orq-manage-skills", "argument-hint": "[list|get|create] [name-or-id]", "allowed-tools": "AskUserQuestion, orq*" });
	expect(fixed.endsWith("# Body $ARGUMENTS\n")).toBe(true);
	const good = "---\ndescription: fine\nargument-hint: \"[x]\"\n---\nbody\n";
	expect(normalizeCommand(good)).toBe(good);
	expect(normalizeCommand("no frontmatter")).toBe("no frontmatter");
});

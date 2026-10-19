/** Cross-cutting checks: themes, the header, model filtering, and the names orqi registers with pi. Run with `bun test`. */

import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PI_DIST, PI_FILES } from "../scripts/pi-files.ts";
import { resolveSession } from "./resume.ts";
import { headerLines, terminalProgress } from "./branding.ts";
import { ORQI_COMMANDS, orqCommands } from "./connection.ts";
import { composeLayout, orqHarness } from "./harness.ts";
import { catalogue, onlyOrq, PROVIDER_ID } from "./model.ts";

const noReconnect = async () => ({ credential: { token: "", source: "" }, count: 0, added: [] });

test("every theme's text stays legible on a light-ish dark background", () => {
	// The terminal background belongs to the user. Ghostty and the One Dark
	// family sit near #282C34, where the first amber ramp measured 3.7:1 and read
	// as washed out. Tuning against near-black hid that, so the floor is checked
	// against the lightest plausible background instead.
	const luminance = (hex: string) => {
		const parts = [1, 3, 5]
			.map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
			.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
		return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
	};
	const contrast = (a: string, b: string) => {
		const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
		return (hi + 0.05) / (lo + 0.05);
	};
	// Roles pi paints as text. Borders and backgrounds are decoration and exempt.
	const textRoles = [
		"text",
		"muted",
		"dim",
		"thinkingText",
		"toolTitle",
		"toolOutput",
		"mdHeading",
		"mdLinkUrl",
		"mdQuote",
		"toolDiffContext",
		"syntaxComment",
		"userMessageText",
		"customMessageText",
		"accent",
		"warning",
		// pi colours the working message ("thinking", a tool name) with the editor
		// border, which follows the thinking level: these are text, not decoration.
		"thinkingOff",
		"thinkingMinimal",
		"thinkingLow",
		"thinkingMedium",
		"thinkingHigh",
		"thinkingXhigh",
	];
	const LIGHTEST_BG = "#282C34";

	// Our own three, plus the lightened @spences10/pi-themes pack (scripts/lift-themes.ts).
	const themesDir = join(import.meta.dir, "..", "themes");
	const files = [
		...["orq-dark.json", "orq-slate.json", "orq-signal.json"].map((f) => join(themesDir, f)),
		...readdirSync(join(themesDir, "pack"))
			.filter((f) => f.endsWith(".json"))
			.map((f) => join(themesDir, "pack", f)),
	];
	for (const path of files) {
		const file = path.slice(themesDir.length + 1);
		const theme = JSON.parse(readFileSync(path, "utf8"));
		const resolve = (value: string) => (value?.startsWith("#") ? value : theme.vars?.[value]);

		// A colour naming a var that no longer exists renders as nothing at all.
		const dangling = Object.entries(theme.colors as Record<string, string>)
			.filter(([, v]) => typeof v === "string" && v !== "" && !v.startsWith("#") && !(v in (theme.vars ?? {})))
			.map(([role]) => `${file}:${role}`);
		expect(dangling).toEqual([]);

		const unreadable = textRoles
			.filter((role) => theme.colors[role])
			.map((role) => ({ role, ratio: contrast(resolve(theme.colors[role]), LIGHTEST_BG) }))
			.filter(({ ratio }) => ratio < 4.5)
			.map(({ role, ratio }) => `${file}:${role} ${ratio.toFixed(2)}`);
		expect(unreadable).toEqual([]);
	}
});

test("the theme pack loads in pi and shadows no theme", async () => {
	// The pack under themes/pack is generated; it must still validate, or pi drops
	// it at startup with a diagnostic, and it must ship its upstream licence.
	const { validateThemeJson } = await import(join(PI_DIST, "modes/interactive/theme/theme-schema.js"));
	const root = join(import.meta.dir, "..", "themes");
	const pack = join(root, "pack");
	const ours = readdirSync(root)
		.filter((f) => f.endsWith(".json"))
		.map((f) => f.replace(/\.json$/, ""));
	const names = readdirSync(pack)
		.filter((f) => f.endsWith(".json"))
		.map((file) => {
			const theme = JSON.parse(readFileSync(join(pack, file), "utf8"));
			validateThemeJson(file, theme);
			return theme.name;
		});
	expect(names.length).toBe(10);
	expect(names).not.toContain("rose-pine");
	expect(names.filter((n) => [...ours, "dark", "light", "system"].includes(n))).toEqual([]);
	expect(existsSync(join(pack, "LICENSE"))).toBe(true);
});

test("the panel sits beside the content column and the editor and footer keep the full width", async () => {
	const { VStack } = await import("@earendil-works/pi-tui");
	const part = () => ({ render: () => [], invalidate() {} });
	const [transcript, notice, editor, footer, header, panel] = [part(), part(), part(), part(), part(), part()];
	const entry = (component: any, extra = {}) => ({ component, basis: "auto" as const, grow: 0, shrink: 1, minSize: 0, ...extra });
	const dock = new VStack([entry(notice), entry(editor, { minSize: 3 }), entry(footer)]);
	const piRoot = new VStack([entry(transcript, { basis: 0, grow: 1, minSize: 1 }), entry(dock, { minSize: 1 })]);
	const children = (stack: any) => stack.entries.map((e: any) => e.component);
	const lay = (root: any) => (composeLayout(root, header, { component: panel, basis: 10, shrink: 0 }) as any).entries;

	// header; then [transcript + notices] beside the panel; then editor + footer across the full width
	const [top, body, bottom] = lay(piRoot);
	expect(top.component).toBe(header);
	const [column, side] = body.component.entries.map((e: any) => e.component);
	expect(side).toBe(panel);
	expect(children(column)).toEqual([transcript, notice]);
	expect(children(bottom.component)).toEqual([editor, footer]);

	// A dock with no editor entry keeps the whole dock full width.
	const plainDock = new VStack([entry(notice), entry(footer)]);
	const noEditor = new VStack([entry(transcript, { basis: 0, grow: 1 }), entry(plainDock)]);
	const [, body2, bottom2] = lay(noEditor);
	expect(body2.component.entries[0].component).toBe(transcript);
	expect(bottom2.component).toBe(plainDock);

	// A pi that reshapes its root: the panel falls back to sitting beside all of it, nothing is lost.
	const odd = part();
	const fallback = lay(odd);
	expect(fallback.length).toBe(2);
	expect(fallback[1].component.entries.map((e: any) => e.component)).toEqual([odd, panel]);
});

test("every command AGENTS.md names exists", () => {
	// Agents run what AGENTS.md tells them to. Same pattern as the factory-quality-scan
	// agents_md_fresh check, which also reads prose like "just a stall" as a command,
	// so a match here that is not a command means rewording the sentence.
	const root = join(import.meta.dir, "..");
	const scripts = Object.keys(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts);
	const ok = new Set([...scripts, "install", "ci", "test", "start", "add", "remove", "dlx", "exec", "x", "i"]);
	const named = [
		...readFileSync(join(root, "AGENTS.md"), "utf8").matchAll(/\b(npm run|pnpm(?: run)?|yarn|bun run|make|just)\s+([A-Za-z0-9:_.-]+)/g),
	];
	// No Makefile or justfile, so any make/just target is stale.
	expect(named.filter(([, tool, name]) => tool === "make" || tool === "just" || !ok.has(name)).map((m) => m[0])).toEqual([]);
});

test("every command orqi registers is in ORQI_COMMANDS, so the plugin never shadows one", () => {
	const registered: string[] = [];
	const pi = {
		registerEntryRenderer: () => {},
		registerCommand: (name: string) => registered.push(name),
		registerShortcut: () => {},
		registerTool: () => {},
		on: () => {},
		events: { on: () => () => {}, emit: () => {} },
		appendEntry: () => {},
	} as any;
	orqCommands(noReconnect, () => [], { name: "orqi", version: "v0", status: "", cwd: "~" })(pi);
	orqHarness({
		agentDir: tmpdir(),
		catalogue: () => [],
		toolCount: () => 0,
		callTool: async () => ({ text: "", isError: false }),
		workspace: () => undefined,
	})(pi);
	expect([...registered].sort()).toEqual([...ORQI_COMMANDS].sort());
});

test("onlyOrq hides every provider except orq", async () => {
	const foreign = { provider: "anthropic", id: "claude-sonnet-4-5" };
	const mine = { provider: PROVIDER_ID, id: "openai/gpt-5.6-terra" };
	const fake = {
		getProviders: () => [{ id: "anthropic" }, { id: PROVIDER_ID }, { id: "orq-decisions" }],
		getProvider: (id: string) => ({ id }),
		getModels: () => [foreign, mine],
		getAvailableSnapshot: () => [foreign, mine],
		getAvailable: async () => [foreign, mine],
		getModel: (provider: string, id: string) => ({ provider, id }),
		refresh: async () => "untouched",
	} as any;

	const filtered = onlyOrq(fake);
	expect(filtered.getProviders()).toEqual([{ id: PROVIDER_ID }] as any);
	expect(filtered.getProvider("anthropic")).toBeUndefined();
	// Not offered by /login, but routing still resolves it by id.
	expect(filtered.getProvider("orq-decisions")).toBeDefined();
	expect(filtered.getModels()).toEqual([mine] as any);
	expect(filtered.getAvailableSnapshot()).toEqual([mine] as any);
	expect(await filtered.getAvailable()).toEqual([mine] as any);
	expect(filtered.getModel("anthropic", "claude-sonnet-4-5")).toBeUndefined();
	expect(filtered.getModel(PROVIDER_ID, "openai/gpt-5.6-terra")).toBeDefined();
	// Non-model methods must pass through untouched.
	expect(await (filtered as any).refresh()).toBe("untouched");
});

test("the header uses the ORQI splash", () => {
	const info = { name: "orqi", version: "v0", workspace: "orq-research", status: "s", cwd: "~" };
	const strip = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

	const output = strip(headerLines(info));
	expect(output).toContain("██████╗ ██████╗  ██████╗  ████");
	// AGENTS.md's TUI drive waits for this exact string.
	expect(output).toContain("orqi (aka TonyBot) v0");
	expect(output).not.toContain("CLI");

	// The logo is six rows and never gets split into a side-by-side layout.
	const art = output.split("\n").filter((line) => /[█▀▄]/.test(line));
	expect(art.length).toBe(6);
	for (const line of art) expect(line.length).toBeLessThanOrEqual(100);
});

test("the binary carries every file a compiled pi reads beside its executable", () => {
	// A compiled pi resolves these under PI_PACKAGE_DIR: theme/ (/settings) and
	// export-html/ (/export). Each must exist in pi's dist to be embedded at all.
	for (const source of Object.values(PI_FILES)) expect(existsSync(join(PI_DIST, source))).toBe(true);
	expect(Object.keys(PI_FILES)).toContain("pi/theme/dark.json");
	expect(Object.keys(PI_FILES)).toContain("pi/theme/light.json");
	// Read off pi's exporter, so a pi upgrade that reads one more template file fails here.
	const exporter = readFileSync(join(PI_DIST, "core", "export-html", "index.js"), "utf8");
	const read = [...exporter.matchAll(/join\(templateDir, ((?:"[^"]+"(?:, )?)+)\)/g)].map((m) =>
		[...m[1].matchAll(/"([^"]+)"/g)].map((p) => p[1]).join("/"),
	);
	expect(read.length).toBeGreaterThan(0);
	for (const file of read) expect(Object.keys(PI_FILES)).toContain(`pi/export-html/${file}`);
});

test("the terminal progress bar is on, except where OSC 9 means a notification", () => {
	expect(terminalProgress({ TERM_PROGRAM: "ghostty" })).toBe(true);
	expect(terminalProgress({})).toBe(true);
	expect(terminalProgress({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.6.2" })).toBe(true);
	expect(terminalProgress({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.5.14" })).toBe(false);
	expect(terminalProgress({ TERM_PROGRAM: "iTerm.app" })).toBe(false); // unknown version: assume old
	expect(terminalProgress({ TERM_PROGRAM: "ghostty", ORQI_TERMINAL_PROGRESS: "0" })).toBe(false);
});

test("pi names itself orqi and reads .orqi/, decided before it loads", () => {
	// pi reads piConfig once, at module load, so this needs a process of its own.
	const root = join(import.meta.dir, "..");
	const probe = `
		const { piPackageDir } = await import(${JSON.stringify(join(root, "src", "pi-package.ts"))});
		process.env.PI_PACKAGE_DIR = piPackageDir(${JSON.stringify(root)}, ${JSON.stringify(root)});
		const c = await import(${JSON.stringify(join(PI_DIST, "config.js"))});
		const { existsSync } = await import("node:fs");
		console.log(JSON.stringify([c.APP_NAME, c.APP_TITLE, c.CONFIG_DIR_NAME, c.ENV_AGENT_DIR, existsSync(c.getThemesDir() + "/dark.json"), existsSync(c.getExportTemplateDir())]));`;
	const out = Bun.spawnSync(["bun", "-e", probe], { cwd: root, env: { ...process.env, PI_PACKAGE_DIR: "" } });
	expect(JSON.parse(out.stdout.toString().trim())).toEqual(["orqi", "orqi", ".orqi", "ORQI_CODING_AGENT_DIR", true, true]);
});

test("main.ts refuses to run without boot.ts, which is what makes pi orqi", () => {
	const root = join(import.meta.dir, "..");
	const env = { ...process.env, ORQI_BOOT: "" };
	const direct = Bun.spawnSync(["bun", join(root, "src", "main.ts"), "--version"], { cwd: root, env });
	expect(direct.exitCode).toBe(2);
	expect(direct.stderr.toString()).toContain("src/boot.ts");
	const booted = Bun.spawnSync(["bun", join(root, "src", "boot.ts"), "--version"], { cwd: root, env });
	expect(booted.exitCode).toBe(0);
	// Two cold bun starts: on a loaded machine they outlast bun's 5 s default.
}, 30_000);

test("--session resolves a path, an exact id, a prefix, and reports another directory's session", async () => {
	const lookup = {
		findById: (_cwd: string, id: string) => (id === "01a1-6b7b" ? "/s/exact.jsonl" : undefined),
		list: async () => [{ id: "01a1-9999", path: "/s/prefix.jsonl" }],
		listAll: async () => [{ id: "02b2-0000", path: "/o/other.jsonl", cwd: "/elsewhere" }],
	};
	expect(await resolveSession("./mine.jsonl", "/here", lookup)).toEqual({ path: "./mine.jsonl" });
	expect(await resolveSession("01a1-6b7b", "/here", lookup)).toEqual({ path: "/s/exact.jsonl" });
	expect(await resolveSession("01a1-99", "/here", lookup)).toEqual({ path: "/s/prefix.jsonl" });
	expect(await resolveSession("02b2", "/here", lookup)).toEqual({ elsewhere: "/elsewhere" });
	expect(await resolveSession("ffff", "/here", lookup)).toEqual({ missing: true });
});

test("the splash carries no update line: the notice above the editor owns it", () => {
	// An update used to be a grey line here; now connection.ts shows a bordered
	// notice in the session, and saying it twice in one screenful is noise.
	const strip = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	const base = { name: "orqi", version: "v0", workspace: "orq-research", status: "s", cwd: "~" };

	const output = strip(headerLines(base));
	expect(output).not.toContain("update available");

	const art = output.split("\n").filter((line) => /[█▀▄]/.test(line));
	expect(art.length).toBe(6);
});

test("our commands never collide with a pi built-in", () => {
	// pi drops any extension command whose name matches a built-in, silently: the
	// command simply never fires. /whatsnew exists precisely because /changelog is
	// taken, so this is the check that keeps the workaround honest.
	const builtins = new Set(
		[
			...readFileSync(
				join(import.meta.dir, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "slash-commands.js"),
				"utf8",
			).matchAll(/name: "([a-z-]+)"/g),
		].map((m) => m[1]),
	);
	expect(builtins.size).toBeGreaterThan(0); // the scrape still finds the list
	expect(builtins.has("changelog")).toBe(true); // and /changelog is still theirs

	const registered: string[] = [];
	const pi = {
		registerEntryRenderer: () => {},
		registerCommand: (name: string) => registered.push(name),
		on: () => {},
		events: { on: () => () => {}, emit: () => {} },
		appendEntry: () => {},
	} as any;
	orqCommands(noReconnect, () => ["list_traces"], { name: "orqi", version: "v0", status: "", cwd: "~" })(pi);
	orqHarness({
		agentDir: tmpdir(),
		catalogue: () => [],
		toolCount: () => 0,
		callTool: async () => ({ text: "", isError: false }),
		workspace: () => undefined,
	})({ ...pi, registerShortcut: () => {}, registerTool: () => {} });

	expect(registered).toContain("whatsnew");
	expect(registered).toContain("trajectory");
	expect(registered.filter((name) => builtins.has(name))).toEqual([]);

	// memorq's commands are memorq's: orqi must never take them (its own would win dispatch and hide
	// memorq's screens), and pi must not own them either, or memorq's would be dropped.
	const memorqs = ["memory", "memory-notes", "memory-review", "memory-stats"];
	expect(
		memorqs.filter((name) => registered.includes(name) || (ORQI_COMMANDS as readonly string[]).includes(name) || builtins.has(name)),
	).toEqual([]);
});

test("the model catalogue cache belongs to the credential that fetched it", async () => {
	// A cache written by one credential (12 models, no agent access) was served to the
	// next for 24 h: a /login that could see 149 agents still got "no agents visible".
	const dir = mkdtempSync(join(tmpdir(), "orqi-catalogue-"));
	const path = join(dir, "model-catalogue.json");
	const chat = (id: string) => ({ enabled: true, model_type: "chat", has_functions: true, refId: id, metadata: {} });
	const answers: Record<string, Record<string, unknown>> = {
		"sk-orq-thin": { "/v2/models": [chat("a/thin")] },
		"sk-orq-full": { "/v2/models": [chat("a/full")], "/v2/agents": { data: [{ key: "helper", status: "live" }] } },
	};
	let calls = 0;
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
		calls++;
		const token = String((init?.headers as Record<string, string> | undefined)?.Authorization).slice(7);
		const body = answers[token]![new URL(url).pathname];
		return body === undefined ? new Response("forbidden", { status: 403 }) : Response.json(body);
	}) as unknown as typeof fetch);
	try {
		const thin = await catalogue("sk-orq-thin", path);
		expect(thin.models.map((m) => m.id)).toEqual(["a/thin"]);
		// Same credential within the TTL: served from disk, no request.
		calls = 0;
		expect((await catalogue("sk-orq-thin", path)).models.map((m) => m.id)).toEqual(["a/thin"]);
		expect(calls).toBe(0);
		// Another credential: fetched afresh, agents included.
		const full = await catalogue("sk-orq-full", path);
		expect(full.models.map((m) => m.id)).toEqual(["a/full", "agent/helper"]);
		expect(calls).toBeGreaterThan(0);
	} finally {
		fetchSpy.mockRestore();
		rmSync(dir, { recursive: true, force: true });
	}
});

/** Checks for the connection: credential candidates and the orq CLI, recovery from a rejected credential, and the auth warning. Run with `bun test`. */

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	apiBaseUrl,
	credentialsFile,
	readWhoami,
	loginKey,
	LOGIN_HINT,
	normalizeServer,
	orqEnv,
	profileKey,
	profileOf,
	serverOf,
	sessionFileOf,
	SESSION_SOURCE,
	sessionToken,
	spawnFailure,
	stageServer,
	staged,
	takeServerFlag,
	WHOAMI_ARGS,
	workspaceOfKey,
	type Credential,
} from "./auth.ts";
import {
	authLines,
	LOGIN_CTA,
	LOGIN_REFUSED,
	NO_CREDENTIAL,
	orqCommands,
	pickForWorkspace,
	WORKSPACE_SWITCH,
	type Boot,
} from "./connection.ts";
import { CredentialsRejected } from "./mcp.ts";

const noReconnect = async () => ({ credential: { token: "", source: "" }, count: 0, added: [] });

test("the header entry is appended on fresh sessions only", () => {
	// Entries are session-persisted: appending on resume would stack a second
	// header onto a transcript that already has one.
	const appended: string[] = [];
	const handlers = new Map<string, (event: any, ctx: any) => void>();
	const pi = {
		registerEntryRenderer: () => {},
		registerCommand: () => {},
		on: (event: string, handler: (e: any, c: any) => void) => handlers.set(event, handler),
		appendEntry: (customType: string) => appended.push(customType),
	} as any;

	orqCommands(noReconnect, () => ["list_traces"], {
		name: "orqi",
		version: "v0",
		workspace: "orq-research",
		status: "",
		cwd: "~",
	})(pi);

	const status = new Map<string, string | undefined>();
	const ctx = { ui: { setStatus: (k: string, v?: string) => status.set(k, v) } } as any;
	const fire = (reason: string) => handlers.get("session_start")?.({ type: "session_start", reason }, ctx);
	fire("startup");
	fire("new");
	expect(appended).toEqual(["orqi-header", "orqi-header"]);

	// The workspace is pinned to the footer on every start, resumes included.
	expect(status.get("orq-workspace")).toBe("orq:orq-research");

	appended.length = 0;
	for (const reason of ["resume", "fork", "reload"]) fire(reason);
	expect(appended).toEqual([]);
	expect(status.get("orq-workspace")).toBe("orq:orq-research");
});

test("a stale pi handle after /new does not take the session down", () => {
	// pi invalidates the `pi` captured at registration when a session is replaced,
	// so appendEntry throws "extension ctx is stale" on /new. It used to dump a
	// stack trace over the transcript of the session the user just opened.
	const handlers = new Map<string, (event: any, ctx: any) => void>();
	const pi = {
		registerEntryRenderer: () => {},
		registerCommand: () => {},
		on: (event: string, handler: (e: any, c: any) => void) => handlers.set(event, handler),
		appendEntry: () => {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		},
	} as any;
	orqCommands(noReconnect, () => ["list_traces"], {
		name: "orqi",
		version: "v0",
		workspace: "orq-research",
		status: "",
		cwd: "~",
	})(pi);

	const status = new Map<string, string | undefined>();
	const ctx = { ui: { setStatus: (k: string, v?: string) => status.set(k, v) } } as any;
	expect(() => handlers.get("session_start")?.({ type: "session_start", reason: "new" }, ctx)).not.toThrow();
	// The workspace still has to reach the footer: it is what scopes every tool call.
	expect(status.get("orq-workspace")).toBe("orq:orq-research");
});

test("the host follows the CLI, because an API-key profile carries its own server", () => {
	// `ORQ_PROFILE=achmea-aim-ithaka` puts the CLI on https://aim.orq.ai with no
	// ORQ_SERVER set anywhere, so an env-only host would send that profile's
	// token to api.orq.ai. whoami reports what the CLI resolved; orqi takes it.
	const whoami = '{"authenticated":true,"server":"https://aim.orq.ai","session_file":"/h/.orq/sessions/aim.orq.ai.json"}';
	expect(serverOf(whoami)).toBe("https://aim.orq.ai");
	expect(apiBaseUrl({}, serverOf(whoami))).toBe("https://aim.orq.ai");

	// ORQ_SERVER is an input the CLI already weighed, so it only matters when
	// whoami could not answer at all.
	expect(apiBaseUrl({ ORQ_SERVER: "https://my.orq.ai" }, "https://aim.orq.ai")).toBe("https://aim.orq.ai");
	expect(apiBaseUrl({ ORQ_SERVER: "https://my.orq.ai" }, undefined)).toBe("https://my.orq.ai");

	// ORQ_API_BASE_URL is the CLI's own variable for a different host and is
	// not orqi's to reinterpret.
	expect(apiBaseUrl({ ORQ_API_BASE_URL: "https://onprem.example" }, undefined)).toBe("https://my.orq.ai");

	// CLI 11 moved its own default to my.orq.ai; orqi agrees when nobody said.
	expect(apiBaseUrl({}, undefined)).toBe("https://my.orq.ai");
	expect(serverOf('{"authenticated":false}')).toBeUndefined();
	expect(serverOf("you are not logged in")).toBeUndefined();
});

test("a host is read as the base URL the CLI stores, and anything else is refused", () => {
	expect(normalizeServer("my.staging.orq.ai")).toEqual({ server: "https://my.staging.orq.ai" });
	expect(normalizeServer(" https://acme.example.com/ ")).toEqual({ server: "https://acme.example.com" });
	expect(normalizeServer("http://localhost:8080")).toEqual({ server: "http://localhost:8080" });
	// Each of these was saved as the CLI's default by `orq server use` before.
	for (const typed of ["--help", "-h", "0", "list", "list my agents", "", "https://acme.example.com?x=1"])
		expect("error" in normalizeServer(typed)).toBe(true);
	expect(normalizeServer("http://acme.example.com")).toEqual({
		error: "http://acme.example.com: an orq host needs https (http only on localhost)",
	});
});

test("--server is taken out of argv wherever it sits, so the rest reads as without it", () => {
	const bin = ["bun", "boot.ts"];
	expect(takeServerFlag([...bin])).toEqual({ argv: bin });
	expect(takeServerFlag([...bin, "--server", "https://x.orq.ai"])).toEqual({ argv: bin, server: "https://x.orq.ai" });
	expect(takeServerFlag([...bin, "--server=x.orq.ai/", "--session", "abc"])).toEqual({
		argv: [...bin, "--session", "abc"],
		server: "https://x.orq.ai",
	});
	expect(takeServerFlag([...bin, "--server", "https://x.orq.ai", "list my agents"])).toEqual({
		argv: [...bin, "list my agents"],
		server: "https://x.orq.ai",
	});
	// A missing or unusable value is an error, not the next flag or an empty host.
	expect(takeServerFlag([...bin, "--server"]).error).toContain("needs a URL");
	expect(takeServerFlag([...bin, "--server", "--session", "abc"]).error).toContain("needs a URL");
	expect(takeServerFlag([...bin, "--server="]).error).toContain("needs a URL");
	expect(takeServerFlag([...bin, "--server", "list my agents"]).error).toContain("not an orq host");
	// Twice would leave the second in argv[2], sent to the model as a prompt.
	expect(takeServerFlag([...bin, "--server", "a.orq.ai", "--server", "b.orq.ai"]).error).toContain("more than once");
	// A prompt that merely mentions the flag is the prompt's business: only argv[2..] entries count.
	expect(takeServerFlag([...bin, "what does --server do"]).server).toBeUndefined();
	// Another command's arguments, and anything after `--`, are not orqi's.
	const mcp = [...bin, "mcp", "add", "x", "--", "srv", "--server", "https://internal"];
	expect(takeServerFlag(mcp)).toEqual({ argv: mcp });
	const after = [...bin, "hi", "--", "--server", "https://x.orq.ai"];
	expect(takeServerFlag(after)).toEqual({ argv: after });
});

test("the CLI gets the host orqi is on now, but never the key orqi moved onto", () => {
	const saved = { server: process.env.ORQ_SERVER, key: process.env.ORQ_API_KEY };
	try {
		process.env.ORQ_SERVER = "https://my.staging.orq.ai";
		process.env.ORQ_API_KEY = "sk-orq-picked-at-runtime";
		expect(orqEnv().ORQ_SERVER).toBe("https://my.staging.orq.ai");
		expect(orqEnv().ORQ_API_KEY).not.toBe("sk-orq-picked-at-runtime");
		delete process.env.ORQ_SERVER;
		expect("ORQ_SERVER" in orqEnv()).toBe(false);
	} finally {
		for (const [name, value] of [
			["ORQ_SERVER", saved.server],
			["ORQ_API_KEY", saved.key],
		] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

/** /server against a fake CLI: what it was asked, and ORQ_SERVER put back afterwards. */
async function withServerCommand(
	reconnect: (candidates: Credential[]) => Promise<any>,
	run: (h: ReturnType<typeof recoveryHarness>, cli: string[][]) => Promise<void>,
	current = '{"server":"https://my.orq.ai","profile_server":""}',
) {
	const prior = process.env.ORQ_SERVER;
	const cli: string[][] = [];
	const h = recoveryHarness(reconnect, {
		readCandidates: () => ({ candidates: [good] }),
		runOrq: (args) => {
			cli.push(args);
			return { ok: true, stdout: args[1] === "current" ? current : "", stderr: "" };
		},
	});
	try {
		await run(h, cli);
	} finally {
		stageServer(undefined);
		if (prior === undefined) delete process.env.ORQ_SERVER;
		else process.env.ORQ_SERVER = prior;
	}
}

const connected = async (candidates: Credential[]) => ({ credential: candidates[0]!, added: [] });

test("/server refuses what is not a host without asking the CLI anything", async () => {
	await withServerCommand(connected, async (h, cli) => {
		await h.commands.get("server")!("--help", h.ctx);
		expect(cli).toEqual([]);
		expect(h.notices.at(-1)).toContain("not an orq host");
	});
});

test("/server saves orq's own hosts at once", async () => {
	await withServerCommand(connected, async (h, cli) => {
		await h.commands.get("server")!("my.staging.orq.ai", h.ctx);
		expect(cli).toContainEqual(["server", "use", "--", "https://my.staging.orq.ai"]);
		expect(process.env.ORQ_SERVER).toBe("https://my.staging.orq.ai");
	});
});

test("/server puts the previous host back, unsaved, when another host accepts nothing", async () => {
	await withServerCommand(
		async (candidates) => {
			// Refused while the custom host is staged, accepted once it is put back.
			if (staged()) throw new CredentialsRejected([{ source: "acme.example.com", reason: "did not answer as orq" }]);
			return connected(candidates);
		},
		async (h, cli) => {
			process.env.ORQ_SERVER = "https://my.orq.ai";
			await h.commands.get("server")!("https://acme.example.com", h.ctx);
			expect(cli.some((args) => args[1] === "use")).toBe(false);
			expect(process.env.ORQ_SERVER).toBe("https://my.orq.ai");
			expect(staged()).toBeUndefined();
			expect(h.notices.at(-1)).toContain("https://acme.example.com is not saved");
			// The rollback reconnected on the old host, so nothing stays pinned.
			expect(h.widgets.get("orq-auth")).toBeUndefined();
		},
	);
});

test("/server leaves the host alone while a profile pins its own", async () => {
	await withServerCommand(
		connected,
		async (h, cli) => {
			const before = process.env.ORQ_SERVER;
			await h.commands.get("server")!("my.staging.orq.ai", h.ctx);
			expect(cli).toEqual([["server", "current", "-o", "json"]]);
			expect(process.env.ORQ_SERVER).toBe(before);
			expect(h.notices.at(-1)).toContain("pins https://aim.orq.ai");
		},
		'{"server":"https://aim.orq.ai","profile_server":"https://aim.orq.ai"}',
	);
});

test("a boot notice is said once, at startup, never on a resume", () => {
	const h = recoveryHarness(noReconnect, { notice: "https://acme.example.com is not saved as the orq host yet" });
	h.ctx.hasUI = true;
	h.handlers.get("session_start")!({ type: "session_start", reason: "resume" }, h.ctx);
	expect(h.notices).toEqual([]);
	h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, h.ctx);
	expect(h.notices.filter((notice) => notice.includes("not saved"))).toHaveLength(1);
});

test("no orq call asks for --json, which the CLI dropped in 8.4", () => {
	// `--json` was an alias until orq-cli#86 removed it; `-o json` has worked
	// since 5.0. A revert would only surface as "not logged in" at boot.
	// orqi's own `update --json` is a different flag and stays untouched, so
	// this scrapes the runOrq call sites rather than the whole file.
	expect(WHOAMI_ARGS).toEqual(["auth", "whoami", "-o", "json"]);
	for (const file of ["auth.ts", "connection.ts", "main.ts"]) {
		const calls = [...readFileSync(join(import.meta.dir, file), "utf8").matchAll(/runOrq\(([^)]*)\)/g)].map((m) => m[1]);
		for (const call of calls) expect(call).not.toContain("--json");
	}
});

test("a timed-out orq call is not reported as a missing binary", () => {
	// A stalled backend and an uninstalled CLI both surface as spawnSync's
	// `error`; conflating them sends a working install off to debug its PATH.
	expect(spawnFailure(Object.assign(new Error("spawnSync orq ETIMEDOUT"), { code: "ETIMEDOUT" }))).toMatch(/timed out after 15s/);
	expect(spawnFailure(Object.assign(new Error("spawnSync orq ENOENT"), { code: "ENOENT" }))).toMatch(/not found on PATH/);
});

test("readWhoami understands every shape CLI 11 answers in", () => {
	// Four shapes: a browser session, an API-key profile, an exported key and an
	// `orq auth login --api-key` login. Each names its files differently, and
	// since 11.0.1 any of them can say authenticated:false with the server's reason.
	const files: Record<string, string> = {
		"/h/.orq/sessions/my.orq.ai.json": JSON.stringify({ activeWorkspaceKey: "acme", workspaceTokens: { acme: { token: "sess" } } }),
		"/h/.orq/sessions/my.orq.ai.apikey.json": JSON.stringify({ version: 1, apiKey: "sk-orq-stored", source: "login" }),
	};
	const read = (file: string) => {
		if (!(file in files)) throw new Error(`ENOENT ${file}`);
		return files[file]!;
	};

	const session = readWhoami(
		'{"authenticated":true,"session_file":"/h/.orq/sessions/my.orq.ai.json","server":"https://my.orq.ai","workspaces":[]}',
		read,
	);
	expect(session.session?.activeWorkspaceKey).toBe("acme");
	expect(session.server).toBe("https://my.orq.ai");
	expect(session.apiKeyLogin).toBeUndefined();
	expect(session.failure).toBeUndefined();

	const profile = readWhoami(
		'{"profile":"aim","server":"https://aim.orq.ai","session_file":"/h/.orq/sessions/aim.orq.ai.json","authenticated":true}',
		read,
	);
	expect(profile.profile).toBe("aim");
	expect(profile.server).toBe("https://aim.orq.ai");

	const env = readWhoami(
		'{"method":"api_key","source":"ORQ_API_KEY","server":"https://my.orq.ai","session_file":"/h/.orq/sessions/my.orq.ai.json","authenticated":true}',
		read,
	);
	expect(env.apiKeyLogin).toBeUndefined(); // the env key is orqi's own candidate already
	expect(env.session?.activeWorkspaceKey).toBe("acme");

	const login = readWhoami(
		'{"method":"api_key","server":"https://my.orq.ai","session_file":"/h/.orq/sessions/none.json","api_key_login_file":"/h/.orq/sessions/my.orq.ai.apikey.json","authenticated":true}',
		read,
	);
	expect(login.apiKeyLogin).toBe("sk-orq-stored");
	expect(login.failure).toBeUndefined(); // no browser session is normal for an api-key login

	// authenticated:false drops the credential whoami vouched for, and says why.
	const deadSession = readWhoami(
		'{"authenticated":false,"auth_error":"401 token revoked","session_file":"/h/.orq/sessions/my.orq.ai.json","workspaces":[]}',
		read,
	);
	expect(deadSession.session).toBeUndefined();
	expect(deadSession.failure).toContain("401 token revoked");
	const deadLogin = readWhoami(
		'{"method":"api_key","api_key_login_file":"/h/.orq/sessions/my.orq.ai.apikey.json","session_file":"/h/x.json","authenticated":false,"auth_error":"401 key deleted"}',
		read,
	);
	expect(deadLogin.apiKeyLogin).toBeUndefined();
	expect(deadLogin.failure).toContain("401 key deleted");

	// A failed check (timeout, 5xx) is no verdict: authenticated stays true.
	const checkFailed = readWhoami(
		'{"authenticated":true,"auth_check_error":"timeout","session_file":"/h/.orq/sessions/my.orq.ai.json"}',
		read,
	);
	expect(checkFailed.session?.activeWorkspaceKey).toBe("acme");

	expect(readWhoami("not json", read).failure).toBeDefined();
});

test("sessionFileOf takes the session path from whoami, whatever the CLI names it", () => {
	// The CLI owns the file's name and shape, and both have changed across releases; orqi asks rather than guesses.
	expect(sessionFileOf('{"authenticated":true,"session_file":"/home/u/.orq/sessions/my.orq.ai.json"}')).toBe(
		"/home/u/.orq/sessions/my.orq.ai.json",
	);
	expect(sessionFileOf('{"authenticated":true,"session_file":""}')).toBeUndefined();
	expect(sessionFileOf("you are not logged in")).toBeUndefined();
});

/** A fake pi plus a fake UI, wired to orqCommands with a stubbed candidate reader. */
function recoveryHarness(
	reconnect: (candidates: Credential[]) => Promise<any>,
	boot: Boot & { header?: any; agentDir?: string } = {},
	renewSession?: (force?: boolean) => Promise<any>,
) {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const registered: string[] = [];
	let registerToolImpl = (tool: { name: string }) => {
		registered.push(tool.name);
	};
	const pi = {
		registerEntryRenderer: () => {},
		registerCommand: (name: string, options: any) => commands.set(name, options.handler),
		registerTool: (tool: { name: string }) => registerToolImpl(tool),
		on: (event: string, handler: (e: any, c: any) => any) => handlers.set(event, handler),
		appendEntry: () => {},
	} as any;
	const widgets = new Map<string, string[] | undefined>();
	const status = new Map<string, string | undefined>();
	const notices: string[] = [];
	const ctx = {
		ui: {
			setWidget: (k: string, v?: string[]) => widgets.set(k, v),
			setStatus: (k: string, v?: string) => status.set(k, v),
			notify: (m: string) => notices.push(m),
		},
	} as any;
	const header = boot.header ?? { name: "orqi", version: "v0", status: "not connected", cwd: "~" };
	const toolNames: string[] = [];
	const factory = orqCommands(reconnect, () => toolNames, header, boot.agentDir ?? "/nonexistent", boot, renewSession);
	factory(pi);
	const input = () => handlers.get("input")!({ type: "input", text: "hi", source: "interactive" }, ctx);
	return {
		pi,
		ctx,
		handlers,
		commands,
		registered,
		widgets,
		status,
		notices,
		header,
		toolNames,
		factory,
		input,
		setRegisterTool: (fn: (tool: { name: string }) => void) => {
			registerToolImpl = fn;
		},
	};
}

test("an unrecoverable browser session warns once before the turn", async () => {
	let renewals = 0;
	const h = recoveryHarness(noReconnect, {}, async () => {
		renewals++;
		return { stale: true, reason: "the login session could not be renewed; run `orq auth login`" };
	});
	await h.input();
	await h.input();
	expect(renewals).toBe(2);
	expect(h.notices).toEqual([
		"orq could not renew the browser session: the login session could not be renewed; run `orq auth login`\n→ /login or `orq auth login`, then retry",
	]);
});

const bad: Credential = { token: "sk-orq-bad", source: "ORQ_API_KEY" };
const good: Credential = { token: "sk-orq-good", source: "/login key" };
const rejectAllBut = (winner: string) => async (candidates: Credential[]) => {
	const win = candidates.find((c) => c.token === winner);
	if (!win) throw new CredentialsRejected(candidates.map((c) => ({ source: c.source, reason: "nope" })));
	return { credential: { ...win, workspace: "acme" }, added: [] };
};

test("a rejected boot pins the warning, and the next message reconnects", async () => {
	// pi fires nothing on /login, so the next submitted message is where the
	// stored key is noticed. The reconnect must register tools the boot could
	// not wrap, before the run snapshots its tool list.
	let stored: Credential[] = [bad];
	const calls: Credential[][] = [];
	const rejected = [{ source: "ORQ_API_KEY", reason: "API key is not valid for this workspace" }];
	const h = recoveryHarness(
		async (candidates) => {
			calls.push(candidates);
			const r = await rejectAllBut("sk-orq-good")(candidates);
			h.header.workspace = "acme";
			return r;
		},
		{ rejections: rejected, candidates: [bad], readCandidates: () => ({ candidates: stored }) },
	);

	h.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
	expect(h.widgets.get("orq-auth")).toEqual(authLines(rejected));
	expect(h.status.get("orq-workspace")).toBe("orq:not connected");
	expect(h.notices).toEqual([]); // pinned once, not also notified

	// Nothing changed since boot: the turn does not knock on the server again,
	// not even on the first message.
	await h.input();
	await h.input();
	expect(calls.length).toBe(0);
	expect(h.widgets.get("orq-auth")).toBeDefined();

	// /login orq stored a key: the next message picks it up, first in line.
	stored = [good, bad];
	await h.input();
	expect(calls.length).toBe(1);
	expect(calls[0]![0]).toBe(good);
	expect(h.widgets.get("orq-auth")).toBeUndefined();
	expect(h.status.get("orq-workspace")).toBe("orq:acme");
	expect(h.notices.at(-1)).toBe("Connected to orq: acme (/login key); its tools arrive as the server connects (/mcp shows it).");

	// Connected: the hook is a no-op from here on.
	await h.input();
	expect(calls.length).toBe(1);
});

test("a stall during recovery is reported and does not end recovery", async () => {
	// The server hangs on roughly one call in three. Rethrowing that out of the
	// input handler put it in pi's extension diagnostics, where the user never
	// saw it, while the memo still counted the keys as tried - so one stall
	// silently ended recovery for the rest of the session.
	const calls: Credential[][] = [];
	const h = recoveryHarness(
		async (candidates) => {
			calls.push(candidates);
			throw new Error("Request timed out\n  at somewhere in node_modules");
		},
		{ rejections: [{ source: "ORQ_API_KEY", reason: "nope" }], candidates: [bad], readCandidates: () => ({ candidates: [good, bad] }) },
	);
	await h.input();
	expect(calls.length).toBe(1);
	expect(h.notices.at(-1)).toBe("orq did not answer: Request timed out. Retrying on your next message, or run /reconnect.");
	expect(h.widgets.get("orq-auth")).toBeDefined(); // the boot's rejections stay pinned
	// The memo was not advanced, so the same keys are tried again.
	await h.input();
	expect(calls.length).toBe(2);
});

test("a rejection after a retry re-pins the widget with the new reasons", async () => {
	let stored: Credential[] = [bad];
	const h = recoveryHarness(rejectAllBut("never"), {
		rejections: [{ source: "ORQ_API_KEY", reason: "nope" }],
		candidates: [bad],
		readCandidates: () => ({ candidates: stored }),
	});
	stored = [{ token: "sk-orq-expired", source: "/login key" }, bad];
	await h.input();
	expect(h.notices).toEqual([]); // the refusal is pinned, not repeated as a notice
	expect(h.widgets.get("orq-auth")).toEqual(
		authLines([
			{ source: "/login key", reason: "nope" },
			{ source: "ORQ_API_KEY", reason: "nope" },
		]),
	);
	// Same refused set: no re-knock.
	const before = h.notices.length;
	await h.input();
	expect(h.notices.length).toBe(before);
	// No candidates at all: the headline stops claiming a rejection.
	stored = [];
	await h.input();
	expect(h.widgets.get("orq-auth")![0]).toBe("⚠ orq is not connected: no credential found");
});

test("/reconnect always tries, and reports already connected without knocking twice", async () => {
	const calls: Credential[][] = [];
	const h = recoveryHarness(
		async (candidates) => {
			calls.push(candidates);
			return rejectAllBut("sk-orq-good")(candidates);
		},
		{ rejections: [{ source: "ORQ_API_KEY", reason: "nope" }], candidates: [bad], readCandidates: () => ({ candidates: [good, bad] }) },
	);
	// Two concurrent callers share one attempt: the hook and /reconnect typed
	// while it is still in flight must not both reconnect the server.
	await Promise.all([h.input(), h.commands.get("reconnect")!("", h.ctx)]);
	expect(calls.length).toBe(1);
	// Explicit /reconnect after success still tries (the user asked), once.
	await h.commands.get("reconnect")!("", h.ctx);
	expect(calls.length).toBe(2);
});

test("a failed /workspace switch says the tools are still on the previous workspace", async () => {
	// mcp.ts only closes the old client once a replacement is accepted, so a
	// rejected or stalled switch leaves the old workspace answering. The widget
	// and footer must say that, and the next message must retry.
	const session: Credential = { token: "sk-orq-session", source: "orq login session", workspace: "other" };
	let outcome: "reject" | "stall" | "accept" = "reject";
	const calls: Credential[][] = [];
	const h = recoveryHarness(
		async (candidates) => {
			calls.push(candidates);
			if (outcome === "stall") throw new Error("Request timed out");
			if (outcome === "reject") throw new CredentialsRejected([{ source: session.source, workspace: "other", reason: "expired" }]);
			h.header.workspace = "other";
			return { credential: session, added: [] };
		},
		{
			candidates: [bad, session],
			readCandidates: () => ({ candidates: [bad, session] }),
			header: { name: "orqi", version: "v0", status: "", cwd: "~", workspace: "acme" },
		},
	);
	expect(pickForWorkspace([bad, session])).toEqual([session]);
	expect(pickForWorkspace([bad])).toEqual([bad]);
	expect(pickForWorkspace([])).toEqual([]);

	// The handler shells out to `orq workspace use` first, which no test should
	// do. Past that step the switch is one recover with pickForWorkspace, so
	// drive that by making the reader return only the pick: the same narrowed
	// set the handler passes.
	expect(h.commands.get("workspace")).toBeDefined();
	const narrowed = recoveryHarness(
		async (candidates) => {
			calls.push(candidates);
			if (outcome === "stall") throw new Error("Request timed out");
			if (outcome === "reject") throw new CredentialsRejected([{ source: session.source, workspace: "other", reason: "expired" }]);
			narrowed.header.workspace = "other";
			return { credential: session, added: [] };
		},
		{
			candidates: [bad],
			readCandidates: () => ({ candidates: [session] }),
			header: { name: "orqi", version: "v0", status: "", cwd: "~", workspace: "acme" },
		},
	);
	// Connected boot (no rejections) switching to a workspace whose token is rejected.
	await narrowed.commands.get("reconnect")!("", narrowed.ctx);
	expect(calls.length).toBe(1);
	expect(narrowed.widgets.get("orq-auth")).toEqual(["⚠ orq is still on acme: the switch failed (orq login session: expired)", LOGIN_CTA]);
	expect(narrowed.status.get("orq-workspace")).toBe("orq:acme (switch failed)");
	expect(narrowed.notices.at(-1)).toBe("orq rejected that credential; still on acme."); // /reconnect asked, so it answers
	// The widget is up, so the hook engages on the next message; same set, refused: skip.
	await narrowed.input();
	expect(calls.length).toBe(1);
	// A stall during the switch: reported, memo untouched, next message retries.
	outcome = "stall";
	await narrowed.commands.get("reconnect")!("", narrowed.ctx);
	expect(calls.length).toBe(2);
	expect(narrowed.notices.at(-1)).toBe("orq did not answer: Request timed out. Retrying on your next message, or run /reconnect.");
	expect(narrowed.widgets.get("orq-auth")![0]).toStartWith("⚠ orq is still on acme: the switch failed");
	await narrowed.input();
	expect(calls.length).toBe(3);
	// Accepted: everything clears and the footer moves.
	outcome = "accept";
	await narrowed.input();
	expect(calls.length).toBe(4);
	expect(narrowed.widgets.get("orq-auth")).toBeUndefined();
	expect(narrowed.status.get("orq-workspace")).toBe("orq:other");
});

test("a refused stored /login key is one pinned line, not re-tried as a workspace switch", async () => {
	const stale: Credential = { token: "sk-orq-stale", source: "/login key" };
	const session: Credential = { token: "sk-orq-session", source: "orq login session", workspace: "acme" };
	const calls: Credential[][] = [];
	const h = recoveryHarness(
		async (candidates) => {
			calls.push(candidates);
			return rejectAllBut("sk-orq-session")(candidates);
		},
		{
			candidates: [stale, session],
			readCandidates: () => ({ candidates: [stale, session] }),
			loginRefused: true,
			header: { name: "orqi", version: "v0", status: "", cwd: "~", workspace: "acme" },
		},
	);
	h.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
	expect(h.widgets.get("orq-auth")).toEqual(LOGIN_REFUSED);
	expect(h.notices).toEqual([]);
	// The first message does not knock with the token the boot already refused.
	await h.input();
	expect(calls.length).toBe(0);
});

test("a stored /login key that only stalled at boot is tried on the first message", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-stalled-login-"));
	const prior = process.env.ORQ_API_KEY;
	try {
		writeFileSync(join(dir, "auth.json"), JSON.stringify({ orq: { type: "api_key", key: "sk-orq-slow" } }));
		const slow: Credential = { token: "sk-orq-slow", source: "/login key" };
		const env: Credential = { token: "sk-orq-env", source: "ORQ_API_KEY", workspace: "acme" };
		process.env.ORQ_API_KEY = env.token;
		const calls: Credential[][] = [];
		const h = recoveryHarness(
			async (candidates) => {
				calls.push(candidates);
				return rejectAllBut("sk-orq-slow")(candidates);
			},
			{
				agentDir: dir,
				candidates: [slow, env],
				readCandidates: () => ({ candidates: [slow, env] }),
				loginRefused: false,
				header: { name: "orqi", version: "v0", status: "", cwd: "~", workspace: "acme" },
			},
		);
		h.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
		expect(h.widgets.get("orq-auth")).toBeUndefined();
		await h.input();
		expect(calls.map((set) => set.map((c) => c.token))).toEqual([["sk-orq-slow"]]);
	} finally {
		if (prior === undefined) delete process.env.ORQ_API_KEY;
		else process.env.ORQ_API_KEY = prior;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an expired browser sign-in is refreshed from the login session, not tried as a switch", async () => {
	// pi refreshes the stored sign-in only at the model call, which runs after
	// the input hook: an hour-old session read the expired copy, knocked with it,
	// and pinned "the switch failed" while the model, refreshed a moment later, worked.
	const dir = mkdtempSync(join(tmpdir(), "orqi-expired-signin-"));
	const prior = process.env.ORQ_API_KEY;
	try {
		const path = join(dir, "auth.json");
		writeFileSync(path, JSON.stringify({ orq: { type: "oauth", access: "sk-orq-expired", refresh: "orq-cli-session", expires: 1 } }));
		const session: Credential = { token: "sk-orq-fresh", source: SESSION_SOURCE, workspace: "acme" };
		process.env.ORQ_API_KEY = "sk-orq-adopted-earlier";
		const calls: Credential[][] = [];
		const h = recoveryHarness(
			async (candidates) => {
				calls.push(candidates);
				return rejectAllBut("sk-orq-fresh")(candidates);
			},
			{
				agentDir: dir,
				candidates: [session],
				readCandidates: () => ({ candidates: [{ token: loginKey(path)!, source: "/login key" }, session] }),
				header: { name: "orqi", version: "v0", status: "", cwd: "~", workspace: "acme" },
			},
		);
		h.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
		await h.input();
		expect(calls.map((set) => set.map((c) => c.token))).toEqual([["sk-orq-fresh"]]);
		expect(loginKey(path)).toBe("sk-orq-fresh");
		expect(h.widgets.get("orq-auth")).toBeUndefined();

		// No login session to refresh from: leave it to pi, knock with nothing.
		writeFileSync(path, JSON.stringify({ orq: { type: "oauth", access: "sk-orq-expired-2", refresh: "orq-cli-session", expires: 1 } }));
		const h2 = recoveryHarness(
			async (candidates) => {
				calls.push(candidates);
				return rejectAllBut("sk-orq-fresh")(candidates);
			},
			{
				agentDir: dir,
				readCandidates: () => ({ candidates: [{ token: loginKey(path)!, source: "/login key" }] }),
				header: { name: "orqi", version: "v0", status: "", cwd: "~", workspace: "acme" },
			},
		);
		h2.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, h2.ctx);
		await h2.input();
		expect(calls.length).toBe(1);
		expect(h2.widgets.get("orq-auth")).toBeUndefined();
	} finally {
		if (prior === undefined) delete process.env.ORQ_API_KEY;
		else process.env.ORQ_API_KEY = prior;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("authLines picks its headline from what actually happened", () => {
	expect(authLines([{ source: "ORQ_API_KEY", reason: "x" }])[0]).toBe(
		"⚠ orq is not connected: every credential was rejected (ORQ_API_KEY: x)",
	);
	expect(authLines([{ source: NO_CREDENTIAL, reason: "x" }])[0]).toBe("⚠ orq is not connected: no credential found");
	expect(
		authLines([
			{ source: WORKSPACE_SWITCH, workspace: "acme", reason: "x" },
			{ source: "orq login session", reason: "y" },
		])[0],
	).toBe("⚠ orq is still on acme: the switch failed (orq login session: y)");
});

test("loginKey reads what pi's /login stored: a pasted key or a browser sign-in", () => {
	const dir = mkdtempSync(join(tmpdir(), "orqi-auth-"));
	try {
		const path = join(dir, "auth.json");
		expect(loginKey(path)).toBeUndefined(); // no file yet
		writeFileSync(path, JSON.stringify({ orq: { type: "api_key", key: "sk-orq-stored" } }));
		expect(loginKey(path)).toBe("sk-orq-stored");
		writeFileSync(path, JSON.stringify({ orq: { type: "oauth", access: "x", refresh: "y", expires: 0 } }));
		expect(loginKey(path)).toBe("x"); // "Sign in with an account" (orq.ai browser login)
		writeFileSync(path, JSON.stringify({ orq: { type: "oauth" } }));
		expect(loginKey(path)).toBeUndefined();
		writeFileSync(path, "{garbage");
		expect(loginKey(path)).toBeUndefined();
		expect(loginKey(undefined)).toBeUndefined();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("authLines says what was rejected, why, and the way out", () => {
	const lines = authLines([
		{ source: "ORQ_API_KEY", workspace: "acme", reason: "API key is not valid for this workspace." },
		{ source: "orq login session", reason: "expired" },
	]);
	// Two lines, not one per candidate: what happened with the server's reason, then the way out.
	expect(lines).toEqual([
		"⚠ orq is not connected: every credential was rejected (ORQ_API_KEY, orq login session: API key is not valid for this workspace.)",
		LOGIN_CTA,
	]);
	expect(LOGIN_CTA).toContain("/login");
	expect(LOGIN_CTA).toContain("/key");
	expect(LOGIN_HINT).toContain("/login"); // the browser sign-in
	expect(LOGIN_HINT).toContain("/key"); // the masked paste
});

test("serverOf reads the host out of either whoami shape", () => {
	// A profile answers with `server`; a browser login answers with `urls.api_base_url`
	// and no `server` at all. Reading only the first sends a my.orq.ai session token
	// to api.orq.ai, which the MCP server rejects as invalid_token.
	expect(serverOf('{"profile":"aim","server":"https://aim.orq.ai"}')).toBe("https://aim.orq.ai");
	expect(serverOf('{"authenticated":true,"urls":{"api_base_url":"https://my.orq.ai"}}')).toBe("https://my.orq.ai");
	expect(serverOf('{"authenticated":true,"urls":{}}')).toBeUndefined();
	expect(serverOf("you are not logged in")).toBeUndefined();
});

test("profileOf names the API-key profile the CLI resolved", () => {
	// ORQ_PROFILE pins a profile for the CLI; whoami is how orqi learns one is in force.
	expect(profileOf('{"profile":"achmea-aim-ithaka","server":"https://aim.orq.ai"}')).toBe("achmea-aim-ithaka");
	expect(profileOf('{"profile":null}')).toBeUndefined();
	expect(profileOf("you are not logged in")).toBeUndefined();
});

test("profileKey reads the profile's key out of the CLI's credentials file", () => {
	// whoami names the profile but masks its key, so this one lookup is orqi's.
	// Every step is optional: a moved file or a renamed field must warn, not throw.
	const file = join(tmpdir(), `orqi-credentials-${process.pid}.json`);
	writeFileSync(file, JSON.stringify({ profiles: { aim: { api_key: "sk-orq-abc", server: "https://aim.orq.ai" }, keyless: {} } }));
	expect(profileKey("aim", file)).toBe("sk-orq-abc");
	expect(profileKey("keyless", file)).toBeUndefined();
	expect(profileKey("absent", file)).toBeUndefined();
	expect(profileKey("aim", join(tmpdir(), "orqi-no-such-file.json"))).toBeUndefined();
	rmSync(file, { force: true });

	// The CLI's config dir is a setting, so the file follows it.
	expect(credentialsFile({ ORQ_CONFIG_DIRECTORY: "/tmp/orq" })).toBe("/tmp/orq/credentials.json");
	expect(credentialsFile({})).toEndWith("/.orq/credentials.json");
});

test("workspaceOfKey reads the workspace out of an orq API key", () => {
	// orq keys are sk-orq-<jwt> and the payload carries workspace_id, so a key
	// identifies its own workspace even with no login session on the machine.
	const claims = { iss: "orq.ai", workspace_id: "624ccbbd-a482-40e2-b3d9-3621e09da1f8" };
	const key = `sk-orq-header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

	// With a session to map against, the human key wins.
	const session = { workspaces: [{ id: claims.workspace_id, key: "orq-research" }] };
	expect(workspaceOfKey(key, session)).toBe("orq-research");

	// Without one, a short id beats showing nothing.
	expect(workspaceOfKey(key, undefined)).toBe("624ccbbd");

	expect(workspaceOfKey("not-a-key", undefined)).toBeUndefined();
	expect(workspaceOfKey("sk-orq-a.notbase64!!.c", undefined)).toBeUndefined();
});

test("sessionToken finds the workspace's token across CLI versions", () => {
	// 6.x: tokens are project-scoped, keyed `<workspace>#<projectId>`.
	expect(
		sessionToken({
			activeWorkspaceKey: "orq-research",
			activeProjectId: "30365aee",
			workspaceTokens: { "orq-research#30365aee": { token: "tok-6x" } },
		}),
	).toBe("tok-6x");

	// 5.x: bare workspace key, no project in the mix at all.
	expect(
		sessionToken({
			activeWorkspaceKey: "orq-research",
			workspaceTokens: { "orq-research": { token: "tok-5x" } },
		}),
	).toBe("tok-5x");

	// activeProjectId missing or stale: fall back to any entry for the workspace.
	expect(
		sessionToken({
			activeWorkspaceKey: "orq-research",
			workspaceTokens: { "orq-research#other-project": { token: "tok-fallback" } },
		}),
	).toBe("tok-fallback");

	expect(sessionToken(undefined)).toBeUndefined();
	expect(sessionToken({ activeWorkspaceKey: "orq-research", workspaceTokens: {} })).toBeUndefined();
	expect(sessionToken({ workspaceTokens: { "orq-research": { token: "tok" } } })).toBeUndefined();
});

test("main.ts builds orqCommands once, so its connection state outlives /new, /resume and /fork", () => {
	// makeServices runs per session; a factory built inside it starts from the
	// boot's rejections again, and a /reconnect that worked is forgotten.
	const source = readFileSync(join(import.meta.dir, "main.ts"), "utf8");
	const body = source.slice(source.indexOf("const makeServices"), source.indexOf("const services = await makeServices()"));
	expect(body.length).toBeGreaterThan(0);
	expect(body).not.toContain("orqCommands(");
	expect(source).toContain("const commands = orqCommands(");
});

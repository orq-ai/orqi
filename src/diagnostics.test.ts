/** Checks for /whoami and /doctor's panels. Run with `bun test`. */

import { expect, test } from "bun:test";
import {
	checkRows,
	doctorHeader,
	fieldRows,
	maskKey,
	noticeText,
	parseDoctor,
	python3Check,
	redactKeys,
	sortChecks,
	summary,
	whoamiRows,
} from "./diagnostics.ts";

test("fieldRows pads the labels and leaves out what the CLI did not say", () => {
	expect(
		fieldRows([
			["a", "1"],
			["longer", "2"],
			["gone", undefined],
		]),
	).toEqual(["a       1", "longer  2"]);
});

test("whoami for an exported key reads as aligned fields", () => {
	const rows = whoamiRows(
		JSON.stringify({
			api_key: "sk-orq-01M4Z…",
			authenticated: true,
			identity: null,
			method: "api_key",
			server: "https://my.orq.ai",
			session_file: "/Users/a/.orq/sessions/my.orq.ai.json",
			source: "ORQ_API_KEY",
		}),
	)!;
	expect(rows).toEqual([
		"authenticated  yes",
		"method         api_key",
		"source         ORQ_API_KEY",
		"server         https://my.orq.ai",
		"api key        sk-orq-01M4Z…",
		"session file   /Users/a/.orq/sessions/my.orq.ai.json",
	]);
});

test("whoami for a browser login names the host from urls, and the identity from an object", () => {
	const rows = whoamiRows(
		JSON.stringify({ authenticated: true, identity: { email: "a@orq.ai" }, urls: { api_base_url: "https://acme.example.orq.ai" } }),
	)!;
	expect(rows.join("\n")).toContain("identity       a@orq.ai");
	expect(rows.join("\n")).toContain("server         https://acme.example.orq.ai");
});

test("a rejected credential says no, with the server's reason", () => {
	const rows = whoamiRows(JSON.stringify({ authenticated: false, auth_error: "token expired" }))!;
	expect(rows[0]).toBe("authenticated  no: token expired");
	expect(whoamiRows(JSON.stringify({ authenticated: false }))![0]).toBe("authenticated  no: the server rejected it");
});

test("whoami output that is not a JSON object is undefined, so the CLI's own text is shown", () => {
	expect(whoamiRows("not json")).toBeUndefined();
	expect(whoamiRows("[]")).toBeUndefined();
	expect(whoamiRows("null")).toBeUndefined();
});

const doctor = JSON.stringify({
	auth: { active_workspace_key: "orq-research", status: "authenticated", user_email: "a@orq.ai", workspace_count: 10 },
	binary: { name: "orq", version: "11.5.1" },
	checks: [
		{ id: "session_file", status: "pass", message: "Session file loaded" },
		{ id: "coding_agent_codex", status: "info", message: "Codex detected but not wired" },
		{ id: "mcp", status: "warn", message: "no MCP entry for codex" },
		{ id: "api_base_url", status: "pass", message: "Reachable" },
		{ id: "broken", status: "fail", message: "unreachable" },
	],
});

test("doctor reads who and where, then every check", () => {
	const parsed = parseDoctor(doctor)!;
	expect(doctorHeader(parsed)).toEqual(["status     authenticated", "user       a@orq.ai", "workspace  orq-research", "orq cli    11.5.1"]);
	expect(parsed.checks.length).toBe(5);
});

test("doctor puts problems first and keeps the CLI's order within a status", () => {
	const order = sortChecks(parseDoctor(doctor)!.checks).map((c) => c.id);
	expect(order).toEqual(["broken", "mcp", "coding_agent_codex", "session_file", "api_base_url"]);
});

test("a check row carries a mark, the status word, the id and the message", () => {
	const rows = checkRows(sortChecks(parseDoctor(doctor)!.checks));
	expect(rows[0]).toBe("✗ fail  broken              unreachable");
	expect(rows[1]).toBe("! warn  mcp                 no MCP entry for codex");
	expect(rows[4]).toBe("✓ pass  api_base_url        Reachable");
});

test("the summary counts each status, worst first", () => {
	expect(summary(parseDoctor(doctor)!.checks)).toBe("1 fail · 1 warn · 1 info · 2 pass");
});

test("a doctor answer without checks is undefined; a check without an id is skipped", () => {
	expect(parseDoctor("nope")).toBeUndefined();
	expect(parseDoctor("{}")).toBeUndefined();
	expect(
		parseDoctor(JSON.stringify({ checks: [{ status: "pass" }, { id: "ok", status: "pass", message: "m" }] }))!.checks.map((c) => c.id),
	).toEqual(["ok"]);
});

test("a long pass is cut with an ellipsis, so the row never wraps out of its column", () => {
	const [row] = checkRows([{ id: "skills", status: "pass", message: "x".repeat(200) }], 20);
	expect(row!.endsWith("xxxxxxxxxxxxxxxxxxx…")).toBe(true);
	expect(checkRows([{ id: "a", status: "pass", message: "Reachable" }])[0]).toBe("✓ pass  a  Reachable");
});

test("a long warn keeps its whole message, wrapped under the message column", () => {
	const message = "no MCP entry for codex, opencode, kimi, kilo run orq connect codex opencode kimi kilo mcp";
	const rows = checkRows([{ id: "mcp", status: "warn", message }], 30);
	expect(rows.length).toBeGreaterThan(1);
	// Nothing was lost: the words rejoin to the original.
	expect(
		rows
			.map((r) => r.slice(rows[0]!.indexOf("no MCP")))
			.join(" ")
			.replace(/\s+/g, " ")
			.includes("orq connect codex opencode kimi kilo mcp"),
	).toBe(true);
	// Continuations start in the message column, not at the left edge.
	const column = rows[0]!.indexOf("no MCP");
	for (const row of rows.slice(1)) expect(row.slice(0, column).trim()).toBe("");
	expect(rows.slice(1).every((row) => row.length > column)).toBe(true);
});

test("a long fail is wrapped too, never cut", () => {
	const rows = checkRows([{ id: "api", status: "fail", message: "unreachable ".repeat(10).trim() }], 24);
	expect(rows.join(" ").match(/unreachable/g)!.length).toBe(10);
	expect(rows.some((r) => r.includes("…"))).toBe(false);
});

test("a key is never shown whole, even if the CLI stops masking it", () => {
	// What the CLI sends today: already a stub, kept as it is.
	expect(maskKey("sk-orq-01M4Z…")).toBe("sk-orq-01M…".replace("01M…", "01M4Z…"));
	// What an older or changed CLI might send: the whole credential.
	const raw = "sk-orq-eyJhbGciOiJIUzI1NiJ9.payload.signature";
	expect(maskKey(raw)).toBe("sk-orq-eyJ…");
	expect(maskKey(raw)).not.toContain("signature");
	const rows = whoamiRows(JSON.stringify({ authenticated: true, method: "api_key", api_key: raw }))!;
	expect(rows.join("\n")).not.toContain("payload");
	expect(rows.join("\n")).not.toContain("signature");
	expect(rows.join("\n")).toContain("api key        sk-orq-eyJ…");
});

test("redactKeys hides an orq key inside the CLI's own words, and leaves the rest", () => {
	const out = redactKeys("error: key sk-orq-eyJhbGciOiJIUzI1NiJ9.payload.sig rejected\nsee https://docs.orq.ai");
	expect(out).toBe("error: key sk-orq-eyJ… rejected\nsee https://docs.orq.ai");
	expect(redactKeys("nothing secret here")).toBe("nothing secret here");
	// A short, already-masked stub is not mangled.
	expect(redactKeys("api_key: sk-orq-01M4Z…")).toBe("api_key: sk-orq-01M4Z…");
});

test("a multi-line auth error is one line in the whoami panel", () => {
	const rows = whoamiRows(
		JSON.stringify({ authenticated: false, auth_error: "Authorization token is invalid.\n  docs: https://docs.orq.ai/reference" }),
	)!;
	expect(rows[0]).toBe("authenticated  no: Authorization token is invalid. docs: https://docs.orq.ai/reference");
	expect(rows.every((row) => !row.includes("\n"))).toBe(true);
});

test("an auth error that echoes the key is redacted in the whoami panel too", () => {
	const key = "sk-orq-eyJhbGciOiJIUzI1NiJ9.payload.signature";
	const rows = whoamiRows(JSON.stringify({ authenticated: false, auth_error: `token ${key} is invalid` }))!;
	expect(rows[0]).toBe("authenticated  no: token sk-orq-eyJ… is invalid");
	expect(rows.join("")).not.toContain("signature");
	// No error text at all still says why.
	expect(whoamiRows(JSON.stringify({ authenticated: false, auth_error: "" }))![0]).toBe("authenticated  no: the server rejected it");
});

test("a notice is one safe line per row: where no panel is drawn, nothing reaches the terminal raw", () => {
	const hostile = "evil\nline\x1b[2J\x1b]0;pwned\x07\x9b2J";
	const who = whoamiRows(JSON.stringify({ authenticated: true, identity: hostile, method: "api_key" }))!;
	// The rows themselves still carry it: cleaning happens where they are shown.
	expect(who.join("\n")).toContain("\x1b[2J");
	const shown = noticeText(who);
	expect(shown).not.toContain("\x1b");
	expect(shown).not.toMatch(/[\x80-\x9f]/);
	// The newlines left are the ones that separate rows, one per row.
	expect(shown.split("\n").length).toBe(who.length);

	const doc = parseDoctor(
		JSON.stringify({ auth: { user_email: hostile, status: "ok" }, checks: [{ id: "c", status: "warn", message: hostile }] }),
	)!;
	const out = noticeText([...doctorHeader(doc), ...checkRows(doc.checks)]);
	expect(out).not.toContain("\x1b");
	expect(out.split("\n").length).toBe(doctorHeader(doc).length + checkRows(doc.checks).length);
});

test("doctor's python3 row: the version when it runs, how to get it when it does not, and too old for memorq", () => {
	const ran =
		(stdout: string, stderr = "", exitCode = 0) =>
		() => ({ exitCode, stdout, stderr });
	expect(python3Check(ran("Python 3.12.4\n"))).toEqual({ id: "python3", status: "pass", message: "python3 3.12.4" });
	// Python 2 and some 3.x builds print the version on stderr.
	expect(python3Check(ran("", "Python 3.9.6\n"))).toEqual({ id: "python3", status: "pass", message: "python3 3.9.6" });
	const missing = { id: "python3", status: "fail", message: "python3 not found; memory notes need it (brew install python3)" };
	expect(
		python3Check(() => {
			throw new Error("ENOENT");
		}),
	).toEqual(missing);
	expect(python3Check(ran("", "not found", 127))).toEqual(missing);
	expect(python3Check(ran("Python 3.8.10\n"))).toEqual({
		id: "python3",
		status: "fail",
		message: "python3 3.8.10 is too old; memory notes need 3.9 or newer",
	});
});

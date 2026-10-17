/**
 * `/whoami` and `/doctor` as panels. The orq CLI answers both with JSON
 * (`-o json`); this turns each into aligned rows. Pure, so the shapes the CLI
 * has answered in are covered by tests rather than by a live login.
 *
 * Neither formatter reads a file or prints a credential: whoami's `api_key` is
 * already masked by the CLI (`sk-orq-01M4Z…`) and is shown as it arrives.
 */

import { oneLine } from "./panel.ts";

const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

/** `key   value` rows with the labels padded to the longest, empty values left out. */
export function fieldRows(fields: [string, string | undefined][]): string[] {
	const present = fields.filter((field): field is [string, string] => field[1] !== undefined);
	const width = Math.max(0, ...present.map(([label]) => label.length));
	return present.map(([label, value]) => `${label.padEnd(width)}  ${value}`);
}

/**
 * A key as it may be shown: the CLI already masks it (`sk-orq-01M4Z…`), but
 * that is the CLI's promise, not ours, and a key is a credential. Anything that
 * is not already a short, ellipsised stub is cut to its first ten characters.
 */
export function maskKey(key: string): string {
	const stub = key.endsWith("…") && key.length <= 20;
	return stub ? key : `${key.slice(0, 10)}…`;
}

/**
 * Hide any orq key inside free text: the fallback prints the CLI's own words,
 * whose shape we do not know, so a pattern is the only guard it can have.
 */
export function redactKeys(output: string): string {
	return output.replace(/sk-orq-[A-Za-z0-9._-]{8,}/g, (key) => maskKey(key));
}

/**
 * Rows as one notice, for where no panel can be drawn. A panel makes every row a
 * safe line (`boxLines`); a notice goes to the terminal as it is, so each row is
 * made one line here, the same way, before they are joined by the newlines we add.
 */
export function noticeText(rows: string[]): string {
	return rows.map(oneLine).join("\n");
}

/** One line: server-supplied text (an auth error runs to several lines) collapsed to single spaces. */
const flat = (value: string | undefined): string | undefined => (value === undefined ? undefined : value.replace(/\s+/g, " ").trim());

const maskKeyIfPresent = (key: string | undefined): string | undefined => (key === undefined ? undefined : maskKey(key));

/** Rows for `orq auth whoami -o json`, or undefined when it is not a JSON object. */
export function whoamiRows(json: string): string[] | undefined {
	let who: Record<string, unknown>;
	try {
		const parsed = JSON.parse(json);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		who = parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
	const identity = who.identity;
	const who_ =
		text(identity) ??
		(identity && typeof identity === "object"
			? (text((identity as Record<string, unknown>).email) ?? text((identity as Record<string, unknown>).name))
			: undefined);
	// whoami says `authenticated: false` with the server's reason for a 401; a
	// failed check leaves it true, which is no verdict.
	const authenticated =
		who.authenticated === false
			? `no: ${flat(redactKeys(text(who.auth_error) ?? "")) || "the server rejected it"}`
			: who.authenticated === true
				? "yes"
				: undefined;
	return fieldRows([
		["authenticated", authenticated],
		["identity", who_],
		["method", text(who.method)],
		["source", text(who.source)],
		["profile", text(who.profile)],
		["server", text(who.server) ?? text((who.urls as Record<string, unknown> | undefined)?.api_base_url)],
		["api key", flat(maskKeyIfPresent(text(who.api_key)))],
		["session file", text(who.session_file)],
	]);
}

export type CheckStatus = "pass" | "info" | "warn" | "fail";

export interface Check {
	id: string;
	status: string;
	message: string;
}

export interface Doctor {
	auth: { workspace?: string; email?: string; status?: string };
	version?: string;
	checks: Check[];
}

/** The doctor payload we use, or undefined when it is not the shape the CLI prints. */
export function parseDoctor(json: string): Doctor | undefined {
	let parsed: Record<string, any>;
	try {
		parsed = JSON.parse(json);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.checks)) return undefined;
	const checks: Check[] = [];
	for (const item of parsed.checks) {
		const id = text(item?.id);
		if (!id) continue;
		checks.push({ id, status: text(item.status) ?? "info", message: text(item.message) ?? "" });
	}
	return {
		auth: {
			workspace: text(parsed.auth?.active_workspace_key),
			email: text(parsed.auth?.user_email),
			status: text(parsed.auth?.status),
		},
		version: text(parsed.binary?.version),
		checks,
	};
}

/** How `python3Check` runs a command: Bun.spawnSync's shape, so a test can stand in for it. */
type Run = (cmd: string[]) => { exitCode: number | null; stdout: { toString(): string }; stderr: { toString(): string } };

const spawnRun: Run = (cmd) => Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });

/**
 * /doctor's row for the Python memorq runs on: memory notes are written by a stdlib Python 3.9+
 * script, and with no python3 the memory section stays silent with nothing else to say why.
 */
export function python3Check(run: Run = spawnRun): Check {
	const missing: Check = { id: "python3", status: "fail", message: "python3 not found; memory notes need it (brew install python3)" };
	let out: ReturnType<Run>;
	try {
		out = run(["python3", "--version"]);
	} catch {
		return missing;
	}
	const version = /Python (\d+)\.(\d+)(\.\d+)?/.exec(`${out.stdout.toString()} ${out.stderr.toString()}`);
	if (out.exitCode !== 0 || !version) return missing;
	const [text, major, minor] = [version[0].slice("Python ".length), Number(version[1]), Number(version[2])];
	if (major < 3 || (major === 3 && minor < 9))
		return { id: "python3", status: "fail", message: `python3 ${text} is too old; memory notes need 3.9 or newer` };
	return { id: "python3", status: "pass", message: `python3 ${text}` };
}

/** A glyph per status that reads without colour: the words stay in the row. */
const MARK: Record<string, string> = { pass: "✓", info: "·", warn: "!", fail: "✗" };

/** Problems first (fail, warn), then info, then passes: what needs attention is at the top. */
const ORDER: Record<string, number> = { fail: 0, warn: 1, info: 2, pass: 3 };

export function sortChecks(checks: Check[]): Check[] {
	return checks
		.map((check, index) => ({ check, index }))
		.sort((a, b) => (ORDER[a.check.status] ?? 2) - (ORDER[b.check.status] ?? 2) || a.index - b.index)
		.map(({ check }) => check);
}

/** Greedy word wrap to `room` columns; a word longer than that stays whole rather than splitting a command. */
function wrap(message: string, room: number): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of message.split(/\s+/).filter(Boolean)) {
		if (line && line.length + 1 + word.length > room) {
			lines.push(line);
			line = word;
		} else line = line ? `${line} ${word}` : word;
	}
	if (line) lines.push(line);
	return lines.length ? lines : [""];
}

/**
 * `✓ pass  session_file   Session file loaded`: mark, status word, id and message, aligned.
 *
 * A pass or info message longer than `room` is cut with an ellipsis: it is context, and the
 * full text is one `orq doctor` away. A warn or fail is never cut, because its message is the
 * remedy ("run 'orq connect ...'"); it wraps onto continuation lines indented to the message
 * column, so the table still reads as one.
 */
export function checkRows(checks: Check[], room = 56): string[] {
	const width = Math.min(24, Math.max(0, ...checks.map((check) => check.id.length)));
	const indent = " ".repeat(2 + 4 + 2 + width + 2);
	return checks.flatMap((check) => {
		const head = `${MARK[check.status] ?? "·"} ${check.status.padEnd(4)}  ${check.id.slice(0, width).padEnd(width)}  `;
		if (check.status === "warn" || check.status === "fail") {
			const [first = "", ...rest] = wrap(check.message, room);
			return [`${head}${first}`.trimEnd(), ...rest.map((line) => `${indent}${line}`)];
		}
		const message = check.message.length > room ? `${check.message.slice(0, room - 1).trimEnd()}…` : check.message;
		return [`${head}${message}`.trimEnd()];
	});
}

/** `3 pass · 1 warn`: the badge and the one-line verdict. */
export function summary(checks: Check[]): string {
	const counts = new Map<string, number>();
	for (const check of checks) counts.set(check.status, (counts.get(check.status) ?? 0) + 1);
	return [...counts.entries()]
		.sort((a, b) => (ORDER[a[0]] ?? 2) - (ORDER[b[0]] ?? 2))
		.map(([status, n]) => `${n} ${status}`)
		.join(" · ");
}

/** The header rows above the checks: who, where, which CLI. */
export function doctorHeader(doctor: Doctor): string[] {
	return fieldRows([
		["status", doctor.auth.status],
		["user", doctor.auth.email],
		["workspace", doctor.auth.workspace],
		["orq cli", doctor.version],
	]);
}

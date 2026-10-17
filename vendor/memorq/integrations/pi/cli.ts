/**
 * The extension's one way to run a memorq.py subcommand and read its answer (`settings`, `state`, `notes`, ...): the
 * same script the hooks call, so pi and Claude Code read one store and one settings file.
 */

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "memorq.py");

// Every command about a repository takes it as --cwd; `settings set|unset` change the machine's file, `report` and
// `dashboard` read the process's directory, and `hook` reads its cwd from stdin (an unknown flag is exit 2 there).
const CWD_COMMANDS = new Set(["settings", "state", "notes", "pause", "store", "promote", "dream"]);

export function takesCwd(args: string[]): boolean {
	return CWD_COMMANDS.has(args[0]) && !(args[0] === "settings" && (args[1] === "set" || args[1] === "unset"));
}

export function hookEnv(): NodeJS.ProcessEnv {
	// orqi users may have neither `pi` nor `claude` installed, and orqi already holds an accepted orq key.
	const orqi = Boolean(process.env.ORQI_THREAD_ID) && !process.env.ORQ_NOTES_LLM;
	return orqi ? { ...process.env, ORQ_NOTES_LLM: "orq" } : process.env;
}

export type Result = { ok: true; out: string } | { ok: false; err: string };

/** Run `memorq.py <args>` from `cwd`; any non-zero exit (or none: no python3, a timeout) is a failure, told by its
 * last stderr line (`✗ ...`), and so is an argument spawnSync refuses (a NUL byte in typed input): never a throw.
 * The 10 s cap sits above the 5 s that `pause` and `promote` wait for the store lock. */
export function call(args: string[], cwd: string): Result {
	if (!existsSync(cwd)) return { ok: false, err: `${cwd} no longer exists` }; // spawnSync would blame python3
	const argv = [SCRIPT, ...args, ...(takesCwd(args) ? ["--cwd", cwd] : [])];
	let out: SpawnSyncReturns<string>;
	try {
		out = spawnSync("python3", argv, { cwd, timeout: 10_000, encoding: "utf8", env: hookEnv() });
	} catch (err) {
		return { ok: false, err: err instanceof Error ? err.message : String(err) };
	}
	if (out.status === 0) return { ok: true, out: out.stdout };
	const last = (out.stderr ?? "").trim().split("\n").at(-1);
	return { ok: false, err: last || out.error?.message || `exit ${out.status}` };
}

/** `call`'s output parsed as JSON; undefined when the command failed, printed something else, or printed null. */
export function json<T>(args: string[], cwd: string): T | undefined {
	const result = call(args, cwd);
	if (!result.ok) return undefined;
	try {
		return (JSON.parse(result.out) ?? undefined) as T | undefined;
	} catch {
		return undefined;
	}
}

/** Checks for telling whether memorq is installed: package entries as strings or objects, trust as pi applies it. */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { isMemorqSource, memorqChecks, memorqInstalled } from "./memorq-detect.ts";

/** An agent dir and a project, each with optional package settings. */
function scene(options: { global?: unknown[]; project?: unknown[] } = {}) {
	const root = mkdtempSync(join(tmpdir(), "orqi-memorq-detect-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "repo");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".orqi"), { recursive: true });
	if (options.global) writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: options.global }));
	if (options.project) writeFileSync(join(cwd, ".orqi", "settings.json"), JSON.stringify({ packages: options.project }));
	const settings = (trusted: boolean) => SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
	return { settings, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("memorq installed with orqi plugin install, as a string or as { source }", () => {
	for (const entry of ["git:github.com/orq-ai/orq-knowledge-notes", { source: "git:github.com/orq-ai/orq-knowledge-notes@v0.12.0" }]) {
		const s = scene({ global: ["npm:@someone/other-package", entry] });
		try {
			expect(memorqInstalled(s.settings(false))).toBe(true);
		} finally {
			s.done();
		}
	}
	const none = scene({ global: ["npm:@someone/other-package"] });
	try {
		expect(memorqInstalled(none.settings(true))).toBe(false);
	} finally {
		none.done();
	}
});

test("a project listing memorq counts only when the project is trusted, as pi only loads it then", () => {
	const s = scene({ project: [{ source: "../memorq" }] });
	try {
		expect(memorqInstalled(s.settings(true))).toBe(true);
		expect(memorqInstalled(s.settings(false))).toBe(false);
	} finally {
		s.done();
	}
});

test("memorq is the repository or a folder named memorq, not any source that mentions the word", () => {
	for (const source of [
		"git:github.com/orq-ai/orq-knowledge-notes",
		"https://github.com/orq-ai/orq-knowledge-notes.git",
		"../memorq",
		"/src/memorq/",
		"git:example.com/me/memorq.git",
		"npm:memorq@0.12.0",
		"git:example.com/me/memorq@v1",
		"git:example.com/me/memorq.git#main",
		"git:github.com/orq-ai/orq-knowledge-notes#main",
		"npm:orq-knowledge-notes@0.12.0",
	])
		expect(isMemorqSource(source)).toBe(true);
	for (const source of [
		"npm:memorq-themes",
		"../not-memorq-at-all/x",
		"git:github.com/me/memorquest",
		"npm:memorq-x@1",
		"npm:orq-knowledge-notes-theme",
		"git:github.com/me/orq-knowledge-notes-fork",
		"git:github.com/orq-ai/orq-knowledge-notes/extras/other",
		"",
	])
		expect(isMemorqSource(source)).toBe(false);
	expect(isMemorqSource({ source: 7 })).toBe(false);
});

test("/doctor's memorq rows: none without memorq, and python3 only when memorq is here", () => {
	let asked = 0;
	const python = () => {
		asked++;
		return { id: "python3", status: "fail", message: "python3 not found" };
	};
	// No memorq: nothing about memory, and python3 is not even checked.
	expect(memorqChecks("none", python)).toEqual([]);
	expect(asked).toBe(0);
	expect(memorqChecks("loaded", python)).toEqual([{ id: "memorq", status: "pass", message: "memorq loaded" }, python()]);
	expect(memorqChecks("installed", python).map((check) => check.id)).toEqual(["memorq", "python3"]);
	expect(memorqChecks("installed", python)[0]!.status).toBe("warn");
});

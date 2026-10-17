/** Checks for the memorq orqi carries: the vendored tree against its lock, and when the bundled copy is handed to pi. */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { memorqBundle, VENDORED } from "./memorq-bundle.ts";

const ROOT = join(import.meta.dir, "..");
const VENDOR = join(ROOT, "vendor", "memorq");

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});
}

test("memorq.lock.json matches what is vendored, and the tree is text the build can embed", () => {
	const lock = JSON.parse(readFileSync(join(ROOT, "memorq.lock.json"), "utf8"));
	const files = walk(VENDOR).map((path) => relative(VENDOR, path));
	expect(lock.sha).toMatch(/^[0-9a-f]{40}$/);
	expect(lock.version).toBe(JSON.parse(readFileSync(join(VENDOR, ".claude-plugin", "plugin.json"), "utf8")).version);
	expect(lock.files).toBe(files.length);
	expect(typeof lock.source).toBe("string");
	// Only what scripts/vendor-memorq.ts copies: a hand-added file, or a __pycache__ from running it in place, fails here.
	expect(files.filter((path) => !VENDORED.some((pattern) => pattern.test(path)))).toEqual([]);
	for (const path of files) expect(readFileSync(join(VENDOR, path)).subarray(0, 8192).includes(0)).toBe(false);
	// pi loads the extension the package names, so it must be there.
	const manifest = JSON.parse(readFileSync(join(VENDOR, "package.json"), "utf8"));
	expect(manifest.pi.extensions.length).toBeGreaterThan(0);
	for (const entry of manifest.pi.extensions) expect(files).toContain(join(entry));
	expect(files).toContain("scripts/memorq.py");
});

/** A pkgDir with a vendored memorq of `version`, an agent dir and a project, each with optional settings. */
function scene(options: { global?: unknown[]; project?: unknown[]; vendored?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "orqi-memorq-bundle-"));
	const pkgDir = join(root, "pkg");
	const agentDir = join(root, "agent");
	const cwd = join(root, "repo");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".orqi"), { recursive: true });
	if (options.vendored !== false) {
		mkdirSync(join(pkgDir, "vendor", "memorq", ".claude-plugin"), { recursive: true });
		writeFileSync(join(pkgDir, "vendor", "memorq", ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.12.0" }));
		writeFileSync(
			join(pkgDir, "vendor", "memorq", "package.json"),
			JSON.stringify({ pi: { extensions: ["./integrations/pi/memorq.ts"] } }),
		);
	}
	if (options.global) writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: options.global }));
	if (options.project) writeFileSync(join(cwd, ".orqi", "settings.json"), JSON.stringify({ packages: options.project }));
	const settings = (trusted: boolean) => SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
	return { root, pkgDir, settings, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("with no memorq installed, the bundled copy is handed to pi", () => {
	const s = scene({ global: ["npm:@someone/other-package"] });
	try {
		expect(memorqBundle(s.pkgDir, s.settings(true))).toEqual({
			path: join(s.pkgDir, "vendor", "memorq"),
			note: "memorq 0.12.0",
			source: "bundled",
		});
	} finally {
		s.done();
	}
});

test("memorq installed with orqi plugin install, as a string or as { source }: the bundled copy stays out", () => {
	for (const entry of ["git:github.com/orq-ai/orq-knowledge-notes", { source: "git:github.com/orq-ai/orq-knowledge-notes@v0.12.0" }]) {
		const s = scene({ global: [entry] });
		try {
			expect(memorqBundle(s.pkgDir, s.settings(false))).toEqual({ note: "memorq: installed package in use", source: "installed" });
		} finally {
			s.done();
		}
	}
});

test("a project listing memorq counts only when the project is trusted, as pi only loads it then", () => {
	const s = scene({ project: [{ source: "../memorq" }] });
	try {
		expect(memorqBundle(s.pkgDir, s.settings(true)).path).toBeUndefined();
		// Untrusted: pi will not load the project's package, so without the bundle there would be no memorq at all.
		expect(memorqBundle(s.pkgDir, s.settings(false)).path).toBe(join(s.pkgDir, "vendor", "memorq"));
	} finally {
		s.done();
	}
});

test("a checkout that was never vendored hands pi nothing and says nothing", () => {
	const s = scene({ vendored: false });
	try {
		expect(memorqBundle(s.pkgDir, s.settings(true))).toEqual({ note: "", source: "none" });
	} finally {
		s.done();
	}
});

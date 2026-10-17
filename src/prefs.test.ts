/** Checks for orqi.json: which inspector sections show, read forgivingly and written whole. */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SECTIONS, readPrefs, SECTIONS, writePrefs } from "./prefs.ts";

const scratch = () => mkdtempSync(join(tmpdir(), "orqi-prefs-"));

test("prefs default, survive garbage, round-trip and ignore unknown ids", () => {
	const dir = scratch();
	try {
		expect(readPrefs(dir)).toEqual({ sections: DEFAULT_SECTIONS });
		writeFileSync(join(dir, "orqi.json"), "{nope");
		expect(readPrefs(dir).sections.process).toBe(false);
		writeFileSync(join(dir, "orqi.json"), JSON.stringify({ sections: { process: true, bogus: true } }));
		expect(readPrefs(dir).sections).toEqual({ ...DEFAULT_SECTIONS, process: true });
		writePrefs(dir, { sections: { ...DEFAULT_SECTIONS, tips: false } });
		expect(readPrefs(dir).sections.tips).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the draw order ends with tips, and process starts off", () => {
	expect(SECTIONS).toEqual(["signals", "context", "memory", "process", "tips"]);
	expect(DEFAULT_SECTIONS).toEqual({ signals: true, context: true, memory: true, process: false, tips: true });
});

test("orqi.json that is missing, unreadable or the wrong shape reads as the defaults", () => {
	const dir = scratch();
	try {
		// The agent dir itself may not exist yet on a first run.
		expect(readPrefs(join(dir, "nowhere"))).toEqual({ sections: DEFAULT_SECTIONS });
		for (const body of ["", "null", "[]", '"x"', "42", '{"sections":null}', '{"sections":[true]}', '{"sections":"all"}']) {
			writeFileSync(join(dir, "orqi.json"), body);
			expect(readPrefs(dir)).toEqual({ sections: DEFAULT_SECTIONS });
		}
		// A value that is not a boolean is not a choice: that id keeps its default.
		writeFileSync(join(dir, "orqi.json"), JSON.stringify({ sections: { context: "no", process: 1, tips: false } }));
		expect(readPrefs(dir).sections).toEqual({ ...DEFAULT_SECTIONS, tips: false });
		// Unreadable: a directory where the file should be.
		rmSync(join(dir, "orqi.json"));
		mkdirSync(join(dir, "orqi.json"));
		expect(readPrefs(dir)).toEqual({ sections: DEFAULT_SECTIONS });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readPrefs hands out a fresh object, so a toggle never edits the defaults", () => {
	const dir = scratch();
	try {
		const prefs = readPrefs(dir);
		prefs.sections.signals = false;
		expect(DEFAULT_SECTIONS.signals).toBe(true);
		expect(readPrefs(dir).sections.signals).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writePrefs rewrites the file whole: unknown ids and keys are gone, every section is named, owner-only", () => {
	const dir = scratch();
	try {
		writeFileSync(join(dir, "orqi.json"), JSON.stringify({ sections: { process: true, bogus: true }, stale: 1 }));
		const prefs = readPrefs(dir);
		prefs.sections.context = false;
		writePrefs(dir, prefs);
		const written = readFileSync(join(dir, "orqi.json"), "utf8");
		expect(JSON.parse(written)).toEqual({ sections: { ...DEFAULT_SECTIONS, process: true, context: false } });
		expect(written).toBe(`${JSON.stringify(JSON.parse(written), null, 2)}\n`);
		expect(statSync(join(dir, "orqi.json")).mode & 0o777).toBe(0o600);
		expect(readdirSync(dir)).toEqual(["orqi.json"]); // no staging left behind
		// A first write creates the agent dir.
		writePrefs(join(dir, "fresh"), { sections: { ...DEFAULT_SECTIONS } });
		expect(readPrefs(join(dir, "fresh"))).toEqual({ sections: DEFAULT_SECTIONS });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { projectTrusted } from "./trust.ts";

function project(withExtension: boolean) {
	const root = mkdtempSync(join(tmpdir(), "orqi-trust-"));
	const cwd = join(root, "repo");
	mkdirSync(cwd, { recursive: true });
	if (withExtension) {
		mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "extensions", "x.ts"), "export default () => {};\n");
	}
	return { cwd, agentDir: join(root, "agent") };
}

describe("projectTrusted", () => {
	test("a project with nothing to trust is trusted", () => {
		const { cwd, agentDir } = project(false);
		expect(projectTrusted(cwd, agentDir, {})).toBe(true);
	});

	test("a cloned repo's .pi/extensions does not load unasked", () => {
		const { cwd, agentDir } = project(true);
		expect(projectTrusted(cwd, agentDir, {})).toBe(false);
	});

	test("a stored yes, or ORQI_TRUST_PROJECT=1, trusts it", () => {
		const { cwd, agentDir } = project(true);
		expect(projectTrusted(cwd, agentDir, { ORQI_TRUST_PROJECT: "1" })).toBe(true);
		expect(projectTrusted(cwd, agentDir, { ORQI_TRUST_PROJECT: "0" })).toBe(false);
		new ProjectTrustStore(agentDir).set(cwd, true);
		expect(projectTrusted(cwd, agentDir, {})).toBe(true);
	});
});

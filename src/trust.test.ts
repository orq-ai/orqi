import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { legacyProjectDir, projectTrusted, rebrandTrustWarning, UNTRUSTED_PROJECT } from "./trust.ts";

function project(withExtension: boolean, dir = ".orqi") {
	const root = mkdtempSync(join(tmpdir(), "orqi-trust-"));
	const cwd = join(root, "repo");
	mkdirSync(cwd, { recursive: true });
	if (withExtension) {
		mkdirSync(join(cwd, dir, "extensions"), { recursive: true });
		writeFileSync(join(cwd, dir, "extensions", "x.ts"), "export default () => {};\n");
	}
	return { cwd, agentDir: join(root, "agent") };
}

describe("projectTrusted", () => {
	test("a project with nothing to trust is trusted", () => {
		const { cwd, agentDir } = project(false);
		expect(projectTrusted(cwd, agentDir, {})).toBe(true);
	});

	test("a cloned repo's .orqi/extensions does not load unasked", () => {
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

	test(".pi/ is not orqi's project dir any more: nothing there to trust, and a one-time hint", () => {
		const legacy = project(true, ".pi");
		expect(projectTrusted(legacy.cwd, legacy.agentDir, {})).toBe(true); // ignored, so nothing runs
		expect(legacyProjectDir(legacy.cwd)).toBe(true);
		expect(legacyProjectDir(project(true).cwd)).toBe(false);
	});

	test("the untrusted warning says orqi and .orqi, under pi's own condition", () => {
		const said: string[] = [];
		class FakePiMode {
			constructor(
				public settingsManager: { isProjectTrusted(): boolean },
				public sessionManager: { getCwd(): string },
			) {}
			declare renderProjectTrustWarningIfNeeded: () => void;
			showWarning(message: string) {
				said.push(message);
			}
		}
		FakePiMode.prototype.renderProjectTrustWarningIfNeeded = () => said.push("then restart pi");
		rebrandTrustWarning(FakePiMode as any);
		const untrusted = { isProjectTrusted: () => false };
		new FakePiMode(untrusted, { getCwd: () => project(false).cwd }).renderProjectTrustWarningIfNeeded(); // nothing to trust
		new FakePiMode({ isProjectTrusted: () => true }, { getCwd: () => project(true).cwd }).renderProjectTrustWarningIfNeeded();
		new FakePiMode(untrusted, { getCwd: () => project(true).cwd }).renderProjectTrustWarningIfNeeded();
		expect(said).toEqual([UNTRUSTED_PROJECT]);
		expect(UNTRUSTED_PROJECT).toContain("restart orqi");
	});
});

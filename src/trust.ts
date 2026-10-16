import { existsSync } from "node:fs";
import { join } from "node:path";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "@earendil-works/pi-coding-agent";

/**
 * Whether a project's own pi resources load: `.orqi/extensions`, packages in
 * `.orqi/settings.json`, `.orqi/SYSTEM.md` (`.orqi`, not `.pi`: piConfig in
 * src/pi-package.ts). pi's SDK trusts every project, so a
 * cloned repo's extension would run inside orqi unasked. This is pi's own CLI
 * rule without its prompt: nothing there to trust, a yes already stored in
 * `<agentDir>/trust.json`, or ORQI_TRUST_PROJECT=1.
 */
export function projectTrusted(cwd: string, agentDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.ORQI_TRUST_PROJECT === "1" || !hasTrustRequiringProjectResources(cwd)) return true;
	return new ProjectTrustStore(agentDir).get(cwd) === true;
}

/** Said once at startup when a project still keeps its settings in `.pi/`, which orqi no longer reads. */
export const LEGACY_PROJECT_DIR = "orqi reads project settings from .orqi/ now; .pi/ here is ignored. Rename it to .orqi to keep using it.";

/** A project with a `.pi/` and no `.orqi/`: settings made for orqi before it read `.orqi/`. */
export function legacyProjectDir(cwd: string): boolean {
	return existsSync(join(cwd, ".pi")) && !existsSync(join(cwd, ".orqi"));
}

/** pi's untrusted-project warning, in orqi's words. */
export const UNTRUSTED_PROJECT =
	"This project is not trusted. Project .orqi resources and packages are ignored. Use /trust to save a trust decision, then restart orqi.";

type PiTrustMode = {
	settingsManager: { isProjectTrusted(): boolean };
	sessionManager: { getCwd(): string };
	showWarning(message: string): void;
};

/**
 * pi says "then restart pi" in this warning: a literal, not its app name, so
 * piConfig cannot reach it. Same condition, orqi's words. Patched only where pi
 * still has the method, so a rename upstream restores pi's text, not a crash.
 */
export function rebrandTrustWarning(InteractiveMode: { prototype: { renderProjectTrustWarningIfNeeded?: () => void } }): void {
	if (!InteractiveMode.prototype.renderProjectTrustWarningIfNeeded) return;
	InteractiveMode.prototype.renderProjectTrustWarningIfNeeded = function (this: PiTrustMode) {
		if (this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(this.sessionManager.getCwd())) return;
		this.showWarning(UNTRUSTED_PROJECT);
	};
}

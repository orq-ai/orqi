import { hasTrustRequiringProjectResources, ProjectTrustStore } from "@earendil-works/pi-coding-agent";

/**
 * Whether a project's own pi resources load: `.pi/extensions`, packages in
 * `.pi/settings.json`, `.pi/SYSTEM.md`. pi's SDK trusts every project, so a
 * cloned repo's extension would run inside orqi unasked. This is pi's own CLI
 * rule without its prompt: nothing there to trust, a yes already stored in
 * `<agentDir>/trust.json`, or ORQI_TRUST_PROJECT=1.
 */
export function projectTrusted(cwd: string, agentDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.ORQI_TRUST_PROJECT === "1" || !hasTrustRequiringProjectResources(cwd)) return true;
	return new ProjectTrustStore(agentDir).get(cwd) === true;
}

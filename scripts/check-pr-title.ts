#!/usr/bin/env bun
/**
 * Validate a pull-request title against Conventional Commits.
 *
 * Squash merge is configured with COMMIT_OR_PR_TITLE, so the PR title becomes
 * the squash commit subject on main. release.yml then feeds that subject to
 * scripts/release-version.ts (the version bump) and git-cliff (the release
 * notes). A title like "update stuff" produces no release for a real feature
 * and no changelog line, silently. This gate stops that at the PR.
 */

// The Conventional Commits types. The release bump only reacts to feat, fix,
// perf, revert, and breaking changes (see releaseBump); the rest are valid
// titles that intentionally ship no release.
export const CONVENTIONAL_TYPES = ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"] as const;

// `: \S` (not `: .+`) so a whitespace-only summary like "feat:   " is rejected,
// not just an empty one: that is the no-release / no-changelog case the gate exists for.
const PATTERN = new RegExp(`^(${CONVENTIONAL_TYPES.join("|")})(\\([^)\\n]+\\))?!?: \\S`);

/** Whether a PR title is a valid Conventional Commits subject. */
export function isConventionalTitle(title: string): boolean {
	const subject = title.split("\n", 1)[0] ?? "";
	return PATTERN.test(subject) && subject.trim().length > 0;
}

if (import.meta.main) {
	const title = process.argv[2] ?? "";
	if (!isConventionalTitle(title)) {
		process.stderr.write(
			`PR title is not a Conventional Commits subject: ${JSON.stringify(title)}\n\n` +
				`It becomes the squash commit on main, which drives the version bump and\n` +
				`the release notes. Use "type(scope): summary", for example:\n` +
				`  feat(router): add provider fallbacks\n` +
				`  fix: recover after a 401\n\n` +
				`Types: ${CONVENTIONAL_TYPES.join(", ")}. Append "!" for a breaking change.\n`,
		);
		process.exit(1);
	}
}

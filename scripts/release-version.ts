#!/usr/bin/env bun
/** Resolve the next stable SemVer version from conventional-commit messages. */

export type ReleaseBump = "major" | "minor" | "patch";

const rank: Record<ReleaseBump, number> = { patch: 1, minor: 2, major: 3 };

/** Return the highest release bump requested by these full commit messages. */
export function releaseBump(messages: readonly string[]): ReleaseBump | undefined {
	let selected: ReleaseBump | undefined;
	for (const message of messages) {
		const subject = message.split("\n", 1)[0] ?? "";
		let bump: ReleaseBump | undefined;
		if (/^[a-z]+(?:\([^)]+\))?!:/.test(subject) || /^BREAKING[ -]CHANGE:/mi.test(message)) bump = "major";
		else if (/^feat(?:\([^)]+\))?:/.test(subject)) bump = "minor";
		else if (/^(?:fix|perf|revert)(?:\([^)]+\))?:/.test(subject)) bump = "patch";
		if (bump && (!selected || rank[bump] > rank[selected])) selected = bump;
	}
	return selected;
}

/** Increment a strict x.y.z version. */
export function nextVersion(version: string, bump: ReleaseBump): string {
	const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
	if (!match) throw new Error(`invalid stable version: ${version}`);
	let [major, minor, patch] = match.slice(1).map(Number);
	if (bump === "major") [major, minor, patch] = [major + 1, 0, 0];
	if (bump === "minor") [minor, patch] = [minor + 1, 0];
	if (bump === "patch") patch += 1;
	return `${major}.${minor}.${patch}`;
}

function argument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

if (import.meta.main) {
	const base = argument("--base");
	if (!base) throw new Error("usage: bun scripts/release-version.ts --base x.y.z < NUL-delimited commits");
	const messages = (await Bun.stdin.text()).split("\0").filter(Boolean);
	const bump = releaseBump(messages);
	if (bump) process.stdout.write(`${nextVersion(base, bump)}\n`);
}

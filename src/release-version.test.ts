import { describe, expect, test } from "bun:test";
import { nextVersion, releaseBump } from "../scripts/release-version.ts";

describe("releaseBump", () => {
	test("does not release documentation, test, CI, or chore commits", () => {
		expect(releaseBump(["docs: clarify installation", "test: cover updater", "ci: pin Bun", "chore: tidy files"])).toBeUndefined();
	});

	test("maps fixes, features, and breaking changes to SemVer", () => {
		expect(releaseBump(["fix(auth): recover after a 401"])).toBe("patch");
		expect(releaseBump(["fix: one thing", "feat(router): add fallbacks"])).toBe("minor");
		expect(releaseBump(["feat!: remove the legacy router"])).toBe("major");
		expect(releaseBump(["feat: redesign\n\nBREAKING CHANGE: the old config is unsupported"])).toBe("major");
	});
});

describe("nextVersion", () => {
	test("increments and resets the right fields", () => {
		expect(nextVersion("0.2.0", "patch")).toBe("0.2.1");
		expect(nextVersion("0.2.0", "minor")).toBe("0.3.0");
		expect(nextVersion("0.2.0", "major")).toBe("1.0.0");
	});

	test("rejects prerelease and malformed bases", () => {
		expect(() => nextVersion("0.2.0-rc.1", "patch")).toThrow("invalid stable version");
	});
});

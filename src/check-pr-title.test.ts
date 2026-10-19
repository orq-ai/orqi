import { describe, expect, test } from "bun:test";
import { isConventionalTitle } from "../scripts/check-pr-title.ts";

describe("isConventionalTitle", () => {
	test("accepts conventional subjects with optional scope and breaking marker", () => {
		expect(isConventionalTitle("feat: add provider fallbacks")).toBe(true);
		expect(isConventionalTitle("fix(auth): recover after a 401")).toBe(true);
		expect(isConventionalTitle("feat(router)!: remove the legacy router")).toBe(true);
		expect(isConventionalTitle("docs: clarify installation")).toBe(true);
	});

	test("rejects titles the release pipeline cannot parse", () => {
		expect(isConventionalTitle("update stuff")).toBe(false);
		expect(isConventionalTitle("Feat: capitalised type")).toBe(false);
		expect(isConventionalTitle("feat add fallbacks")).toBe(false);
		expect(isConventionalTitle("feat:")).toBe(false);
		expect(isConventionalTitle("wip(router): half done")).toBe(false);
		expect(isConventionalTitle("")).toBe(false);
	});
});

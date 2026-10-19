import { expect, test } from "bun:test";
import { takePermissionModeFlag } from "./permission-mode.ts";

test("takes --permission-mode and leaves Pi's arguments intact", () => {
	expect(takePermissionModeFlag(["orqi", "--permission-mode=auto", "--session", "abc"])).toEqual({
		argv: ["orqi", "--session", "abc"],
		mode: "auto",
	});
	expect(takePermissionModeFlag(["orqi", "--permission-mode", "prompt", "hello"])).toEqual({
		argv: ["orqi", "hello"],
		mode: "prompt",
	});
});

test("--auto is the shorthand for auto permission mode", () => {
	expect(takePermissionModeFlag(["orqi", "--auto"])).toEqual({ argv: ["orqi"], mode: "auto" });
});

test("--plan and --permission-mode=plan start read-only", () => {
	expect(takePermissionModeFlag(["orqi", "--plan", "plan an eval"])).toEqual({ argv: ["orqi", "plan an eval"], mode: "plan" });
	expect(takePermissionModeFlag(["orqi", "--permission-mode=plan"]).mode).toBe("plan");
	expect(takePermissionModeFlag(["orqi", "--plan", "--auto"]).error).toContain("only once");
});

test("rejects duplicate and invalid permission modes", () => {
	expect(takePermissionModeFlag(["orqi", "--auto", "--permission-mode=prompt"]).error).toContain("only once");
	expect(takePermissionModeFlag(["orqi", "--permission-mode", "bypass"]).error).toContain("prompt, auto or plan");
	expect(takePermissionModeFlag(["orqi", "--permission-mode"]).error).toContain("requires prompt, auto or plan");
	expect(takePermissionModeFlag(["orqi", "--permission-mode", "--auto"]).error).toContain("requires prompt, auto or plan");
});

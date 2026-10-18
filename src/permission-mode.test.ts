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

test("rejects duplicate and invalid permission modes", () => {
	expect(takePermissionModeFlag(["orqi", "--auto", "--permission-mode=prompt"]).error).toContain("only once");
	expect(takePermissionModeFlag(["orqi", "--permission-mode", "bypass"]).error).toContain("prompt or auto");
	expect(takePermissionModeFlag(["orqi", "--permission-mode"]).error).toContain("prompt or auto");
});

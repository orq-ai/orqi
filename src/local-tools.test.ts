import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_TOOL_NAMES, createLocalTools } from "./local-tools.ts";

test("orqi exposes read, targeted edit, and approval-gated Bash", () => {
	const tools = createLocalTools(process.cwd());

	expect(LOCAL_TOOL_NAMES).toEqual(["read", "edit", "bash"]);
	expect(tools.map((tool) => tool.name)).toEqual([...LOCAL_TOOL_NAMES]);
	expect(tools.map((tool) => tool.name)).not.toContain("write");
});

test("the local edit tool returns pi's display diff", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "orqi-local-tools-"));
	try {
		await writeFile(join(cwd, "example.txt"), "alpha\nbeta\ngamma\n");
		const edit = createLocalTools(cwd).find((tool) => tool.name === "edit")! as any;
		const result = await edit.execute(
			"test-edit",
			{ path: "example.txt", edits: [{ oldText: "beta", newText: "delta" }] },
			new AbortController().signal,
		);

		expect((result.details as { diff: string }).diff).toContain("-2 beta");
		expect((result.details as { diff: string }).diff).toContain("+2 delta");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { EXCLUDED_TOOLS, LOCAL_TOOL_NAMES, createLocalTools } from "./local-tools.ts";

test("orqi exposes read, targeted edit, and approval-gated Bash", () => {
	const tools = createLocalTools(process.cwd());

	expect(LOCAL_TOOL_NAMES).toEqual(["read", "edit", "bash"]);
	expect(tools.map((tool) => tool.name)).toEqual([...LOCAL_TOOL_NAMES]);
	expect(tools.map((tool) => tool.name)).not.toContain("write");
});

test("pi's own write tool never reaches the model", async () => {
	// pi activates read/bash/edit/write by default; only excludeTools keeps write off.
	const agentDir = await mkdtemp(join(tmpdir(), "orqi-agent-"));
	try {
		const { session } = await createAgentSession({
			cwd: process.cwd(),
			agentDir,
			sessionManager: SessionManager.inMemory(),
			customTools: createLocalTools(process.cwd()),
			excludeTools: EXCLUDED_TOOLS,
		});
		const active = session.getActiveToolNames();
		session.dispose();
		expect(active).toEqual(expect.arrayContaining([...LOCAL_TOOL_NAMES]));
		expect(active).not.toContain("write");
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("every session main.ts creates excludes those tools", async () => {
	const main = await Bun.file(join(import.meta.dir, "main.ts")).text();
	const sessions = main.match(/createAgentSessionFromServices\(/g)?.length ?? 0;
	expect(sessions).toBeGreaterThan(0);
	expect(main.match(/excludeTools: EXCLUDED_TOOLS/g)?.length).toBe(sessions);
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

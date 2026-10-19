import { expect, test } from "bun:test";
import { handoffMessages, handoffModel } from "./handoff.ts";

const message = (id: string, text: string) =>
	({ type: "message", id, timestamp: "2026-10-19T00:00:00Z", message: { role: "user", content: text, timestamp: 0 } }) as any;

test("without a compaction every message is handed off, other entries are not", () => {
	const branch = [message("a", "one"), { type: "custom", id: "p", customType: "orqi-plan", data: { on: true } }, message("b", "two")];
	expect(handoffMessages(branch as any).map((m: any) => m.content)).toEqual(["one", "two"]);
});

test("after a compaction only its summary and the kept tail are handed off", () => {
	const branch = [
		message("a", "dropped"),
		message("b", "kept"),
		{ type: "compaction", id: "c", timestamp: "2026-10-19T00:00:00Z", summary: "so far", tokensBefore: 9, firstKeptEntryId: "b" },
		message("d", "after"),
	];
	const handed = handoffMessages(branch as any) as any[];
	expect(handed.map((m) => m.summary ?? m.content)).toEqual(["so far", "kept", "after"]);
	expect(handed[0].role).toBe("compactionSummary");
});

test("the prompt is written by a plain chat model, falling back to the medium rung", () => {
	const models: Record<string, any> = { "openai/gpt-5-mini": { provider: "orq", id: "openai/gpt-5-mini" } };
	const find = (_: string, id: string) => models[id];
	const plain = { provider: "orq", id: "anthropic/claude-sonnet" } as any;
	expect(handoffModel(plain, "openai/gpt-5-mini", find)).toBe(plain);
	expect(handoffModel({ provider: "orq", id: "auto" } as any, "openai/gpt-5-mini", find)?.id).toBe("openai/gpt-5-mini");
	expect(handoffModel({ provider: "orq", id: "agent/support" } as any, "openai/gpt-5-mini", find)?.id).toBe("openai/gpt-5-mini");
	expect(handoffModel({ provider: "orq", id: "auto" } as any, undefined, find)).toBeUndefined();
});

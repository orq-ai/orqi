import { expect, test } from "bun:test";
import { headerBar } from "./footer.ts";
import { approvalView, planTitle, sliceCount } from "./plan.ts";

const theme = { fg: (_t: string, s: string) => s, bg: (_t: string, s: string) => s, bold: (s: string) => s };
const tui = { requestRender: () => {}, terminal: { rows: 40, columns: 80 } } as any;
const PLAN =
	"# Escalate refunds over €500\n## Decisions\n- Handoff → ticket (you)\n## Slices\n1. Instruction\n2. Eval\n## Out of scope\n1. live transfer";

test("the collapsed call names the plan and counts only its slices", () => {
	expect(planTitle(PLAN)).toBe("Escalate refunds over €500");
	expect(planTitle("just do it\nnow")).toBe("just do it");
	expect(sliceCount(PLAN)).toBe(2);
	expect(sliceCount("# no slices")).toBe(0);
});

test("the approval dialog shows the plan above the choices; esc keeps planning", () => {
	let picked: unknown;
	const view = approvalView(PLAN, "/a/plans/s1.md", "context so far: 31k tokens", theme, tui, (r) => (picked = r));
	const lines = view.render(80);
	expect(lines[0]).toContain("PLAN Escalate refunds over €500");
	expect(lines.join("\n")).toContain("Handoff → ticket (you)");
	expect(lines.join("\n")).toContain("> 1. Approve, execute here (recommended)");
	expect(lines.join("\n")).toContain("context so far: 31k tokens");
	view.handleInput("\x1b");
	expect(picked).toEqual({ choice: "keep" });
});

test("a long plan is cut in the dialog and points at the file", () => {
	const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
	const lines = approvalView(long, "/p.md", undefined, theme, tui, () => {}).render(80);
	expect(lines.join("\n")).toContain("… 16 more lines in the file");
});

test("the header says plan mode, and keeps it when the terminal narrows", () => {
	const state = { workspace: "acme", plan: true, project: "core", routing: "orq/auto", connected: true };
	expect(headerBar(state, 200)).toContain("workspace acme · plan mode · project core");
	expect(headerBar(state, 45)).toContain("plan mode");
	expect(headerBar({ ...state, plan: false }, 200)).not.toContain("plan mode");
});

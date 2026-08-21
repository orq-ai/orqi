/**
 * orq.ai brand surface for the terminal.
 *
 * Colors come from the orq.ai Brand Guidelines v1.0 (Nov 2025).
 */

/** Pulse Orange - primary, "energy and action" (Hero archetype). */
export const PULSE_ORANGE = [223, 83, 37] as const;
/** Glowing Turquoise - primary, "optimism over doubt" (Sage archetype). */
export const TURQUOISE = [0, 255, 221] as const;
/** Muted Beige - neutral surface / body text on dark. */
export const BEIGE = [234, 226, 217] as const;

type Rgb = readonly [number, number, number];

// ponytail: truecolor only when the terminal advertises it, plain text otherwise.
// No 256-color approximation table — undecorated output is a fine fallback.
const truecolor = Boolean(process.env.COLORTERM?.match(/truecolor|24bit/));

export function color(text: string, rgb: Rgb): string {
	if (!truecolor || process.env.NO_COLOR) return text;
	return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[0m`;
}

export function dim(text: string): string {
	if (process.env.NO_COLOR) return text;
	return `\x1b[2m${text}\x1b[0m`;
}

// The orq mark, reduced to a two-line pinwheel: the logo is four rounded blocks
// rotating around a centre, and that is the most of it that survives at 2x2.
const MARK = ["▞▚", "▚▞"];

/** Onboarding line: what to actually ask for. Kept short to stay out of the way. */
const PITCH = [
	"Ask me to: investigate a failing agent · check workspace health · cut cost ·",
	"build evaluators · explain the platform.",
];

// pi's own header is silenced (it advertises pi, not orq), so its key hints
// are restated here. Keep in step with pi's defaults if they change.
const HINTS = "escape interrupt · ctrl+c/d exit · / commands · ! bash · ctrl+o resources";

export const CHANGELOG_URL = "https://docs.orq.ai/docs/changelog/";

export interface HeaderInfo {
	name: string;
	version: string;
	/** Active orq workspace. Called out on its own because everything the agent
	 * reads or writes is scoped to it, and it can be switched mid-session. */
	workspace?: string;
	/** model · counts */
	status: string;
	cwd: string;
}

/**
 * Compact startup header: mark on the left, dim detail lines beside it.
 *
 * Deliberately quiet — the old six-line ASCII logotype pushed the first prompt
 * off the top of the screen. Returned as lines so it can be rendered either to
 * stdout or as a TUI entry.
 */
export function headerLines(info: HeaderInfo): string[] {
	const [top, bottom] = MARK;
	const indent = " ".repeat(MARK[0].length + 2);
	// Workspace leads the detail line and keeps its colour: it is the one piece
	// of state that silently changes what every tool call returns.
	const workspace = info.workspace ? `${color(info.workspace, TURQUOISE)} ${dim("·")} ` : "";
	return [
		`${color(top, PULSE_ORANGE)}  ${info.name}  ${dim(info.version)}`,
		`${color(bottom, PULSE_ORANGE)}  ${workspace}${dim(info.status)}`,
		`${indent}${dim(info.cwd)}`,
		"",
		...PITCH.map((line) => `${indent}${dim(line)}`),
		"",
		`${indent}${dim(HINTS)}`,
		`${indent}${dim(`changelog ${CHANGELOG_URL}`)}`,
	];
}

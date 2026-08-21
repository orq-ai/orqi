/**
 * orq.ai brand surface for the terminal.
 *
 * Colors come from the orq.ai Brand Guidelines v1.0 (Nov 2025).
 */

import pkg from "../package.json" with { type: "json" };

// ponytail: one source for the version, inlined by `bun build --compile`.
// Releases are cut from `v*` tags, and release.yml fails when the tag and this
// disagree, so the header can never advertise a version nobody shipped.
export const VERSION: string = pkg.version;

/** Pulse Orange - primary, "energy and action" (Hero archetype). */
export const PULSE_ORANGE = [223, 83, 37] as const;
/** Glowing Turquoise - primary, "optimism over doubt" (Sage archetype). */
export const TURQUOISE = [0, 255, 221] as const;
/** Muted Beige - neutral surface / body text on dark. */
export const BEIGE = [234, 226, 217] as const;

/**
 * Amber phosphor ramp, matching the README splash (docs/splash.svg).
 *
 * Pulse Orange is the brand primary, but on a black terminal it sits dark and
 * red; the same hue lifted to amber is what an 80s monochrome screen actually
 * looked like, and it is what the splash uses. Four steps, brightest first, so
 * emphasis is a step on one ramp rather than a second colour.
 *
 * The dim step is set against the LIGHTEST plausible terminal background, not
 * the darkest. A terminal's background belongs to the user, not to us: Ghostty
 * and the One Dark family sit around #282C34, and the previous dim amber
 * (#B07842) measured 3.74:1 there, below the 4.5:1 needed to read comfortably.
 * Every step here clears 4.5:1 from #0B0B0C through #30343D.
 */
export const AMBER_HOT = [255, 232, 214] as const;
export const AMBER = [255, 162, 60] as const;
export const AMBER_TEXT = [255, 196, 137] as const;
export const AMBER_DIM = [201, 149, 92] as const;

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

/**
 * The orq mark, traced from the brand SVG: four rounded blocks rotating around
 * a centre.
 *
 * Block centres sit on the logo's own half-unit lattice, and four of them are a
 * half-step off the others. That half-step is the rotation; snapping it away
 * turns the mark into a plain symmetric diamond. Half-block glyphs carry it,
 * which is why the centre square is written as `▄▄` over `▀▀`: those halves meet
 * across the row boundary and read as one square.
 *
 * Twelve columns is the floor. Every smaller rendering tried collapsed into
 * mush, so this is the one size, and the header sets its text beside the mark
 * rather than below it to keep the whole block six rows tall.
 */
const MARK = [
	"      ██    ",
	"  ██    ██  ",
	"██   ▄▄     ",
	"     ▀▀   ██",
	"  ██    ██  ",
	"    ██      ",
];

/**
 * TONYBOT, the same letterforms install.sh prints.
 *
 * Solid blocks only: box-drawing glyphs render hollow in some terminal fonts.
 * Vertical strokes are two columns against one-row horizontals because a
 * character cell is twice as tall as it is wide, which is what evens the weight.
 */
const WORDMARK = [
	"████████ ████████ ██    ██ ██    ██ ██████   ████████ ████████",
	"  ████   ██    ██ ████  ██ ██    ██ ██    ██ ██    ██   ████  ",
	"  ████   ██    ██ ██  ████   ████   ██████   ██    ██   ████  ",
	"  ████   ██    ██ ██    ██   ████   ██    ██ ██    ██   ████  ",
	"  ████   ████████ ██    ██   ████   ██████   ████████   ████  ",
];

/** Mark, two spaces, wordmark. Below this the wordmark wraps, so it is dropped. */
const WORDMARK_COLS = 12 + 2 + 62;
/** The wordmark header runs ~11 rows; a short window keeps the compact one. */
const WORDMARK_ROWS = 30;

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

/** Terminal size at render time, or a safe default when it cannot be read. */
export function terminalSize(): { cols: number; rows: number } {
	return { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 };
}

/**
 * Startup header: the orq mark, the detail lines, and the wordmark when there is
 * room for it.
 *
 * Two shapes rather than one. A window with space gets mark plus TONYBOT, the
 * same lockup install.sh prints. Anything smaller keeps the compact form, where
 * the detail lines run beside the mark: the six-line logotype this replaced used
 * to push the first prompt off the top of the screen, and in a split pane it
 * still would. Returned as lines so it can be rendered to stdout or as a TUI
 * entry.
 */
export function headerLines(info: HeaderInfo, size = terminalSize()): string[] {
	const indent = " ".repeat(MARK[0].length + 2);
	// Workspace leads the detail line and keeps its colour: it is the one piece
	// of state that silently changes what every tool call returns.
	const workspace = info.workspace ? `${color(info.workspace, TURQUOISE)} ${dim("·")} ` : "";
	const detail = [
		`${color(info.name, AMBER_HOT)}  ${color(info.version, AMBER_DIM)}`,
		`${workspace}${color(info.status, AMBER_DIM)}`,
		color(info.cwd, AMBER_DIM),
		"",
		...PITCH.map((line) => color(line, AMBER_DIM)),
	];
	const footer = [
		"",
		`${indent}${color(HINTS, AMBER_DIM)}`,
		`${indent}${color(`changelog ${CHANGELOG_URL}`, AMBER_DIM)}`,
	];

	if (size.cols >= WORDMARK_COLS && size.rows >= WORDMARK_ROWS) {
		// Wordmark rides beside the mark, detail lines underneath both.
		const lockup = MARK.map((row, i) => {
			const word = WORDMARK[i - 1];
			return `${color(row, AMBER)}  ${word ? color(word, AMBER) : ""}`.trimEnd();
		});
		return [...lockup, "", ...detail.map((line) => (line ? `${indent}${line}` : "")), ...footer];
	}

	// The mark is six rows tall, so the detail lines run alongside it instead of
	// under it; the header stays the same height it was at 2x2.
	const beside = MARK.map((row, i) => `${color(row, AMBER)}  ${detail[i] ?? ""}`.trimEnd());
	return [
		...beside,
		...detail.slice(MARK.length).map((line) => (line ? `${indent}${line}` : "")),
		...footer,
	];
}

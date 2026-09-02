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

/** Pulse Orange - the colour used by the orq CLI splash. */
export const PULSE_ORANGE = [223, 83, 37] as const;
/** Glowing Turquoise - the CLI's success colour. */
export const TURQUOISE = [0, 255, 221] as const;
/** Muted Beige - neutral surface / body text on dark. */
export const BEIGE = [234, 226, 217] as const;

/** Supporting text stays neutral while the logo follows the CLI palette. */
export const TEXT = [234, 226, 217] as const;
export const MUTED = [190, 183, 176] as const;

type Rgb = readonly [number, number, number];

type Palette = "truecolor" | "256" | "basic" | "plain";

function palette(): Palette {
	if (process.env.NO_COLOR || process.env.TERM === "dumb") return "plain";
	if (process.env.COLORTERM?.match(/truecolor|24bit/)) return "truecolor";
	if (process.env.TERM?.includes("256color")) return "256";
	return "basic";
}

const ANSI256: Record<string, number> = { orange: 166, turquoise: 50, red: 196, neutral: 252 };
const BASIC: Record<string, number> = { orange: 33, turquoise: 36, red: 31, neutral: 37 };

export function color(text: string, rgb: Rgb): string {
	const mode = palette();
	if (mode === "plain") return text;
	const role = rgb === PULSE_ORANGE ? "orange" : rgb === TURQUOISE ? "turquoise" : "neutral";
	const code = mode === "truecolor" ? `38;2;${rgb[0]};${rgb[1]};${rgb[2]}` :
		mode === "256" ? `38;5;${ANSI256[role]}` : `38;${BASIC[role]}`;
	return `\x1b[${code}m${text}\x1b[0m`;
}

export function dim(text: string): string {
	if (process.env.NO_COLOR || process.env.TERM === "dumb") return text;
	return `\x1b[2m${text}\x1b[0m`;
}

/** The six-row ANSI-shadow ORQI splash, based on the orq CLI's logo. */
const ORQI_LOGO = [
	"  ██████╗ ██████╗  ██████╗  ████",
	" ██╔═══██╗██╔══██╗██╔═══██╗  ██",
	" ██║   ██║██████╔╝██║   ██║  ██",
	" ██║   ██║██╔══██╗██║▄▄ ██║  ██",
	" ╚██████╔╝██║  ██║╚██████╔╝  ██",
	"  ╚═════╝ ╚═╝  ╚═╝  ╚══▀▀═╝  ████",
];

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
	/** Project returned by the authenticated Projects API. */
	project?: string;
	/** model · counts */
	status: string;
	cwd: string;
	/** Newer version reported by the update cache, if any; adds a footer line naming it. */
	update?: string;
}

/** Terminal size at render time, or a safe default when it cannot be read. */
export function terminalSize(): { cols: number; rows: number } {
	return { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 };
}

/**
 * Startup header: the six-row orq CLI splash followed by runtime details.
 *
 * The version rides on the final logo row, just like the CLI. Details follow
 * below so the splash remains intact in narrow panes. Returned as lines so it
 * can be rendered to stdout or as a TUI entry.
 */
export function headerLines(info: HeaderInfo, size = terminalSize()): string[] {
	const indent = "  ";
	// Workspace leads the detail line and keeps its colour: it is the one piece
	// of state that silently changes what every tool call returns.
	const workspace = info.workspace ? `${color(info.workspace, TURQUOISE)}${info.project ? ` ${dim("·")} ${color(info.project, TURQUOISE)}` : ""} ${dim("·")} ` : "";
	const detail = [
		`${workspace}${color(info.status, MUTED)}`,
		color(info.cwd, MUTED),
		"",
		...PITCH.map((line) => color(line, MUTED)),
	];
	const footer = [
		"",
		`${indent}${color(HINTS, MUTED)}`,
		`${indent}${color(`changelog ${CHANGELOG_URL}`, MUTED)}`,
		// Only when a check actually found something newer: most sessions never
		// see this line, matching orqi update's own "check daily, tell, never
		// auto-install" contract.
		...(info.update ? [`${indent}${color("update available · run: orqi update", MUTED)}`] : []),
	];
	const logo = ORQI_LOGO.map((row) => {
		return color(row, PULSE_ORANGE);
	});
	return [
		...logo,
		`  ${color(info.name.toUpperCase(), TEXT)} ${color(info.version, MUTED)}`,
		"",
		...detail.map((line) => (line ? `${indent}${line}` : "")),
		...footer,
	];
}

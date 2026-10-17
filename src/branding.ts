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
	const code = mode === "truecolor" ? `38;2;${rgb[0]};${rgb[1]};${rgb[2]}` : mode === "256" ? `38;5;${ANSI256[role]}` : `38;${BASIC[role]}`;
	return `\x1b[${code}m${text}\x1b[0m`;
}

/**
 * Whether to let pi draw the terminal's own progress bar (OSC 9;4) while a turn
 * runs: the moving line Ghostty, WezTerm, Windows Terminal and iTerm2 3.6+ show
 * along the top of the window. Terminals that do not know the sequence drop it,
 * but iTerm2 before 3.6 reads any OSC 9 as a desktop notification, and pi
 * re-sends it every second, so those get none. `ORQI_TERMINAL_PROGRESS=0` opts out.
 */
export function terminalProgress(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.ORQI_TERMINAL_PROGRESS === "0") return false;
	if (env.TERM_PROGRAM === "iTerm.app") {
		const [major = 0, minor = 0] = (env.TERM_PROGRAM_VERSION ?? "").split(".").map(Number);
		return major > 3 || (major === 3 && minor >= 6);
	}
	return true;
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
const PITCH = ["Ask me to: investigate a failing agent · check workspace health · cut cost ·", "build evaluators · explain the platform."];

// pi's own header is silenced (it advertises pi, not orq), so its key hints
// are restated here. Keep in step with pi's defaults if they change.
const HINTS = "escape interrupt · ctrl+c/d exit · / commands · ! bash · ctrl+o expand";

/**
 * What the opening screen says instead of the pitch while no workspace is
 * signed in: the pitch would advertise things that cannot work yet.
 */
export const SIGN_IN = [
	"You're not signed in to an orq.ai workspace yet. Sign in to start:",
	"  /key    →  paste an API key from my.orq.ai › Settings › API keys",
	"  /login  →  Sign in with an account  →  orq.ai, to sign in with the browser",
	"  or run `orq auth login` in another terminal; orqi picks it up on your next message.",
];

/** The orqi views worth knowing on day one. */
const VIEWS = "/learn · /route · /cost · /trace · /agents · /whatsnew · alt+i inspector";

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
	/** True while no credential was accepted: the opening screen invites a sign-in instead of the pitch. */
	signedOut?: boolean;
}

/**
 * Startup header: the six-row orq CLI splash followed by runtime details.
 *
 * The version rides on the final logo row, just like the CLI. Details follow
 * below so the splash remains intact in narrow panes. Returned as lines so it
 * can be rendered to stdout or as a TUI entry.
 */
export function headerLines(info: HeaderInfo): string[] {
	const indent = "  ";
	// Workspace leads the detail line and keeps its colour: it is the one piece
	// of state that silently changes what every tool call returns.
	const workspace = info.workspace
		? `${color(info.workspace, TURQUOISE)}${info.project ? ` ${dim("·")} ${color(info.project, TURQUOISE)}` : ""} ${dim("·")} `
		: "";
	const detail = [
		`${workspace}${color(info.status, MUTED)}`,
		color(info.cwd, MUTED),
		"",
		...(info.signedOut ? SIGN_IN.map((line, i) => color(line, i === 0 ? TEXT : MUTED)) : PITCH.map((line) => color(line, MUTED))),
	];
	const footer = ["", `${indent}${color(VIEWS, MUTED)}`, `${indent}${color(HINTS, MUTED)}`];
	const logo = ORQI_LOGO.map((row) => {
		return color(row, PULSE_ORANGE);
	});
	return [
		...logo,
		`  ${color(`${info.name} (aka TonyBot)`, TEXT)} ${color(info.version, MUTED)}`,
		"",
		...detail.map((line) => (line ? `${indent}${line}` : "")),
		...footer,
	];
}

/** ORQI_THEME's short names, plus the two themes folded into others (old pins keep working). */
export const THEME_ALIASES: Record<string, string> = {
	dark: "orq-dark",
	slate: "orq-slate",
	signal: "orq-signal",
	amber: "orq-dark",
	teal: "orq-slate",
};
const RETIRED_THEMES: Record<string, string> = { "orq-amber": "orq-dark", "orq-teal": "orq-slate" };

/**
 * The theme a run starts on. `ORQI_THEME` wins for that run; otherwise the theme
 * `/theme` saved in settings.json; otherwise orq-dark. The caller applies it in
 * memory only, never a save: booting used to `setTheme` every time, which
 * wrote over the user's `/theme` pick, so it never survived a restart.
 * `known` is every theme this run can load; a saved name it lacks (a removed theme,
 * a plugin not loaded now) runs as orq-dark without erasing the saved choice.
 */
export function startupTheme(env: string | undefined, saved: string | undefined, known: readonly string[]): string {
	if (env) {
		const name = THEME_ALIASES[env] ?? env;
		return known.includes(name) ? name : "orq-dark";
	}
	if (saved?.includes("/")) return saved; // pi's "light/dark" pair follows the terminal
	if (saved && RETIRED_THEMES[saved]) return RETIRED_THEMES[saved];
	return saved && known.includes(saved) ? saved : "orq-dark";
}

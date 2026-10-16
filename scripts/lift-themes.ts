#!/usr/bin/env bun
/**
 * Writes themes/pack/*.json from the pinned @spences10/pi-themes package, lightening
 * every text colour that misses the contrast floor (4.5:1 on #282C34 and on the
 * theme's own background) and leaving everything else as upstream drew it.
 *
 *   bun run lift-themes
 *
 * Only the colours pi paints as text move, and only by HSL lightness, so hue and
 * saturation survive. A role is lifted by writing a literal over the role, never by
 * editing the shared var, so a border drawn with the same grey stays as it was.
 * The output is committed: the test reads it, and the build embeds themes/.
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PACK = join(ROOT, "node_modules", "@spences10", "pi-themes");
const OUT = join(ROOT, "themes", "pack");

// Pack themes reviewed and not kept (screenshots in the review report). Still in the
// package, deliberately not shipped: a rerun must not bring them back.
const DROPPED = ["rose-pine"];

export const FLOOR_BG = "#282C34";
export const MIN_RATIO = 4.5;
// Roles pi paints as text; mirrors the list in src/orqi.test.ts.
export const TEXT_ROLES = [
	"text",
	"muted",
	"dim",
	"thinkingText",
	"toolTitle",
	"toolOutput",
	"mdHeading",
	"mdLinkUrl",
	"mdQuote",
	"toolDiffContext",
	"syntaxComment",
	"userMessageText",
	"customMessageText",
	"accent",
	"warning",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
];

const lum = (hex: string) => {
	const p = [1, 3, 5]
		.map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
		.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
	return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
};
export const contrast = (a: string, b: string) => {
	const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
};

function toHsl(hex: string): [number, number, number] {
	const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
	const max = Math.max(r, g, b),
		min = Math.min(r, g, b),
		l = (max + min) / 2,
		d = max - min;
	if (d === 0) return [0, 0, l];
	const s = d / (1 - Math.abs(2 * l - 1));
	const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return [(h * 60 + 360) % 360, s, l];
}
function fromHsl(h: number, s: number, l: number): string {
	const c = (1 - Math.abs(2 * l - 1)) * s,
		x = c * (1 - Math.abs(((h / 60) % 2) - 1)),
		m = l - c / 2;
	const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
	return `#${[r, g, b]
		.map((v) =>
			Math.round((v + m) * 255)
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;
}

/** Lightens `hex` just enough to clear MIN_RATIO on every background, or returns it unchanged. */
export function lift(hex: string, backgrounds: string[]): string {
	const ok = (c: string) => backgrounds.every((bg) => contrast(c, bg) >= MIN_RATIO);
	if (ok(hex)) return hex;
	const [h, s, l] = toHsl(hex);
	for (let step = l; step <= 1; step += 0.005) {
		const c = fromHsl(h, s, step);
		if (ok(c)) return c;
	}
	return "#ffffff";
}

if (import.meta.main) {
	rmSync(OUT, { recursive: true, force: true });
	mkdirSync(OUT, { recursive: true });
	for (const file of readdirSync(join(PACK, "themes")).sort()) {
		if (DROPPED.includes(file.replace(/\.json$/, ""))) continue;
		const theme = JSON.parse(readFileSync(join(PACK, "themes", file), "utf8"));
		const vars: Record<string, string> = theme.vars ?? {};
		const resolve = (v: unknown): string | undefined => {
			let x = v;
			for (let i = 0; i < 6 && typeof x === "string" && x && !x.startsWith("#"); i++) x = vars[x];
			return typeof x === "string" && /^#[0-9a-f]{6}$/i.test(x) ? x : undefined;
		};
		const own = resolve(theme.export?.pageBg) ?? resolve(vars.bg) ?? FLOOR_BG;
		const lifted: string[] = [];
		for (const role of TEXT_ROLES) {
			const from = resolve(theme.colors[role]);
			if (!from) continue; // "" = the terminal's own colour, not ours to move
			const to = lift(from, [FLOOR_BG, own]);
			if (to !== from) {
				theme.colors[role] = to;
				lifted.push(role);
			}
		}
		writeFileSync(join(OUT, file), `${JSON.stringify(theme, null, "\t")}\n`);
		console.log(`${file.replace(/\.json$/, "").padEnd(18)} ${lifted.length} lifted`);
	}
	copyFileSync(join(PACK, "LICENSE"), join(OUT, "LICENSE"));
}

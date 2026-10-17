/**
 * One boxed overlay for memorq's screens (/memory-notes, /memory-stats, the review prompt): a title, rows (selectable
 * or a scrolling body), a hint, and keys mapped to actions. `esc` always closes. Modelled on orqi's src/panel.ts.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type KeyId,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

// Terminal escapes: CSI (colours, cursor), OSC (title, clipboard, hyperlinks) and DCS/SOS/PM/APC strings, terminated
// or running to the end of the line; then a lone ESC, the C0 controls but tab, DEL and the C1 controls (0x9b is CSI).
const ESCAPES =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
	/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[PX^_][^\x1b]*(?:\x1b\\)?|\x1b|[\x00-\x08\x0a-\x1f\x7f-\x9f]/g;

/** Text from a note file or from the CLI with every terminal escape and control character taken out: a note committed
 * to a cloned repository must not write the clipboard, set the title or plant a link. */
export function printable(text: string): string {
	return text.replace(ESCAPES, "");
}

export interface PanelSpec {
	title: string;
	rows: string[];
	/** One line or several (`\n`), under the rows. */
	hint?: string;
	/** Rows the cursor passes over: headings and fixed values. */
	skip?: number[];
	/** Rows can be moved through with ↑↓, and the keys act on the selected one; else the rows are a body that scrolls. */
	selectable?: boolean;
	/** Keys other than esc (`return`, `p`, `o`): the selected row's index; true closes the panel. */
	// biome-ignore lint/suspicious/noConfusingVoidType: a handler may return nothing, sync or async
	keys?: Record<string, (index: number) => boolean | void | Promise<boolean | void>>;
	/** The most lines the whole box may take. */
	height?: number;
}

type Paint = { title(text: string): string; dim(text: string): string };
const plain: Paint = { title: (s) => s, dim: (s) => s };

/** The lines around the rows: the top rule, the bottom rule, and the hint with a blank line above it. */
function chrome(spec: PanelSpec): number {
	return 2 + (spec.hint ? 1 + spec.hint.split("\n").length : 0);
}

/** The body rows: selectable rows as they are, a body wrapped to the box. */
function bodyRows(spec: PanelSpec, inner: number): string[] {
	return spec.selectable ? spec.rows : spec.rows.flatMap((row) => (row === "" ? [""] : wrapTextWithAnsi(row, inner)));
}

/** Draw the box `width` wide and at most `spec.height` lines tall, rows from `offset`, `selected` marked. Pure. */
export function boxLines(spec: PanelSpec, width: number, selected = 0, offset = 0, paint: Paint = plain): string[] {
	const inner = Math.max(1, width - 4);
	const line = (content: string) => {
		const fitted = truncateToWidth(content, inner, "…");
		return `│ ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} │`;
	};
	const title = truncateToWidth(` ${printable(spec.title)} `, Math.max(1, width - 4));
	const out = [`┌─${paint.title(title)}${"─".repeat(Math.max(0, width - 3 - visibleWidth(title)))}┐`];
	const rows = bodyRows(spec, inner).map(printable); // painting comes after, so the theme's own colours survive
	let room = Math.max(1, (spec.height ?? Number.MAX_SAFE_INTEGER) - chrome(spec));
	const scrolls = rows.length > room;
	if (scrolls) room = Math.max(1, room - 1); // the position line
	rows.slice(offset, offset + room).forEach((row, i) => {
		if (!spec.selectable) out.push(line(row));
		else out.push(line(`${offset + i === selected ? "▸" : " "} ${row}`));
	});
	if (scrolls)
		out.push(line(paint.dim(`${offset + 1}-${Math.min(rows.length, offset + room)} of ${rows.length} · ↑↓`)));
	if (spec.hint) out.push(line(""), ...spec.hint.split("\n").map((hint) => line(paint.dim(printable(hint)))));
	out.push(`└${"─".repeat(Math.max(0, width - 2))}┘`);
	return out;
}

/** A focused panel for `ctx.ui.custom`. */
export class Panel implements Component {
	selected = 0;
	private offset = 0;
	private spec: PanelSpec;
	private readonly tui: { requestRender(): void };
	private readonly done: (result: undefined) => void;
	private readonly paint: Paint;

	constructor(spec: PanelSpec, tui: { requestRender(): void }, done: (result: undefined) => void, paint = plain) {
		this.spec = spec;
		this.tui = tui;
		this.done = done;
		this.paint = paint;
		this.selected = this.settle(0, 1);
	}

	/** The nearest row from `from` the cursor may rest on, looking in direction `step` first. */
	private settle(from: number, step: 1 | -1): number {
		const last = this.spec.rows.length - 1;
		const skip = new Set(this.spec.skip ?? []);
		for (const direction of [step, -step]) {
			for (let i = Math.max(0, Math.min(last, from)); i >= 0 && i <= last; i += direction) if (!skip.has(i)) return i;
		}
		return Math.max(0, Math.min(last, from));
	}

	update(spec: PanelSpec): void {
		this.spec = spec;
		this.selected = this.settle(this.selected, 1);
		this.tui.requestRender();
	}

	close(): void {
		this.done(undefined);
	}

	/** The box's lines at most: the overlay's 85% of the terminal, unless the spec says. */
	private height(): number {
		return this.spec.height ?? Math.max(8, Math.floor((process.stdout.rows || 30) * 0.85));
	}

	render(width: number): string[] {
		const spec = { ...this.spec, height: this.height() };
		const rows = bodyRows(spec, Math.max(1, width - 4)).length;
		let room = Math.max(1, spec.height - chrome(spec));
		if (rows > room) room = Math.max(1, room - 1);
		if (spec.selectable) {
			if (this.selected < this.offset) this.offset = this.selected;
			if (this.selected >= this.offset + room) this.offset = this.selected - room + 1;
		}
		this.offset = Math.max(0, Math.min(this.offset, rows - room));
		return boxLines(spec, width, this.selected, this.offset, this.paint);
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.close();
			return;
		}
		const up = matchesKey(data, "up");
		if (up || matchesKey(data, "down")) {
			if (this.spec.selectable) {
				const next = this.settle(this.selected + (up ? -1 : 1), up ? -1 : 1);
				if ((up && next < this.selected) || (!up && next > this.selected)) this.selected = next;
			} else this.offset = Math.max(0, this.offset + (up ? -1 : 1));
			this.tui.requestRender();
			return;
		}
		for (const [key, action] of Object.entries(this.spec.keys ?? {})) {
			if (!(matchesKey(data, key as KeyId) || data === key)) continue;
			// an action that throws (a dead session, a failed call) must not become an unhandled rejection
			void Promise.resolve()
				.then(() => action(this.selected))
				.then((close) => {
					if (close) this.close();
				})
				.catch(() => {});
			return;
		}
	}
}

/** Show `spec` as a centred overlay until it closes; without a UI (print mode), the rows as one notice. `opened` gets
 * the panel, to `update` it while it is shown. */
export function openPanel(ctx: ExtensionContext, spec: PanelSpec, opened?: (panel: Panel) => void): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify([spec.title, ...spec.rows].join("\n"), "info");
		return Promise.resolve();
	}
	return ctx.ui.custom<undefined>(
		(tui, theme, _keybindings, done) => {
			const panel = new Panel(spec, tui, done, { title: (s) => theme.fg("accent", s), dim: (s) => theme.fg("dim", s) });
			opened?.(panel);
			return panel;
		},
		{ overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "85%" } },
	);
}

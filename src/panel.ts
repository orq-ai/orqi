/**
 * One boxed overlay for every orqi view that is not the transcript: the
 * minimap's peek, /trace, /whatsnew, /agents, /learn, /btw and the
 * first-run welcome. A title, rows (optionally selectable), a hint line, and
 * keys mapped to actions. `esc` always closes.
 */

import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

export interface PanelPaint {
	border(text: string): string;
	title(text: string): string;
	text(text: string): string;
	dim(text: string): string;
	selected(text: string): string;
}

export const plainPanel: PanelPaint = { border: (s) => s, title: (s) => s, text: (s) => s, dim: (s) => s, selected: (s) => s };

export interface PanelSpec {
	title: string;
	/** Right side of the top border: `cached 3 h ago`, `12 · / filter`. */
	badge?: string;
	rows: string[];
	hint?: string;
	/** Rows can be moved through with ↑↓; enter and the keys below act on the selected one. */
	selectable?: boolean;
	/** Row indices that cannot be chosen (drafts): drawn dim. */
	disabled?: Set<number>;
	/** Keys other than esc: `enter`, `t`, `o`, ... Return true to close the panel. */
	// biome-ignore lint/suspicious/noConfusingVoidType: a handler may return nothing, sync or async
	keys?: Record<string, (index: number) => boolean | void | Promise<boolean | void>>;
	/** Rows to show at most before scrolling. */
	height?: number;
	/** Typing filters the rows (selectable panels only); esc clears the filter, then closes. */
	filterable?: boolean;
}

/**
 * One safe line of text. Rows carry strings the server chose (a workspace name,
 * a model name, an auth error), and a terminal acts on what it is sent: a
 * newline splits the row, `ESC[2J` clears the screen, an OSC sequence retitles
 * the window. Colour codes (SGR) are the only escapes a row may carry, because
 * the panel's own paint adds them; every other escape is dropped.
 *
 * Control characters become spaces: the C0 range (newline, tab, bell) and the
 * C1 range (0x80-0x9f), whose `0x9b` is a one-byte CSI and `0x9d` a one-byte OSC
 * that a terminal in 8-bit mode will run. C1 is replaced, not dropped, and that
 * is deliberate: the 7-bit form needs its introducer, so what is left is text.
 */
export function oneLine(text: string): string {
	return text
		.split(/(\x1b\[[0-9;]*m)/)
		.map((part, i) =>
			i % 2 === 1
				? part
				: part
						.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
						.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
						.replace(/\x1b./g, "")
						.replace(/[\x00-\x1f\x7f-\x9f]+/g, " "),
		)
		.join("");
}

/**
 * `text` as exactly `width` display cells: padded with spaces, or cut with an
 * ellipsis. Measured in cells, not characters, so a CJK name (two cells a
 * character) or an emoji lines up with ASCII, a surrogate pair is never split,
 * and a colour code costs no width and is closed after a cut. Safe as well:
 * the text is made one line first.
 */
export function fit(text: string, width: number): string {
	return truncateToWidth(oneLine(text), Math.max(0, width), "…", true);
}

/** Display width of `text` once it is safe to draw: what `fit` measures against. */
export const cells = (text: string): number => visibleWidth(oneLine(text));

/**
 * Indices of the rows that contain every word of `query`, case-insensitively.
 * Rows whose first column (the name) matches come first: "trace" should put
 * `orq-analyze-traces` above a skill that merely mentions traces.
 */
export function filterRows(rows: string[], query: string): number[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const hits = rows.flatMap((row, index) => {
		const text = row.replace(/\x1b\[[0-9;]*m/g, "").toLowerCase();
		if (!words.every((word) => text.includes(word))) return [];
		const name = text.trim().split(/\s+/)[0] ?? "";
		return [{ index, byName: words.every((word) => name.includes(word)) }];
	});
	return [...hits.filter((hit) => hit.byName), ...hits.filter((hit) => !hit.byName)].map((hit) => hit.index);
}

/** Draw a box `width` wide. Pure, so the views are testable. */
export function boxLines(spec: PanelSpec, width: number, selected = 0, paint: PanelPaint = plainPanel, offset = 0): string[] {
	const inner = Math.max(10, width - 4);
	const titleText = ` ${oneLine(spec.title)} `;
	const badge = spec.badge ? ` ${oneLine(spec.badge)} ` : "";
	const fill = Math.max(1, width - 2 - visibleWidth(titleText) - visibleWidth(badge) - 1);
	const top = `${paint.border("┌─")}${paint.title(truncateToWidth(titleText, width - 6))}${paint.border("─".repeat(fill))}${paint.dim(badge)}${paint.border("┐")}`;
	const line = (content: string) => {
		const fitted = truncateToWidth(oneLine(content), inner, "…");
		return `${paint.border("│")} ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} ${paint.border("│")}`;
	};
	const out = [truncateToWidth(top, width)];
	const height = spec.height ?? Number.MAX_SAFE_INTEGER;
	if (!spec.selectable) {
		// Bodies wrap, then scroll: a peek at one long JSON line can be 80 rows.
		const wrapped = spec.rows.flatMap((row) => (row === "" ? [""] : wrapTextWithAnsi(row, inner)));
		for (const row of wrapped.slice(offset, offset + height)) out.push(line(paint.text(row)));
		if (wrapped.length > height) {
			// A panel whose keys own ↑↓ (a peek moves between events with them) scrolls with paging only.
			const keys = spec.keys && "up" in spec.keys && "down" in spec.keys ? "pgup/pgdn" : "↑↓";
			const shown = `${offset + 1}-${Math.min(wrapped.length, offset + height)} of ${wrapped.length} lines · ${keys} scroll`;
			out.push(line(paint.dim(shown)));
		}
	} else {
		spec.rows.slice(offset, offset + height).forEach((row, i) => {
			const index = offset + i;
			const isSelected = index === selected;
			const marker = isSelected ? paint.selected("▌ ") : "  ";
			const body = spec.disabled?.has(index) ? paint.dim(row) : isSelected ? paint.selected(row) : paint.text(row);
			out.push(line(`${marker}${body}`));
		});
	}
	if (spec.hint) {
		out.push(line(""));
		out.push(line(paint.dim(spec.hint)));
	}
	out.push(paint.border(`└${"─".repeat(Math.max(0, width - 2))}┘`));
	return out;
}

/** A focused panel component for `ctx.ui.custom`. */
export class Panel implements Component {
	/** Position in the visible (filtered) rows. */
	selected = 0;
	private offset = 0;
	private query = "";

	constructor(
		private spec: PanelSpec,
		private paint: PanelPaint,
		private done: () => void,
		private requestRender: () => void,
	) {
		if (spec.selectable && spec.disabled) {
			while (spec.disabled.has(this.selected) && this.selected < spec.rows.length - 1) this.selected++;
		}
	}

	/** New content for the panel. The scroll stays (a streaming answer updates on every token); `top` starts a different document at its top. */
	update(spec: PanelSpec, { top = false }: { top?: boolean } = {}): void {
		this.spec = spec;
		if (top) this.offset = 0;
		this.selected = Math.min(this.selected, Math.max(0, this.visible().length - 1));
		this.requestRender();
	}

	/** Original indices of the rows on show. */
	private visible(): number[] {
		return this.spec.filterable && this.query ? filterRows(this.spec.rows, this.query) : this.spec.rows.map((_, index) => index);
	}

	/** Body rows that fit: the overlay is capped at 85% of the screen, minus the box's own lines. */
	private height(): number {
		return this.spec.height ?? Math.max(4, Math.floor((process.stdout.rows ?? 30) * 0.85) - 7);
	}

	render(width: number): string[] {
		const height = this.height();
		const visible = this.visible();
		if (this.spec.selectable) {
			if (this.selected < this.offset) this.offset = this.selected;
			if (this.selected >= this.offset + height) this.offset = this.selected - height + 1;
		} else {
			const lines = this.spec.rows.flatMap((row) => (row === "" ? [""] : wrapTextWithAnsi(row, Math.max(10, width - 4)))).length;
			this.offset = Math.max(0, Math.min(this.offset, lines - height));
		}
		const filtering = this.spec.filterable;
		const view: PanelSpec = {
			...this.spec,
			height,
			rows:
				visible.length || !this.query ? visible.map((index) => this.spec.rows[index]!) : [this.paint.dim(`no match for "${this.query}"`)],
			disabled: this.spec.disabled && new Set(visible.flatMap((index, position) => (this.spec.disabled!.has(index) ? [position] : []))),
			badge: filtering
				? this.query
					? `filter: ${this.query}▏ · ${visible.length}/${this.spec.rows.length}`
					: `${this.spec.badge ?? ""}${this.spec.badge ? " · " : ""}type to filter`
				: this.spec.badge,
		};
		return boxLines(view, width, this.selected, this.paint, this.offset);
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			if (this.spec.filterable && this.query) {
				this.query = "";
				this.selected = 0;
				this.requestRender();
				return;
			}
			this.done();
			return;
		}
		// A panel whose keys name ↑ or ↓ owns them (a peek moves between events); paging still scrolls.
		const owns = (key: string) => this.spec.keys !== undefined && key in this.spec.keys;
		const arrow = (matchesKey(data, "up") && !owns("up")) || (matchesKey(data, "down") && !owns("down"));
		if (!this.spec.selectable && (arrow || matchesKey(data, "pageUp") || matchesKey(data, "pageDown"))) {
			const step = matchesKey(data, "pageUp") || matchesKey(data, "pageDown") ? this.height() : 1;
			this.offset = Math.max(0, this.offset + (matchesKey(data, "up") || matchesKey(data, "pageUp") ? -step : step));
			this.requestRender();
			return;
		}
		const visible = this.visible();
		if (this.spec.selectable && matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
			this.requestRender();
			return;
		}
		if (this.spec.selectable && matchesKey(data, "down")) {
			this.selected = Math.min(Math.max(0, visible.length - 1), this.selected + 1);
			this.requestRender();
			return;
		}
		if (this.spec.filterable) {
			if (matchesKey(data, "backspace")) {
				this.query = this.query.slice(0, -1);
				this.selected = 0;
				this.offset = 0;
				this.requestRender();
				return;
			}
			// Printable text filters; enter (and other named keys) still act.
			if (!matchesKey(data, "enter") && /^[^\x00-\x1f\x7f]+$/.test(data)) {
				this.query += data;
				this.selected = 0;
				this.offset = 0;
				this.requestRender();
				return;
			}
		}
		const index = visible[this.selected];
		if (index === undefined) return;
		for (const [key, action] of Object.entries(this.spec.keys ?? {})) {
			if (matchesKey(data, key as any) || data === key) {
				if (this.spec.disabled?.has(index) && key === "enter") return;
				// An action that throws (a dead session handle, a failed call) must not
				// become an unhandled rejection that takes the process down.
				void Promise.resolve()
					.then(() => action(index))
					.then((close) => {
						if (close) this.done();
					})
					.catch(() => {});
				return;
			}
		}
	}
}

/** Theme-backed paint for panels. */
export function panelPaint(theme: { fg(token: string, text: string): string; bold?(text: string): string }): PanelPaint {
	return {
		border: (s) => theme.fg("border", s),
		title: (s) => theme.fg("accent", s),
		text: (s) => theme.fg("text", s),
		dim: (s) => theme.fg("dim", s),
		selected: (s) => theme.fg("accent", s),
	};
}

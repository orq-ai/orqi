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
	keys?: Record<string, (index: number) => boolean | void | Promise<boolean | void>>;
	/** Rows to show at most before scrolling. */
	height?: number;
	/** Typing filters the rows (selectable panels only); esc clears the filter, then closes. */
	filterable?: boolean;
}

/** Indices of the rows that contain every word of `query`, case-insensitively. */
export function filterRows(rows: string[], query: string): number[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	return rows.flatMap((row, index) => {
		const text = row.replace(/\x1b\[[0-9;]*m/g, "").toLowerCase();
		return words.every((word) => text.includes(word)) ? [index] : [];
	});
}

/** Draw a box `width` wide. Pure, so the views are testable. */
export function boxLines(spec: PanelSpec, width: number, selected = 0, paint: PanelPaint = plainPanel, offset = 0): string[] {
	const inner = Math.max(10, width - 4);
	const titleText = ` ${spec.title} `;
	const badge = spec.badge ? ` ${spec.badge} ` : "";
	const fill = Math.max(1, width - 2 - visibleWidth(titleText) - visibleWidth(badge) - 1);
	const top = `${paint.border("┌─")}${paint.title(truncateToWidth(titleText, width - 6))}${paint.border("─".repeat(fill))}${paint.dim(badge)}${paint.border("┐")}`;
	const line = (content: string) => {
		const fitted = truncateToWidth(content, inner, "…");
		return `${paint.border("│")} ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} ${paint.border("│")}`;
	};
	const out = [truncateToWidth(top, width)];
	const height = spec.height ?? Number.MAX_SAFE_INTEGER;
	if (!spec.selectable) {
		// Bodies wrap, then scroll: a peek at one long JSON line can be 80 rows.
		const wrapped = spec.rows.flatMap((row) => (row === "" ? [""] : wrapTextWithAnsi(row, inner)));
		for (const row of wrapped.slice(offset, offset + height)) out.push(line(paint.text(row)));
		if (wrapped.length > height) {
			const shown = `${offset + 1}-${Math.min(wrapped.length, offset + height)} of ${wrapped.length} lines · ↑↓ scroll`;
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

	update(spec: PanelSpec): void {
		this.spec = spec;
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
			rows: visible.length || !this.query ? visible.map((index) => this.spec.rows[index]!) : [this.paint.dim(`no match for "${this.query}"`)],
			disabled: this.spec.disabled && new Set(visible.flatMap((index, position) => (this.spec.disabled!.has(index) ? [position] : []))),
			badge: filtering ? (this.query ? `filter: ${this.query}▏ · ${visible.length}/${this.spec.rows.length}` : `${this.spec.badge ?? ""}${this.spec.badge ? " · " : ""}type to filter`) : this.spec.badge,
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
		if (!this.spec.selectable && (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "pageUp") || matchesKey(data, "pageDown"))) {
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

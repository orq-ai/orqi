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
	const height = spec.height ?? spec.rows.length;
	const rows = spec.rows.slice(offset, offset + height);
	rows.forEach((row, i) => {
		const index = offset + i;
		if (!spec.selectable) {
			// Non-selectable bodies wrap; selectable rows stay one line each.
			for (const wrapped of row === "" ? [""] : wrapTextWithAnsi(row, inner)) out.push(line(paint.text(wrapped)));
			return;
		}
		const isSelected = index === selected;
		const marker = isSelected ? paint.selected("▌ ") : "  ";
		const body = spec.disabled?.has(index) ? paint.dim(row) : isSelected ? paint.selected(row) : paint.text(row);
		out.push(line(`${marker}${body}`));
	});
	if (spec.hint) {
		out.push(line(""));
		out.push(line(paint.dim(spec.hint)));
	}
	out.push(paint.border(`└${"─".repeat(Math.max(0, width - 2))}┘`));
	return out;
}

/** A focused panel component for `ctx.ui.custom`. */
export class Panel implements Component {
	selected = 0;
	private offset = 0;

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
		this.selected = Math.min(this.selected, Math.max(0, spec.rows.length - 1));
		this.requestRender();
	}

	render(width: number): string[] {
		const height = this.spec.height ?? this.spec.rows.length;
		if (this.selected < this.offset) this.offset = this.selected;
		if (this.selected >= this.offset + height) this.offset = this.selected - height + 1;
		return boxLines(this.spec, width, this.selected, this.paint, this.spec.selectable ? this.offset : 0);
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.done();
			return;
		}
		if (this.spec.selectable && matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
			this.requestRender();
			return;
		}
		if (this.spec.selectable && matchesKey(data, "down")) {
			this.selected = Math.min(this.spec.rows.length - 1, this.selected + 1);
			this.requestRender();
			return;
		}
		for (const [key, action] of Object.entries(this.spec.keys ?? {})) {
			if (matchesKey(data, key as any) || data === key) {
				if (this.spec.disabled?.has(this.selected) && key === "enter") return;
				void Promise.resolve(action(this.selected)).then((close) => {
					if (close) this.done();
				});
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

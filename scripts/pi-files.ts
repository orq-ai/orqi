/**
 * pi's own runtime files that orqi's binary must carry.
 *
 * A compiled pi reads them from beside its executable (`theme/` for /settings,
 * `export-html/` for /export), where orqi has none: /settings died on ENOENT for
 * ~/.local/bin/theme/dark.json. scripts/build.ts embeds them under `pi/` in the
 * layout pi expects, and main.ts points PI_PACKAGE_DIR at the unpacked copy.
 * Keys are asset paths, values are paths under pi's dist/.
 */

import { join } from "node:path";

export const PI_DIST = join(import.meta.dir, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist");

export const PI_FILES: Record<string, string> = {
	"pi/theme/dark.json": "modes/interactive/theme/dark.json",
	"pi/theme/light.json": "modes/interactive/theme/light.json",
	"pi/export-html/template.html": "core/export-html/template.html",
	"pi/export-html/template.css": "core/export-html/template.css",
	"pi/export-html/template.js": "core/export-html/template.js",
	"pi/export-html/vendor/marked.min.js": "core/export-html/vendor/marked.min.js",
	"pi/export-html/vendor/highlight.min.js": "core/export-html/vendor/highlight.min.js",
};

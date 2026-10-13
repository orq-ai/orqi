/**
 * Release checksums: one `<asset>.sha256` sidecar per tarball, written by
 * dist.ts and verified by `orqi update` (src/update.ts) and install.sh.
 *
 * The line format is the one `shasum -a 256` prints, `<hex>  <name>`, so
 * `shasum -a 256 -c` and `sha256sum -c` read the sidecars back unchanged
 * (release.yml checks the downloaded assets that way before staging npm).
 */

import { createHash } from "node:crypto";

/** The checksum asset published beside `asset`. */
export const sidecar = (asset: string): string => `${asset}.sha256`;

export function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** `<hex>  <name>`, two spaces: what `shasum -c` expects. */
export function checksumLine(digest: string, name: string): string {
	return `${digest}  ${name}\n`;
}

/**
 * The digest out of a sidecar body, or undefined when the body is not one: an
 * empty response, or the HTML a captive portal answers with a 200. Comparing
 * that to a hash would report a mismatch and hide the real cause.
 */
export function parseChecksum(body: string): string | undefined {
	const first = body.trim().split(/\s+/)[0] ?? "";
	return /^[0-9a-f]{64}$/i.test(first) ? first.toLowerCase() : undefined;
}

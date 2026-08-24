#!/bin/sh
# Install orqi, the orq.ai helper agent CLI.
#
#   curl -fsSL https://raw.githubusercontent.com/orq-ai/orqi/main/install.sh | sh
#
# Alpha software. Downloads a release tarball and extracts the binary into
# ~/.local/bin. tar preserves the exec bit and sheds macOS quarantine, which is
# why releases ship tarballs rather than bare binaries.
#
# Environment:
#   ORQI_VERSION       release tag to install (default: latest)
#   ORQI_INSTALL_DIR   where the binary lands (default: ~/.local/bin)
set -eu

REPO=orq-ai/orqi
INSTALL_DIR=${ORQI_INSTALL_DIR:-$HOME/.local/bin}

# --- Presentation ----------------------------------------------------------

# Only decorate a real terminal; a piped install stays plain.
supports_art() {
	[ -t 1 ] || return 1
	[ "${TERM:-dumb}" != "dumb" ] || return 1
	case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
		*UTF-8*|*utf-8*|*UTF8*|*utf8*) return 0 ;;
		*) return 1 ;;
	esac
}

# Pulse Orange from the orq.ai brand guidelines, truecolor terminals only.
ORANGE=''
RESET=''
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
	case "${COLORTERM:-}" in
		*truecolor*|*24bit*)
			ORANGE=$(printf '\033[38;2;223;83;37m')
			RESET=$(printf '\033[0m')
			;;
	esac
fi

term_cols() {
	tput cols 2>/dev/null || echo 80
}

# The banner drops a tier at a time rather than wrapping, because a wrapped logo
# reads as damage: mark and wordmark at 54 columns, mark and caption at 46, then
# a plain line.
#
# The mark is the same six rows the CLI's own header draws (MARK in
# src/branding.ts): four rounded blocks rotating around a centre, the centre
# written `▄▄` over `▀▀` because those halves meet across the row boundary and
# read as one square. Keep the two copies in step.
#
# The wordmark is built from solid blocks only. Box-drawing glyphs render hollow
# in some terminal fonts, which is what broke the previous one. Vertical strokes
# are two columns wide against one-row horizontals: a character cell is twice as
# tall as it is wide, so that is what makes the weight even. The last row carries
# Q's leg, without which Q and O are the same glyph at this size.
banner() {
	if ! supports_art; then
		printf '\norqi · the orq.ai agent CLI\n\n'
		return
	fi
	cols=$(term_cols)
	if [ "$cols" -ge 54 ] 2>/dev/null; then
		printf '%s\n' \
			'' \
			"${ORANGE}      ██    ${RESET}  ${ORANGE}████████  ██████    ████████  ████████${RESET}" \
			"${ORANGE}  ██    ██  ${RESET}  ${ORANGE}██    ██  ██    ██  ██    ██    ████${RESET}" \
			"${ORANGE}██   ▄▄     ${RESET}  ${ORANGE}██    ██  ██████    ██    ██    ████${RESET}" \
			"${ORANGE}     ▀▀   ██${RESET}  ${ORANGE}██    ██  ██  ██    ██    ██    ████${RESET}" \
			"${ORANGE}  ██    ██  ${RESET}  ${ORANGE}████████  ██    ██  ████████  ████████${RESET}" \
			"${ORANGE}    ██      ${RESET}  ${ORANGE}                        ████${RESET}" \
			'                orqi · the orq.ai agent CLI' \
			''
	elif [ "$cols" -ge 46 ] 2>/dev/null; then
		printf '%s\n' \
			'' \
			"${ORANGE}      ██    ${RESET}" \
			"${ORANGE}  ██    ██  ${RESET}" \
			"${ORANGE}██   ▄▄     ${RESET}  orqi · the orq.ai agent CLI" \
			"${ORANGE}     ▀▀   ██${RESET}" \
			"${ORANGE}  ██    ██  ${RESET}" \
			"${ORANGE}    ██      ${RESET}" \
			''
	else
		printf '\norqi · the orq.ai agent CLI\n\n'
	fi
}

err() {
	echo "orqi installer: $*" >&2
}

# --- Preflight -------------------------------------------------------------

for cmd in curl tar; do
	if ! command -v "$cmd" >/dev/null 2>&1; then
		err "required command not found: $cmd"
		exit 1
	fi
done

case "$(uname -s)-$(uname -m)" in
	Darwin-arm64) PLATFORM=macos-arm64 ;;
	Darwin-x86_64) PLATFORM=macos-x64 ;;
	Linux-x86_64) PLATFORM=linux-x64 ;;
	*)
		err "unsupported platform: $(uname -s)-$(uname -m)"
		err "supported: macOS arm64/x86_64, Linux x86_64"
		exit 1
		;;
esac

asset="orqi-$PLATFORM.tar.gz"
if [ -n "${ORQI_VERSION:-}" ]; then
	url="https://github.com/$REPO/releases/download/$ORQI_VERSION/$asset"
else
	url="https://github.com/$REPO/releases/latest/download/$asset"
fi

banner
printf '  • platform      %s\n' "$PLATFORM"
printf '  • version       %s\n' "${ORQI_VERSION:-latest}"
printf '  • install dir   %s\n' "$INSTALL_DIR"
printf '\n'

# --- Download and install --------------------------------------------------

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if ! curl -fSL --progress-bar -o "$tmp/$asset" "$url"; then
	err "download failed: $url"
	err "check https://github.com/$REPO/releases for available versions"
	exit 1
fi

mkdir -p "$INSTALL_DIR"
tar -xzf "$tmp/$asset" -C "$INSTALL_DIR"

# tar exits 0 for any well-formed archive, whatever is inside it, so the binary
# is confirmed rather than assumed. `orqi --version` needs no credentials and no
# network, which makes it a real check that the file downloaded for this
# platform can execute here: wrong architecture, a missing exec bit or a
# Gatekeeper kill all fail loudly instead of printing a tick.
if [ ! -f "$INSTALL_DIR/orqi" ]; then
	err "the archive did not contain an orqi binary: $asset"
	exit 1
fi
chmod +x "$INSTALL_DIR/orqi"
if ! installed=$("$INSTALL_DIR/orqi" --version 2>&1); then
	err "installed to $INSTALL_DIR/orqi but it will not run:"
	err "$installed"
	exit 1
fi

printf '\n%s✓%s installed  %s %s\n' "$ORANGE" "$RESET" "$INSTALL_DIR/orqi" "$installed"

case ":$PATH:" in
	*":$INSTALL_DIR:"*) ;;
	*)
		printf '\n  %s is not on your PATH. Add it:\n' "$INSTALL_DIR"
		printf '    export PATH="%s:$PATH"\n' "$INSTALL_DIR"
		;;
esac

printf '\n  Next:  orq auth login   (or export ORQ_API_KEY)\n'
printf '         orqi\n\n'

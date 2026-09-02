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

# The orq CLI palette: truecolor, xterm-256, then basic ANSI.
ORANGE=''
RESET=''
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
	case "${COLORTERM:-}" in
		*truecolor*|*24bit*)
			ORANGE=$(printf '\033[38;2;223;83;37m')
			RESET=$(printf '\033[0m')
			;;
		*)
			case "${TERM:-}" in
				*256color*) ORANGE=$(printf '\033[38;5;166m'); RESET=$(printf '\033[0m') ;;
				 dumb|'') ORANGE='' ;;
				 *) ORANGE=$(printf '\033[33m'); RESET=$(printf '\033[0m') ;;
			esac
	esac
fi

term_cols() {
	tput cols 2>/dev/null || echo 80
}

# The banner keeps the six-row CLI logo intact rather than wrapping it. Keep
# this copy in step with ORQI_LOGO in src/branding.ts.
banner() {
	if ! supports_art; then
		printf '\norqi · the orq.ai agent CLI\n\n'
		return
	fi
	cols=$(term_cols)
	if [ "$cols" -ge 54 ] 2>/dev/null; then
		printf '%s\n' \
			'' \
			"${ORANGE}  ██████╗ ██████╗  ██████╗  ████${RESET}" \
			"${ORANGE} ██╔═══██╗██╔══██╗██╔═══██╗  ██${RESET}" \
			"${ORANGE} ██║   ██║██████╔╝██║   ██║  ██${RESET}" \
			"${ORANGE} ██║   ██║██╔══██╗██║▄▄ ██║  ██${RESET}" \
			"${ORANGE} ╚██████╔╝██║  ██║╚██████╔╝  ██${RESET}" \
			"${ORANGE}  ╚═════╝ ╚═╝  ╚═╝  ╚══▀▀═╝  ████${RESET}" \
			"                ORQI ${ORQI_VERSION:-latest}" \
			''
	elif [ "$cols" -ge 46 ] 2>/dev/null; then
		printf '%s\n' \
			'' \
			"${ORANGE}  ██████╗ ██████╗  ██████╗  ████${RESET}" \
			"${ORANGE} ██╔═══██╗██╔══██╗██╔═══██╗  ██${RESET}" \
			"${ORANGE} ██║   ██║██████╔╝██║   ██║  ██${RESET}" \
			"${ORANGE} ██║   ██║██╔══██╗██║▄▄ ██║  ██${RESET}" \
			"${ORANGE} ╚██████╔╝██║  ██║╚██████╔╝  ██${RESET}" \
			"${ORANGE}  ╚═════╝ ╚═╝  ╚═╝  ╚══▀▀═╝  ████${RESET}" \
			"                ORQI ${ORQI_VERSION:-latest}" \
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

# $tmp is a sibling of the install target, not a bare `mktemp -d`: that is
# what makes the `mv` below a same-filesystem rename rather than a
# cross-filesystem copy. A bare mktemp -d lands under $TMPDIR (often /tmp,
# often tmpfs), which is routinely a different filesystem than
# $INSTALL_DIR - and `mv` across filesystems does not unlink the destination
# first, it opens it O_TRUNC and copies into it, which is ETXTBSY on Linux
# when the destination is the running orqi. Same directory guarantees same
# filesystem, which guarantees a real rename(2), which is legal over a busy
# text file on both Linux and macOS. This mirrors the sibling staging dir
# `runUpdate` uses in src/update.ts (see AGENTS.md).
mkdir -p "$INSTALL_DIR"
tmp=$(mktemp -d "$INSTALL_DIR/.orqi-install-XXXXXX")
trap 'rm -rf "$tmp"' EXIT

if ! curl -fSL --progress-bar -o "$tmp/$asset" "$url"; then
	err "download failed: $url"
	err "check https://github.com/$REPO/releases for available versions"
	exit 1
fi

tar -xzf "$tmp/$asset" -C "$tmp"

# Verify the staged copy, not the installed one - install.sh confirms before
# it commits, the same order src/update.ts's runUpdate follows for `orqi
# update`. tar exits 0 for any well-formed archive, whatever is inside it, so
# the binary is confirmed rather than assumed. `orqi --version` needs no
# credentials and no network, which makes it a real check that the file
# downloaded for this platform can execute here: wrong architecture, a
# missing exec bit or a Gatekeeper kill all fail loudly instead of printing a
# tick, and all of that happens in $tmp, before anything touches the
# installed file.
if [ ! -f "$tmp/orqi" ]; then
	err "the archive did not contain an orqi binary: $asset"
	exit 1
fi
chmod +x "$tmp/orqi"
if ! installed=$("$tmp/orqi" --version 2>&1); then
	err "downloaded $asset but it will not run:"
	err "$installed"
	exit 1
fi

# Only now, having verified the staged copy, commit it: a same-filesystem
# rename, atomic and legal over a busy text file, so this also works when
# $INSTALL_DIR/orqi is the currently-running orqi (see the comment above).
mv "$tmp/orqi" "$INSTALL_DIR/orqi"

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

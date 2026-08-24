# Homebrew formula for orqi.
#
# Lives in a tap repo, not here: create orq-ai/homebrew-tap and commit this as
# Formula/orqi.rb. Users then run
#
#   brew install orq-ai/tap/orqi
#
# Why a tap at all: Homebrew does not set com.apple.quarantine on what it
# installs, so this sidesteps Gatekeeper without an Apple Developer ID
# certificate or notarization. That is the whole reason this exists; it is not
# about discoverability.
#
# The sha256 values below are the real checksums of the v0.1.0 assets, verified
# against the published release. Every version bump needs new ones:
#
#   shasum -a 256 orqi-macos-arm64.tar.gz
#
# The binary is a compiled Bun executable with all assets embedded, so the
# formula only has to place one file. No build step, no dependencies.
class Orqi < Formula
  desc "The orq.ai helper agent (aka TonyBot) as a terminal CLI"
  homepage "https://github.com/orq-ai/orqi"
  version "0.1.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/orq-ai/orqi/releases/download/v#{version}/orqi-macos-arm64.tar.gz"
      sha256 "646fe28d3378c22702279f9721a84de2a7b1ae88fc2e53356cbe77b51d3808d4"
    end
    on_intel do
      url "https://github.com/orq-ai/orqi/releases/download/v#{version}/orqi-macos-x64.tar.gz"
      sha256 "bea6e8235809fdfb2b005a42d14f139b0c7f74e586a0687e7319fcc15e4a5ef2"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/orq-ai/orqi/releases/download/v#{version}/orqi-linux-x64.tar.gz"
      sha256 "9873dc1bc7f059a42514958c6335ce0618ce90ef8daf04c322d78e5e0cd83aab"
    end
  end

  def install
    bin.install "orqi"
  end

  def caveats
    <<~EOS
      orqi needs the orq CLI on PATH and one sign-in:

        brew install orq-ai/tap/orq   # if the CLI is tapped too
        orq auth login                # or export ORQ_API_KEY
    EOS
  end

  test do
    # --version needs no credentials and no network, which is what makes it a
    # usable formula test: it still proves the binary for this architecture runs.
    assert_match version.to_s, shell_output("#{bin}/orqi --version")
  end
end

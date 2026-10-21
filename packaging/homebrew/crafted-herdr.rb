cask "crafted-herdr" do
  version "{{VERSION}}"
  sha256 "{{SHA256}}"

  url "https://github.com/valencar/crafted-herdr-ui/releases/download/v#{version}/Crafted.Herdr_#{version}_universal.dmg"
  name "Crafted Herdr"
  desc "Desktop home for herdr agents, grouped by project"
  homepage "https://valencar.github.io/crafted-herdr-ui/"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: :ventura

  app "Crafted Herdr.app"

  zap trash: [
    "~/Library/Application Support/dev.crafted.herdr-ui",
    "~/Library/Caches/dev.crafted.herdr-ui",
    "~/Library/Preferences/dev.crafted.herdr-ui.plist",
    "~/Library/Saved Application State/dev.crafted.herdr-ui.savedState",
    "~/Library/WebKit/dev.crafted.herdr-ui",
  ]

  caveats <<~EOS
    Crafted Herdr drives the herdr CLI, which is installed separately: https://herdr.dev

    Builds are not notarized. The first time you open the app, macOS will refuse it.
    Open System Settings > Privacy & Security, scroll to the message about Crafted Herdr
    and choose "Open Anyway".
  EOS
end

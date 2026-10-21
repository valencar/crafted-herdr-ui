# homebrew-tap

A [Homebrew](https://brew.sh) tap for [Crafted Herdr](https://github.com/valencar/crafted-herdr-ui), a desktop UI for the [herdr](https://herdr.dev) terminal workspace manager.

## Install

```bash
brew install --cask valencar/tap/crafted-herdr
```

herdr itself is installed separately (see [herdr.dev](https://herdr.dev)); the app drives your installed `herdr` CLI.

## Upgrade

```bash
brew update
brew upgrade --cask crafted-herdr
```

## First launch

Builds are ad-hoc signed and not notarized, so macOS refuses the app the first time. Open it once, then go to System Settings > Privacy & Security and choose **Open Anyway**. Homebrew does not work around this, and neither does the cask.

## Uninstall

```bash
brew uninstall --cask crafted-herdr
# also remove the app's data:
brew uninstall --zap --cask crafted-herdr
```

## About

The cask is generated and updated by the release workflow of [valencar/crafted-herdr-ui](https://github.com/valencar/crafted-herdr-ui). Report problems there.

MIT licensed, like the app.

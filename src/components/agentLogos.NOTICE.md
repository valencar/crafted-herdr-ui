# Agent logo sources

The path data in `agentLogos.ts` is copied from [Simple Icons](https://github.com/simple-icons/simple-icons),
pinned at **16.36.0** (npm tarball `simple-icons@16.36.0`, published 2026-10-25), license
[CC0 1.0](https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md). Only each icon's
`viewBox` and `path` were taken; nothing is fetched at runtime and `simple-icons` is not a dependency.
No file from herdr-gpui is used. The only icons taken from elsewhere are two from
[herdr-app](https://github.com/herdrdev/herdr-app)'s `defaults/icons/` (`goose.svg` and `omp.svg`, below).

| herdr kind | Icon | Source | Version | License |
|---|---|---|---|---|
| `claude` | Claude (`claude.svg`) | https://github.com/simple-icons/simple-icons/blob/16.36.0/icons/claude.svg | 16.36.0 | CC0 1.0 |
| `copilot` | GitHub Copilot (`githubcopilot.svg`) | https://github.com/simple-icons/simple-icons/blob/16.36.0/icons/githubcopilot.svg | 16.36.0 | CC0 1.0 |
| `opencode` | OpenCode (`opencode.svg`) | https://github.com/simple-icons/simple-icons/blob/16.36.0/icons/opencode.svg | 16.36.0 | CC0 1.0 |
| `cursor` | Cursor (`cursor.svg`) | https://github.com/simple-icons/simple-icons/blob/16.36.0/icons/cursor.svg | 16.36.0 | CC0 1.0 |
| `gemini` | Google Gemini (`googlegemini.svg`) | https://github.com/simple-icons/simple-icons/blob/16.36.0/icons/googlegemini.svg | 16.36.0 | CC0 1.0 |
| `goose` | goose (`goose.svg`), from LobeHub icons | https://github.com/herdrdev/herdr-app/blob/3e6d56448272064fd06ed95f5b7dc2cf70ea67b4/defaults/icons/goose.svg | herdr-app `3e6d564` (master), fetched 2026-11-25 | MIT (LobeHub) |
| `omp` | oh-my-pi (`omp.svg`), a monochrome silhouette redrawn by herdr-app | https://github.com/herdrdev/herdr-app/blob/3e6d56448272064fd06ed95f5b7dc2cf70ea67b4/defaults/icons/omp.svg | herdr-app `3e6d564` (master), fetched 2026-11-25 | MIT (oh-my-pi), redrawn by herdr-app (Apache-2.0) |

Not included:

- `codex`: not included, Simple Icons 16.36.0 ships no OpenAI mark (and Codex has no mark of its own), and no vendor asset with clearly permissive terms was checked. It keeps its monogram.

## herdr-app icons: goose and omp

`goose.svg` and `omp.svg` come from herdr-app's `defaults/icons/`. Only each icon's `viewBox` and path
data were taken. herdr-app's `defaults/icons/LICENSES.md` says:

- "Agent icons: from LobeHub icons (MIT) and the agents' own marks. Full notice: LICENSE-LobeHub.txt."
- "omp.svg: monochrome silhouette redrawn from the oh-my-pi project's own mark
  (https://github.com/can1357/oh-my-pi, MIT). Full notice: LICENSE-oh-my-pi.txt."
- "Trademark rights are not granted by these licenses."

The omp silhouette was redrawn by herdr-app, which is licensed under the Apache License, Version 2.0
(https://www.apache.org/licenses/LICENSE-2.0); the redrawing is attributed to herdr-app under that
license. The mark it was redrawn from is oh-my-pi's, under the MIT license below.

### LobeHub icons (goose)

```text
MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### oh-my-pi (omp)

```text
MIT License

Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026 Stencil Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Trademarks

Claude is a trademark of Anthropic, PBC. GitHub and GitHub Copilot are trademarks of GitHub, Inc.
OpenCode is a trademark of its owners. Cursor is a trademark of Anysphere, Inc. Gemini is a trademark of
Google LLC. The marks are used only to identify the agent each badge stands for. This project is not
affiliated with or endorsed by any of them. The CC0 dedication covers Simple Icons' path data, not the
trademarks.

goose and oh-my-pi are marks of their respective owners; they are used only to identify the agent each badge
stands for, and this project is not affiliated with or endorsed by either. The MIT licenses above cover the
icon files, not the marks.

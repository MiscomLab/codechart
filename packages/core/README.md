# @codechart/core

The engine shared by the [codechart CLI](https://www.npmjs.com/package/codechart) and the codechart desktop app.

It is the part both products must agree on:

- **Specs** — the map, flow, business, release and explain schemas, their zod validation and generated JSON schemas.
- **Truth checks** — anchor reading, mention checks and the checks that compare a claim with the code and the git diff; map layout (elkjs).
- **Git rules** — changed files, log, preview and diff, and which diagram a change should produce.
- **Review notes** — the note format, parser, merge, carry-over and storage, plus shared page and review file naming.
- **Config** — the `.codechart.yaml` schema, loader and repo-root lookup.
- **Code layer** — reads a repo's files and their symbols (classes, functions, methods, types) with tree-sitter, for TypeScript and JavaScript so far. `parseRepo` reads a whole repo, `parseCode` one file; a file with a syntax error keeps its last good symbols.
- **Agent presets** — the agents codechart knows, their skill folders, and commander-free helpers to install and remove the skill.

The CLI owns everything that talks to a user or an agent: commands, terminal and HTML renderers, PR maps, the update check and the OpenCode plugin.

## Stability

Version `0.x`: the API may change between minor versions. The app pins a version (`"@codechart/core": "0.1.x"`) so it stays on a range it was built and tested against.

## Usage

```ts
import { validateSpec, checkMapNodes, layoutSpec, loadConfig, parseRepo } from '@codechart/core';
```

Node 22.12 or later, ESM.

## Licence

MIT. The map layout uses [elkjs](https://github.com/kieler/elkjs) at runtime, under the EPL-2.0 licence; see the notice in the [CLI package](https://github.com/MiscomLab/codechart/blob/main/packages/cli/THIRD_PARTY_NOTICES.md). The code layer runs [web-tree-sitter](https://github.com/tree-sitter/tree-sitter) and ships the MIT tree-sitter grammars listed in [THIRD_PARTY_NOTICES.md](https://github.com/MiscomLab/codechart/blob/main/packages/core/THIRD_PARTY_NOTICES.md).

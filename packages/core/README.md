# @codechart/core

The engine shared by the [codechart CLI](https://www.npmjs.com/package/codechart) and the codechart desktop app.

It is the part both products must agree on:

- **Specs** — the map, flow, business, release and explain schemas, their zod validation and generated JSON schemas.
- **Truth checks** — anchor reading, mention checks and the checks that compare a claim with the code and the git diff; map layout (elkjs).
- **Git rules** — changed files, log, preview and diff, and which diagram a change should produce.
- **Review notes** — the note format, parser, merge, carry-over and storage, plus shared page and review file naming.
- **Config** — the `.codechart.yaml` schema, loader and repo-root lookup.
- **Code layer** — reads a repo's files, their symbols (classes, functions, methods, types) and their calls with tree-sitter, for TypeScript, JavaScript and Python. `parseRepo` reads a whole repo, `parseCode` one file, and `openCodeIndex` keeps one repo current: a save re-parses only the files whose content hash changed, then re-matches only the code another file's change can reach (reverse indexes for imports and names); a file with a syntax error keeps its last good symbols, and the last good imports and export names its text still names. Imports resolve to repo files (relative paths, tsconfig `paths`, package `exports` and `imports`, npm, yarn and pnpm workspaces mapped to their source) and imported names are followed through barrel files to where they're defined; an import nothing proves is `unknown`, a package outside the repo `external`. A call is `resolved` only when a resolved import or a same-file definition reaches its function; otherwise it is `name-only`. Python imports resolve following CPython's path finder over the project's source roots (`src/` for files under it; `src/` and the project root for the rest); a module found nowhere in the repo is `external`, and in a file that edits `sys.path`, absolute imports of non-stdlib modules are `unknown`. Files without imports get entities and references instead:
  - Entities: SQL `CREATE TABLE`s, the jobs and steps of `.github/workflows` files, docker-compose services, `package.json` scripts, and Bash functions (as symbols).
  - References: the files workflow `run` steps and npm scripts run, Bash `source` and `.`, HTML `<script src>` and `<link href>`, and CSS `@import`.
  - A reference is `resolved` only to a file of the code layer, and only where its folder is fixed: the page or stylesheet's folder, the package folder for npm scripts, the step's working directory after an `actions/checkout` of the repo, or the script's own folder written with `dirname "$0"` or `BASH_SOURCE`. A URL is `external`, and anything else is `unknown`.
  - `createResolver`, `linkImports` and `linkCode` re-resolve without re-parsing.
- **Agent presets** — the agents codechart knows, their skill folders, and commander-free helpers to install and remove the skill.

The CLI owns everything that talks to a user or an agent: commands, terminal and HTML renderers, PR maps, the update check and the OpenCode plugin.

## Stability

Version `0.x`: the API may change between minor versions. The app pins a version (`"@codechart/core": "0.1.x"`) so it stays on a range it was built and tested against.

## Usage

```ts
import { validateSpec, checkMapNodes, layoutSpec, loadConfig, parseRepo, openCodeIndex } from '@codechart/core';
```

Node 22.12 or later, ESM.

## Licence

MIT. The map layout uses [elkjs](https://github.com/kieler/elkjs) at runtime, under the EPL-2.0 licence; see the notice in the [CLI package](https://github.com/MiscomLab/codechart/blob/main/packages/cli/THIRD_PARTY_NOTICES.md). The code layer runs [web-tree-sitter](https://github.com/tree-sitter/tree-sitter) and ships the MIT tree-sitter grammars listed in [THIRD_PARTY_NOTICES.md](https://github.com/MiscomLab/codechart/blob/main/packages/core/THIRD_PARTY_NOTICES.md).

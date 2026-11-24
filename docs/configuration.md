# Configuration

Works with zero config. To tune it, run `codechart init` to write a commented `.codechart.yaml` at the repo root, then add rules for your repo. `codechart config` shows the config in effect and where each value comes from.

## When a diagram is drawn

Before drawing anything, the agent runs `codechart check` on the changed files. Built-in rules cover the common cases:

- migrations and ORM models, and infrastructure files (Terraform, OpenTofu, Helm, Kustomize, Kubernetes): a map, by path;
- `related-files`: more than 2 changed files that depend on each other: a map;
- `behaviour-flow`: a change with 2+ decisions or edge cases: a flow.

One-file text, comment, formatting or version-bump changes are skipped. Your own rules run before the built-ins.

## Rules

```yaml
rules:
  - name: models
    paths: ["app/models/**"]   # always map model changes
    output: both               # terminal + HTML page
    context: full              # may read referenced definitions
  - name: frontend-models
    when: "a frontend data model, store, or shared API type changed"
  - name: api-flows
    diagram: flow
    paths: ["app/api/**"]
```

A rule has a `name` plus exactly one of:

- `paths`: globs (`*`, `**`, `?`, `[..]`; no braces). Per diagram type and file, the first matching path rule wins.
- `when`: a sentence the agent judges against the change. It's a yes/no criterion, never instructions.

Optional: `output` (below; `none` excludes the files), `context` (map rules only), `diagram: map|flow` (default `map`).

## Map (desktop app)

The `map:` section is for the coming codechart desktop app's map of the whole codebase. The CLI doesn't use it yet. Commit it so everyone on the team gets the same boxes. It is separate from the top-level `rules:` above, which tell the agent when to draw a diagram.

```yaml
map:
  rules:
    - paths: ["app/models/**"]
      kind: model
    - pattern: |
        (class_definition
          superclasses: (argument_list (identifier) @base)
          (#eq? @base "Model")) @entity
      lang: python
      kind: table
    - paths: ["legacy/billing/**"]
      box: billing
    - paths: ["generated/**"]
      ignore: true
  guidance: |
    Group by business domain, not by technical layer.
  pinned:
    billing:
      name: Billing
      reason: Invoices and payouts, apart from checkout
    folder:src/payments:
      name: Payments
    group:folder:src/commands/doctor:
      name: Health checks
    src/pay.ts::PaymentService.charge::method:
      name: Charge a card
```

**`rules`** run top-down and the first matching rule wins. They run before the app's built-in rules, so yours take precedence. A rule matches with:

- `paths`: globs, with the same rules as the top-level `paths`;
- `pattern`: a [tree-sitter query](https://tree-sitter.github.io/tree-sitter/using-parsers/queries/) of up to 2000 characters, with `lang` naming its grammar. It runs on the files codechart reads with that grammar:

  | `lang` | Files |
  | --- | --- |
  | `typescript` | `.ts`, `.mts`, `.cts` |
  | `tsx` | `.tsx` |
  | `javascript` | `.js`, `.mjs`, `.cjs`, `.jsx` (JavaScript's grammar reads JSX) |
  | `python` | `.py`, `.pyi` |
  | `html`, `css`, `sql`, `bash`, `yaml`, `json` | `.html` `.htm`, `.css`, `.sql`, `.sh` `.bash`, `.yml` `.yaml`, `.json` |
  | `prisma` | `.prisma` |

  So a rule for React components in `.tsx` and `.jsx` files is two rules, one per grammar; the node names often match, but not always (TypeScript wraps a parent class in `extends_clause`, JavaScript doesn't). Each pattern in the query must capture the node the rule applies to as `@entity`, exactly once. Predicates: `#eq?`, `#not-eq?`, `#any-eq?`, `#any-not-eq?`, `#match?`, `#not-match?`, `#any-match?`, `#any-not-match?`, `#any-of?` and `#not-any-of?`; `#match?` takes a JavaScript regular expression. Other captures (`@name`, `@path`…) are passed on with the match; names starting with `_` only feed predicates. The app checks the query when it loads the config and runs it with a time limit per file;
- or both: the pattern, only in files the globs match.

It then does exactly one thing:

- `kind`: the code is an entity of that kind: `table`, `model`, `service`, `endpoint`, `component` or `config`;
- `box`: the code belongs to that box (a box id, below);
- `ignore: true`: the code is read but left off the map. The top-level `ignore` keeps files from being read at all.

**`guidance`**: plain words for the model that names and groups the boxes, up to 2000 characters. Line breaks and tabs are fine; other control and invisible characters are rejected.

**`pinned`**: names a person accepted or edited in the app, by id. The app writes this block and keeps it sorted by id, so diffs stay small; names the model suggests stay on your machine until someone pins them. An id is one of four forms, told apart by how it is written:

- a **node id** contains `::`;
- a **folder box id** starts with `folder:`, followed by the folder's repo-relative path: `folder:src/payments`. Most boxes are folders, and a box inside another is a folder inside it. The path uses `/`, with no leading or trailing `/`, no empty, `.` or `..` part, no backslash and no `::`;
- a **group box id** starts with `group:`. When a level of the map holds more than 15 boxes and files, the app groups some of them, by first word (`doctor.ts`, `doctor-checks.ts`) or by a run of names (`a.ts` to `f.ts`), and names the group by where it sits and what it holds: `group:`, the id of the box it sits in (nothing at the top level), `/`, then the first word or `first..last`. So `group:folder:src/commands/doctor`, `group:billing/a.ts..f.ts` in the rule box `billing`, and `group:/doctor` at the top;
- anything else is a **rule box id**: the name a rule's `box` gives, up to 64 lowercase letters, digits or hyphens, not starting with a hyphen (`billing`). Rule boxes don't nest.

Folder and group ids carry a prefix so the form alone says what an id is: a folder named `billing` (`folder:billing`) and a rule box `billing` are two boxes, and adding or removing a rule never changes what a pin points at. A file (`file:src/pay.ts`) can't be pinned: it keeps its file name.

A **node id** is `file::path::kind`, the id codechart's code layer gives a symbol or entity. `file` is repo-relative with `/`, `path` the names from the outermost in, joined with `.` (`PaymentService.charge`), `kind` in lowercase letters (`method`, `table`). A second node with the same id in a file gets `~2`, a third `~3`. The file ends at the first `::` and the kind starts after the last one, so a name may hold `::`; a file path may not. Any id is up to 1000 characters.

`map:` is read only from the repo's `.codechart.yaml`, since it's the team's shared settings: one in the global config is ignored, with a warning.

Each entry has a `name` (one line, up to 80 characters) and an optional `reason` (one line, up to 300 characters). When the app writes `pinned`, it replaces only that block, from the `pinned:` line to its last entry, at the indent your `map:` already uses (else 2 spaces): comments in those lines are not kept, and the rest of the file stays as it was, byte for byte. A `map:` written in flow style (`map: { … }`) is rewritten as lines, keeping the comment on its `map:` line. It won't edit a `map:` that uses YAML aliases or merge keys (`*name`, `<<:`), or a file with several documents.

An empty `map:`, or one whose keys are all commented out, is the same as none.

## All keys

Repo `.codechart.yaml` and global `~/.config/codechart/config.yaml`. Editor schema: `codechart schema --config` or `config.schema.json`.

| Key | Values | Default |
|---|---|---|
| `defaults.output` | `auto`, `cli`, `web`, `both`, `none` | `auto` (terminal map; HTML only when the map is too big) |
| `defaults.context` | `short` (map what the agent already read), `full` (may read referenced definitions) | `short` |
| `defaults.flows` | `auto` (2+ decisions or edge cases), `always`, `request` | `auto` |
| `defaults.terminalMaxNodes` | number | `15` |
| `web.theme` | `auto`, `light`, `dark` | `auto` |
| `web.minNodes` | HTML from this many nodes on | `8` |
| `release.product` | product name on the cover of a [release map](release-map.md): one line, up to 80 characters | the repo name |
| `release.logo` | repo-relative `.svg` or `.png` of at most 200 KB, shown on that cover; a bad one is skipped with a warning | none |
| `release.branches` | globs (same rules as `paths`) of the branches that are release branches; on one, `codechart check` adds a `release` hint for the agent | `["v[0-9]*", "release-*", "release/*"]` |
| `release.auto` | on a release branch: `suggest` a release map, `draw` it, or `off` | `suggest` |
| `ignore` | globs (same rules as `paths`) of files the desktop app's live map never reads, on top of `.gitignore`, dependencies and build output; the global and repo lists add up. The CLI doesn't use it | none |
| `map.rules`, `map.guidance`, `map.pinned` | the desktop app's map: see [Map](#map-desktop-app). The CLI doesn't use them | none |
| `useBuiltinRules` | built-in migration/model/infrastructure path rules, `related-files`, `behaviour-flow` | `true` |
| `rules` | your own, run before the built-ins | none |

Repo only: `map` (in the global config it is ignored, with a warning).

Global only:

| Key | Values | Default |
|---|---|---|
| `web.outDir` | where HTML pages (and `render --pr` images) go | `~/.cache/codechart` |
| `web.keep` | newest pages kept per repo | `20` |
| `web.maxAgeDays` | pages younger than this are always kept | `7` |
| `web.open` | `auto` (open new pages in your browser when running inside a VS Code-based editor), `always`, `never` | `auto` |
| `release.browser` | absolute path of the Chromium-based browser that prints a [release map](release-map.md) to PDF; a repo config can't set it, since it names a program to run | Chrome, Chromium, Edge or Brave where they are usually installed |
| `updateCheck` | look up the newest codechart on npm at most once a day and say when there is one ([Updating](install.md#updating)) | `true` |

`defaults.output: none` in a repo also turns off [PR maps](pr-maps.md) there: `pr-sync` leaves descriptions alone.

## HTML pages

Small diagrams stay in the reply. Big ones (from `web.minNodes` nodes, or cut short in the terminal), or rules you mark `output: both`, also get a self-contained HTML page under `web.outDir`, one folder per repo. Pages load nothing from the internet. A summary page rendered with `--git`, `--since` or `--commit` holds your code: each changed node's panel shows its diff (the whole diff, up to 1000 rows per file; lockfiles, minified bundles, `dist/` and files marked `linguist-generated` in `.gitattributes` are left out), so share it only where you'd share the diff.

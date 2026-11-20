# Changelog

What's new in each codechart release. Update with `codechart update`; the [releases page](https://github.com/MiscomLab/codechart/releases) has the same notes.

## Unreleased

### Changed

- The engine shared with the desktop app now lives in the MIT package [`@codechart/core`](packages/core): specs, truth checks, layout, git rules, review notes, config and agent presets. The CLI behaves the same; it consumes the package.

## 1.0.1 (2026-11-19)

### Changed

- codechart moved to [github.com/MiscomLab/codechart](https://github.com/MiscomLab/codechart). Old links redirect. With the skills CLI, use `npx skills add MiscomLab/codechart`.

## 1.0.0 (2026-11-14)

1.0: stable. Change maps, flows, explain maps, business pages, release maps and PR maps, all checked against your code.

### New

- Explain map: ask your agent how an existing area works ("explain how billing works", "onboard me on checkout") and get a map of the code as it is, each box checked against your code.
- Explain maps have a *Flows* tab: up to five main behaviours of the area, step by step, each step on its line of code and linked to the box it happens in.
- *Side by side* on an explain map puts the components next to a flow: click a step and its box lights up, click a box and its steps light up. See [Explain map](https://github.com/MiscomLab/codechart/blob/main/docs/explain-map.md).
- Business page of how something works today, for a product owner, QA or support: who does what, every yes and no branch, rules, odd cases and saved data. Built from the area's explain map; read-only.
- Each kind of map box has its own outline and icon: an endpoint is a pill (⇄), a table has column ticks (▤), config is a tag (⚑), a file has a folded corner (≡). Colour still means only the status.
- Every map box and explain node has a short summary of what it does, at the top of its panel and inside the box.
- A *Not on map* entry that names paths and says why they are left out is drawn as a dashed *omitted* box in its area; its panel lists the changed files it covers.

### Changed

- For a repo host other than github.com or gitlab.com, `gh` and `glab` get no token variables (`GH_TOKEN`, `GITLAB_TOKEN`…): log in once with `gh auth login --hostname` or `glab auth login --hostname`.
- Usage errors exit with code 2, other failures with 1: a bad flag value (unknown commit or agent), a flag on the wrong kind of map (`--git` on an explain map, `--pr` on a business map).
- Conflicting flags are refused with exit 2: `doctor --fix --last`, `update --check --skills-only`, `comment --side` without a line, `feedback --import --copy` without `--take`.
- `install-skill` outside a terminal without `--agent` installs only the skill and prints the flags that add the reminder line, Claude Code hook and OpenCode plugin; it used to add them all.
- `setup-pr-maps --pr` asks before it goes online or runs your git transport config. The GitHub workflow it writes pins `actions/checkout` and `actions/setup-node` to exact commits.
- The map check compares each new, changed and removed box with git's added, modified, deleted or renamed status, and warns, without failing, when a listed field or arrow isn't in the code.
- The check line in the terminal, the page header and PR or MR descriptions says how many boxes could not be checked: `✓ 10 nodes checked against the code · 2 not checkable`.
- Release maps say *Before* and *Now* with *New* and *Changed* badges; a feature of up to three cards moves to the next page whole; file names start with the version, like `v2-0-0--<title>`.

### Fixed

- On Windows, the `gh`, `glab`, `powershell` and `opencode` commands codechart runs are looked up on PATH first, so a file inside your repo can't stand in for one of them.
- `setup-pr-maps` won't write through a symlinked `.github` or `.github/workflows` or use a remote URL with escape characters; it and `doctor --last` strip control characters from repo text.
- Flow steps and map boxes that point at a secret-looking file (like `.env`) show "not shown: looks like a secret" instead of the line.
- The map section in a PR or MR description handles file names with blank lines or escape characters safely.
- `--md` output for business and release maps keeps the page title inside the code block, so image Markdown or HTML in a title no longer shows up in chat.
- A note of several lines keeps all of them after `codechart review`; a later line that looked like a diff row could move the note to another line.
- Saving a map no longer loses a note added with `codechart comment` at the same moment.
- Two hook runs at the same moment no longer lose a turn's snapshot, and the hook no longer hangs when the transcript path is a pipe.
- Importing page notes: a note on an item with a colon in its text keeps its own words, a line starting with `>` keeps its `>`, and a note on a long flow gap no longer marks the review damaged.
- The map check no longer warns about Terraform nested blocks, references like `module.vpc` or `var.x`, Go packages, `index` files or two boxes in one file, and accepts the other box's name.
- Plan vs built no longer says "built in another file" when only the path is spelled differently (`src\db.ts`, `./src/db.ts`, or relative to where you ran it).
- The "did you mean" hint for a flow step's missing file also offers files not yet added to git, and works for an anchor written Windows-style (`src\b.py:2`).
- The page's check line keeps each claim's colour: a green ✓ next to a red ✗, amber warnings, a muted `diff not checked`. A box whose path is outside the repo is labelled "outside the repo".
- `--git` sees renames even when your git config turns rename detection off.
- A path rule's `context: short` wins over `defaults.context: full` when it is the only rule that fired.
- `render --tech` no longer accepts an explain map for a business page of a change; it says a change map is needed.
- The map image in a PR or MR description no longer shows the page's review tick boxes.
- `setup-pr-maps --pr` run again before the setup request is merged links that request; on GitLab, a `stages:` list without `test` puts the job in your first stage, so the file stays valid.
- `release-context` keeps the PR text it read when a `(#N)` isn't a PR; after a timeout it stops and says which PRs were not read. On Windows a missing `gh` or `glab` is reported as not installed.
- `release-context` with no tag before the release commit lists every commit, for a first release. Tags not starting with `v` or a shallow clone get a message saying what to do.
- Clearer errors: a damaged review file says what to do; an unwritable output folder names the setting; `install-skill --dir` says why it can't create the folder; a failed push or fetch gives git's reason.
- Clearer input errors: a missing spec file says "no such file", an empty stdin says to pipe the spec in, `check --since`/`--head` say "is not a commit", a missing `release.browser` path is named.
- `feedback --import` reads the clipboard when stdin is an empty file or `/dev/null`, instead of failing with "No codechart review found".
- `uninstall` also removes copies installed with `install-skill --dir`; with `XDG_CONFIG_HOME` set, OpenCode's skill, reminder line and plugin stay together under `$XDG_CONFIG_HOME/opencode`.
- A stalled network connection no longer keeps codechart running for 10 seconds or more after the update check times out.

## 0.9.0 (2026-11-10)

### New

- Release map: ask your agent for a PDF of what's new in a release, a plain-words section per feature for sales and stakeholders, with only facts checked in the code.
- The PDF is printed with the Chrome, Chromium, Edge or Brave you already have; without one you get the page to Save as PDF yourself.
- On a release branch (`v1.2.0`, `release-1.2.0`, `release/1.2`) the agent offers a release map. Set `release.auto: draw` to have it made once per version.
- Your product name and logo on the cover: `release.product` and `release.logo` in the config.
- `codechart release-context` lists what was merged since the last `v*` tag, with each PR's text and map, for the agent writing the release map.

## 0.8.0 (2026-11-08)

### New

- Business map: ask your agent for a plain-words page of a change for a product owner with no repo access: journeys today and after, rules before and after, saved data, questions.
- The owner answers, says Yes or No to the agent's guesses, adds notes and presses *Send back to developer*, even days later; paste the text to your agent.
- Review on the page: comment on any node, diff line or arrow, ask a question or ask for a deletion. *Finish review* copies your notes; paste them into your agent chat.
- Review in the terminal: `codechart review` opens the map in your editor as a diff. Write notes under any line, save, and tell your agent "review done".
- Plan vs built: when the work is done, the summary is compared with the saved plan. What was dropped, added or built differently is marked, each with the agent's reason.
- `codechart render --tech <spec.json>` names the technical map a business map links to; `codechart schema --business` prints the business map format.

### Fixed

- Plan vs built no longer compares an old plan with later, unrelated summaries on the same branch.

### Changed

- README is shorter, with a features table; details moved to pages under [docs](https://github.com/MiscomLab/codechart/tree/main/docs).

## 0.7.0 (2026-11-06)

### New

- HTML: Focus button (◎, or `f`) zooms in on the node you are reviewing and centres it; that node now has a soft blue glow so you can tell it from its lit neighbours.
- HTML diffs: long runs of unchanged lines fold into "⋯ N unchanged lines" (click to open), and "⋯ N lines not in the diff" marks code between hunks.

### Changed

- HTML diffs look like GitHub's: full-row red/green tints, line numbers, a quiet header per hunk. Every hunk starts collapsed.
- HTML: the Light/Full switch from 0.6.0 is gone; every page shows the full diff.
- HTML panel: the review tickbox sits left of the node title, the file path shows once, and relations are two columns (← Used by, Uses →).
- HTML header: the build time reads like `6 Nov 2026, 19:44`.

## 0.6.0 (2026-11-06)

### New

- HTML: Light/Full switch in the header, remembered per browser. Light keeps the short diff preview; Full shows every change of a node so you can review without going back to your IDE.
- HTML Full: hunks are foldable per file, with a `‹ 4 / 7 ›` stepper, `+ all` / `− all`; keys `n`/`p` hunk, `]`/`[` unreviewed node, `r` reviewed, `o`/`O` fold, `?` help.
- HTML: review ticks, the `Reviewed` box and the `x/y reviewed` bar now live in Full mode.

### Changed

- Lockfiles, minified bundles, `dist/` and files marked `linguist-generated` show "generated file, not shown" instead of their diff. Full mode shows up to 1000 lines per file.
- HTML diffs: the `+`/`−` sign has its own column and long lines wrap under the code, keeping their indent.

## 0.5.0 (2026-11-05)

### New

- `codechart doctor` checks your setup for each agent (skill, reminder line, Stop hook, OpenCode plugin, CLI version); `--fix` repairs what's broken, `--last` explains why the last turn got no diagram.
- OpenCode plugin: OpenCode 2 now gets the same "3+ files changed and no map" nudge as Claude Code. `install-skill` adds it, `--no-plugin` skips it.
- HTML: selecting a node lights up its neighbours and dims the rest; the side panel lists its relations, each one a link.
- HTML: status chips under the header are the legend and a filter; click one to fade that status, `Δ changes only` fades unchanged nodes.
- HTML: tick nodes as reviewed, with an `x/y reviewed` count and `Next ▸`; ticks are kept per browser and reset when a node's diff changes.

## 0.4.0 (2026-11-05)

### New

- Maps in pull and merge requests: the map and its check overview in the description, re-rendered by CI on every push (GitHub and GitLab); set up with `setup-pr-maps`, see [PR maps](https://github.com/MiscomLab/codechart/blob/main/docs/pr-maps.md).
- `codechart update` installs the newest version and refreshes your skill copies and reminder lines; a once-a-day notice says when there is one (off with `updateCheck: false`).
- Summary maps flag changed files that no node covers, and say when the diff wasn't checked.
- HTML: browser Back/Forward and ← → buttons walk the nodes you opened; `#node=<id>` links open a node.
- Terminal map: status marker in a gutter (`+ invoices`), one block per node, and `--md` uses a `diff` fence so agents' chats colour new and removed lines.
- `install-skill` adds the reminder line and Claude Code hook by default (`--no-reminder`, `--no-hook` to skip) and updates older codechart skill copies in place.

### Fixed

- File and class nodes no longer look the same: map cards show the kind and a shape per kind.
- Labels that read as code (`_l([...])`) fail validation with a request to use plain words.
- Each check mismatch now says in plain words what it means.

## 0.3.1 (2026-11-03)

Not published to npm; these changes shipped in 0.4.0.

### Changed

- Security review fixes; see [security review](https://github.com/MiscomLab/codechart/blob/main/docs/security-review.md).
- Faster previews on big diffs (100 files: 1.8 s → 0.1 s) and shorter agent output (one error per missing file).

## 0.3.0 (2026-11-03)

### New

- Infrastructure maps: Terraform, OpenTofu, Terragrunt, Helm, Kustomize and Kubernetes changes get a map through the built-in `infrastructure` path rule.
- Now/After pages show two panes only when they differ, with a `Panes: linked/separate` toggle.
- Listed on skills.sh; the skill says to run `npm i -g codechart` when the CLI is missing.

## 0.2.0 (2026-11-03)

### New

- Map nodes are checked against the code (file exists, quoted line matches, in the diff for summaries); output leads with the check result.
- Plans that change existing code render Now and After side by side, for maps and flows.
- Node panel shows the file's diff; the panel is wider, resizable and wraps code.
- Each map picks top-down or left-to-right layout, whichever fits.
- Opt-in reminder line and Claude Code Stop hook (`install-skill --hook`).

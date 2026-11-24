# Agent instructions

Rules for coding agents working on this repo. `CLAUDE.md` points here.

## Greptile

Greptile reviews a pull request once, when it opens. Read its comments, fix what is real, reply on
each thread saying what changed or why the comment does not apply, and resolve it.

Greptile reviews cost credits, so ask it again (`@greptileai`) only like this:

1. **Once**, after fixing, and only if its review had a P1 (or a P0). P2 findings only: fix,
   reply and resolve, without asking again.
2. If the review after that has 3 or fewer findings, all P2: fix them, without asking again.
3. **A second time**, after fixing, only if that review had a P1 (or a P0) or 4 or more P2s.
   Never a third time.

Never ask it again for any other reason: not after a rebase, not to cover new commits.

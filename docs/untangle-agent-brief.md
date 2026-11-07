# Brief for untangle implementation agents

You implement ONE workstream of docs/untangle-plan.md. Read first: CLAUDE.md (repo root), docs/untangle-plan.md,
the relevant sections of docs/untangle-log.md, and .claude/skills/untangle-codebase/SKILL.md.

## Your own worktree (do this first)
```
cd "C:/Users/CH KAMRAN/Desktop/Workabot.ai/changecatch-wt/untangle"
git worktree add "../<WS>" -b untangle-<WS> untangle      # <WS> = your workstream id, e.g. w5-config
cd "../<WS>" && pnpm install --frozen-lockfile --silent
```
Work ONLY inside your worktree folder. Never touch `changecatch/` (main checkout), the `untangle` worktree, or other
agents' worktrees. Never push. Never run `hs project upload`. Never use real HubSpot or the network.

## Rules
- Untangle rules (CLAUDE.md): one owner per fact, no hidden links, no needless links, no surplus, special cases are design
  signals. Prefer deleting over adding. Don't add new abstractions beyond what your workstream needs.
- Behaviour must stay the same, except bugs your workstream is told to fix. Never weaken an exactly-once / no-missed-trigger
  assertion. HubSpot-facing property names and option values are frozen (D7): byte-identical.
- Stay inside your workstream's scope (listed in your prompt). If a fix needs files owned by another workstream, note it in
  your report instead of doing it. Keep diffs focused so merges are easy.
- Tests: when you delete code, delete only the tests that test that code. When a test covered the deleted path but guards
  real behaviour, port it to the real path (don't lose coverage).
- Comments: remove comments that only restate code in files you touch; keep HubSpot facts, measured numbers, doc URLs.
- Docs: update docs/*.md and .env.example lines that describe what you changed.

## Done = all of these, in your worktree
1. `pnpm -s -r typecheck` clean (repo root).
2. `cd service && pnpm -s test` all passing (report the count before/after).
3. BEFORE reporting: `git merge untangle` into your branch (other workstreams merge while you work), resolve
   conflicts keeping both intents, and re-run 1 and 2. Repeat if untangle moved again.
4. Commit on your branch (one or a few commits), author is already configured (Zubair Imtiaz). NO "Co-Authored-By" line.
   Message: imperative summary + short body of what was deleted/moved and why.
5. Report back (<= 300 words): branch name, commits, tests before/after, what you deleted/moved, any behaviour change,
   anything left for other workstreams, any risk.

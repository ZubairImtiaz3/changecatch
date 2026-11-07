# CLAUDE.md: ChangeCatch (production repo)

Read this before changing anything. It applies to every change, by a person or an agent.

ChangeCatch is a HubSpot app: one worker reads the Webhooks Journal for all installed portals, turns association
changes into ADDED / REMOVED / LABEL_CHANGED, and stamps `changecatch_*` properties onto records so workflows can
trigger on them. Start with [docs/architecture.md](docs/architecture.md); decisions and their reasons are in
[docs/decisions.md](docs/decisions.md).

## How code is written here: the untangle rules

Every change follows the `untangle-codebase` skill ([.claude/skills/untangle-codebase/SKILL.md](.claude/skills/untangle-codebase/SKILL.md)).
The test for every piece of code: **should these pieces change together?**

- **Pieces that change together live together.** Keep a feature in one place, not split across folders by layer.
  Never copy a value, list, format or rule into a second place (service, tools, settings page, tests, docs). Import the
  one source instead.
- **No hidden links.** A module doesn't read a global, env var, DB key or file that another module sets without an
  explicit import. Config is read in one place and passed in. No call orders callers "just have to know".
- **No needless links.** Callers use a module's interface, not its internals. Stable code never imports something
  more volatile (core logic doesn't import storage or install code). A general function doesn't take a parameter
  that only one caller understands. Prefer deep modules with small interfaces.
- **No surplus.** No pass-through wrappers, no config or extension points for things that never vary, no dead code.
  Prefer deleting over adding.
- **Special cases are design signals.** Before adding an `if` for one value, a caller-specific parameter, a swallowed
  exception, a retry or a sleep, ask what the system needs instead, and fix that.
- **Comments** say what the code can't: external facts (HubSpot API behaviour, doc URLs, measured numbers) and why a
  workaround exists. Never restate the code.
- **Tests** check behaviour, so they fail on a regression and only then. No tests that repeat the implementation, are
  tied to internals, or can't fail. The replay tests on real journal data are the regression net: keep them green.

## Fixed constraints

- **Never miss a trigger.** Exactly-once stamping and correct pairing beat speed and simplicity.
- **HubSpot-facing names and option values are frozen** once customers install ([docs/decisions.md](docs/decisions.md) D7).
- SQLite (WAL), one file, one worker. TypeScript on Node 24, no new frameworks.
- Date-based HubSpot API versions only, new developer platform only. Check the current HubSpot docs
  (https://developers.hubspot.com/docs/llms.txt) before calling an endpoint for the first time, and research the
  documented or standard approach before building a fix.

## Working rules

- Checks before handing over a change: `pnpm -r typecheck` and `pnpm test` (all green).
- HubSpot project uploads use config profiles: `hs project upload --profile <env>` from `hubspot-app/`.
- Never commit or push without the owner's explicit OK. Commits are authored as the owner; no AI co-author lines.
- Never print or commit `.env`, tokens or secrets.

# Contributing

Short rules for working in this repo. How to set up and run things locally is in [development.md](development.md).

## Branches

- `main` is the default branch. Keep it working: CI must be green.
- Work on short-lived branches: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `chore/<topic>`, `test/<topic>`.
- Merge through a pull request, even when working alone, so CI runs first.

## Commits

- Use Conventional Commits: `type(scope): summary`, for example `fix(worker): persist offset after empty batch`.
  - Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`, `perf`.
  - Scopes: `worker`, `poller`, `pairing`, `stamp`, `install`, `oauth`, `labels`, `hubspot-app`, `tools`, `docs`.
- One logical change per commit. Explain *why* in the body when it isn't obvious.
- Never commit `.env`, `data/`, tokens, or account exports.
- Line endings are LF (`.gitattributes`, `.editorconfig`).

## Checks before a pull request

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm --filter @changecatch/hubspot-app exec hs project validate   # needs `hs account auth` once
```

Unit tests need no network. When you change pipeline behaviour (pairing, absorption, coalescing, stamping), add a test with a real journal payload shape.

## End-to-end and load tests (real HubSpot, run by hand)

These touch a HubSpot test account and are **not** in CI. See the `tools` package README.

- Need a filled-in `.env` and a running worker.
- **Only one journal reader at a time.** Never run a local worker against an app whose worker is already running elsewhere.
- Every tool does a dry run first. Add `--yes` to make real changes.
- Ask before creating more than about 50 records, or before deleting anything in HubSpot.
- Record load-test results in [kpis.md](kpis.md).

## Release checklist

1. **Green build.** `pnpm typecheck` and `pnpm test` pass, and CI is green.
2. **Bump versions** in the changed packages' `package.json`. If the HubSpot app changed (scopes, settings page, properties), note it in the changelog. Record design changes in [decisions.md](decisions.md).
3. **Validate** the HubSpot project (`hs project validate`). Fix every error.
4. **Check scopes.** Request only scopes the code uses (a Marketplace rule). A scope change makes existing installs re-authorize, so call it out. See [marketplace/scopes.md](marketplace/scopes.md).
5. **Upload only with owner approval.** Before `hs project upload`, show what changes. Always ask first if the upload removes a component or touches live workflows. If HubSpot blocks the deploy, stop and report; never auto-retry.
6. **Deploy the service** (API server + worker). Make sure exactly **one** worker runs, and `/health` reports a recent successful journal read.
7. **Smoke test.** Run the end-to-end check (`tools`) against the test account and confirm stamps arrive.
8. **Record it.** Tag the commit (`git tag v<version>`) and add a line to the public changelog.

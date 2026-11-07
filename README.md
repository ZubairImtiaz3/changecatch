# ChangeCatch

ChangeCatch turns HubSpot association changes (a record linked, unlinked, or relabeled) into workflow triggers.
It watches the changes for every installed account and stamps each one onto the record as `changecatch_*` properties, so admins can build normal "Property value changed" workflows on them.

## How it works

1. An admin installs the app (OAuth) and picks which object pairs to watch, for example Deals ↔ Contacts.
2. ChangeCatch creates a Webhooks Journal subscription for those pairs in that account.
3. One worker reads the app-level journal (all accounts, one stream) every few seconds.
4. For each change it works out the type (`ADDED`, `REMOVED`, `LABEL_CHANGED`) and the label names before and after.
5. It writes 7 `changecatch_*` properties onto the record with a CRM batch update.
6. Customer workflows trigger on **"ChangeCatch: last change ID" has changed** (re-enrollment on) and filter on the other properties.

Typical time from the change in HubSpot to the stamp on the record: about 8–10 seconds.

Details: [docs/architecture.md](docs/architecture.md).

## Repo layout

```
changecatch/
├── service/        @changecatch/service     API server (OAuth install, settings API) + worker (journal → stamps)
├── hubspot-app/    @changecatch/hubspot-app HubSpot developer-platform project (app config, scopes, settings page)
├── tools/          @changecatch/tools       Developer CLIs against a test portal: load test and end-to-end check
├── docs/           Architecture, configuration, development
├── .env.example    Every environment variable, with defaults
└── pnpm-workspace.yaml
```

## Quick start

Requirements: Node.js 24+, pnpm, and a HubSpot developer account with its own ChangeCatch app (see [docs/development.md](docs/development.md)).

```bash
pnpm install
cp .env.example .env                      # fill in the required values (docs/configuration.md)
pnpm --filter @changecatch/service dev    # API server (port 3001) + worker (health on port 3002)
```

Generate the token encryption key once and store it safely. Losing it means every account must reinstall.

```bash
node -e "console.log('k1:' + require('crypto').randomBytes(32).toString('base64'))"   # value for TOKEN_ENC_KEYS
```

Tests and type checks:

```bash
pnpm test                                 # all packages
pnpm typecheck
pnpm --filter @changecatch/service test   # service only
```

## Documentation

- [Architecture](docs/architecture.md): pipeline, data model, delivery guarantees, key decisions
- [Configuration](docs/configuration.md): every environment variable, with default and purpose
- [Development](docs/development.md): tests, the HubSpot project, local HTTPS for the settings page, load testing

## Deployment

TBD.

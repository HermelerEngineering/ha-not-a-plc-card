# Not a PLC — status card

A read-only [Lovelace](https://www.home-assistant.io/dashboards/) card for the
[**Not a PLC**](https://github.com/HermelerEngineering/ha-not-a-plc) integration.
It draws your ladder program and colours the "energised" contacts, wires and
coils live, so you get the classic PLC *online monitoring* feel on a Home
Assistant dashboard.

It is purely a monitor — it never writes. Actuation stays in the integration.

## How it works

The card talks to the integration over two websocket commands:

- `not_a_plc/get_program` — fetched once, to draw the rungs from the canonical IR.
- `not_a_plc/subscribe_state` — the process image (inputs, memory bits and coils)
  pushed after every scan; each update recolours the SVG.

The "what is energised" decision is a pure function of `(program, state)`
([`src/power-flow.ts`](src/power-flow.ts)), kept free of any DOM so it is
unit-tested in isolation.

## Requirements

- The **Not a PLC** integration installed and set up (it exposes the websocket
  API this card consumes).

## Installation via HACS (custom repository)

1. In Home Assistant: **HACS → ⋮ (top right) → Custom repositories**.
2. Repository: `https://github.com/HermelerEngineering/ha-not-a-plc-card`
   — Category: **Dashboard**. Add it.
3. Open the new **Not a PLC Card** entry and **Download** it. HACS fetches the
   built `not-a-plc-card.js` from the latest release and registers the dashboard
   resource for you.
4. Add a card of type `custom:not-a-plc-card` to a dashboard:

```yaml
type: custom:not-a-plc-card
title: Ventilation logic
# Optional: which Not a PLC service to show. Omit to use the first one.
# Pick it visually in the card editor; this is the service's config entry id.
service: 1a2b3c...
```

If you run several Not a PLC services, choose which one a card shows in the card
editor's **Service** dropdown (no YAML needed). The heartbeat dot (top-right)
blinks at the service's scan interval.

HACS installs the file attached to a GitHub **release** (built by the release
workflow), so make sure the repository has at least one release — see below.

## Installation (manual, during development)

1. `npm install && npm run build` — produces `dist/not-a-plc-card.js`.
2. Copy that file to `config/www/not-a-plc-card.js` in Home Assistant.
3. Add it as a dashboard resource (Settings → Dashboards → Resources) as a
   JavaScript module: `/local/not-a-plc-card.js`.
4. Add a card of type `custom:not-a-plc-card` to a dashboard (as above).

## Cutting a release

The bundle is not committed; it is built on demand. Pushing a version tag runs
the release workflow, which builds `not-a-plc-card.js` and attaches it to the
GitHub release HACS installs from:

```bash
git tag v0.0.1
git push origin v0.0.1
```

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest (pure power-flow tests)
npm run build       # vite library build -> dist/
```

## Status

Phase 2 of the project: read-only status view. The editable variant (phase 4)
reuses this render layer. See the integration repo's `docs/project-plan.md`.

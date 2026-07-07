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

## Installation (manual, during development)

1. `npm install && npm run build` — produces `dist/not-a-plc-card.js`.
2. Copy that file to `config/www/not-a-plc-card.js` in Home Assistant.
3. Add it as a dashboard resource (Settings → Dashboards → Resources) as a
   JavaScript module: `/local/not-a-plc-card.js`.
4. Add a card of type `custom:not-a-plc-card` to a dashboard.

```yaml
type: custom:not-a-plc-card
title: Ventilation logic
```

HACS packaging (custom "Lovelace"/dashboard repository) comes with the first
tagged release.

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

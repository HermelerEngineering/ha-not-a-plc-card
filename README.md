# Not-a-PLC — editor panel & status card

The frontend for [**Not-a-PLC**](https://github.com/HermelerEngineering/ha-not-a-plc):
a full-page **graphical editor** for building ladder programs, plus a read-only
**status card** for your dashboards.

**Not-a-PLC is not a PLC — and you do not need one.** No industrial hardware, no
Modbus, no external runtime. It is a different **way of programming your
automations** inside Home Assistant: a cyclic scan that reads your entities,
solves a ladder program, and writes the results back as real HA entities. If you
have written ladder logic before, this will feel familiar; if not, it is a very
visual way to express "when these conditions hold, do this".

## Status: beta

In **beta testing** — usable day to day, but expect rough edges and occasional
breaking changes while things settle. Feedback is very welcome.

## You need both parts

This repository is only the frontend. It does nothing on its own — the logic
engine lives in the integration:

| Part | Repository | HACS category |
|------|-----------|---------------|
| **Integration** | [`ha-not-a-plc`](https://github.com/HermelerEngineering/ha-not-a-plc) | Integration |
| **Card / editor** | [`ha-not-a-plc-card`](https://github.com/HermelerEngineering/ha-not-a-plc-card) (this repo) | Dashboard |

Install **both**, then create your first service and program as described in the
[integration README](https://github.com/HermelerEngineering/ha-not-a-plc#creating-a-program).

## Install via HACS (custom repository)

1. In Home Assistant: **HACS → ⋮ (top right) → Custom repositories**.
2. Repository: `https://github.com/HermelerEngineering/ha-not-a-plc-card`
   — Category: **Dashboard**. Add it.
3. Open the new **Not-a-PLC Card** entry and **Download** it. HACS fetches the
   built `not-a-plc-card.js` from the latest release and registers the dashboard
   resource for you.
4. **Restart Home Assistant** (or reload the page) so the resource loads.

## The editor panel

Once installed, **Not-a-PLC** appears in the Home Assistant sidebar (admin only).
That page is where you actually build and change programs — define tags, drag
elements onto the ladder, configure timers and counters, and press **Save**.

The editor canvas is live: it is coloured in real time as the program runs, so you
edit and monitor in the same view. See the
[integration README](https://github.com/HermelerEngineering/ha-not-a-plc#editing-a-program)
for a walkthrough of the editor.

## Adding the status card to a dashboard

The card is a **read-only, visual view of the program's status**. It never writes
anything and cannot change your program — it is purely for watching the logic run
on a dashboard. All editing happens in the sidebar panel described above.

1. Open the dashboard you want it on and choose **Edit dashboard**.
2. **+ Add card**, then search for **Not-a-PLC** (or pick *Manual* and use the YAML
   below).
3. In the card editor, pick which **Service** to show from the dropdown — this is
   the Not-a-PLC service (config entry) whose program you want to watch. Leave it
   alone if you only have one.
4. **Save**.

YAML equivalent, if you prefer:

```yaml
type: custom:not-a-plc-card
title: Ventilation logic
# Optional: which Not-a-PLC service to show. Omit to use the first one.
# Easiest picked visually in the card editor; this is the service's config entry id.
service: 1a2b3c...
```

The card draws the rungs and colours energised contacts, wires and coils live, so
you get the classic *online monitoring* feel. The heartbeat dot (top-right) blinks
at the service's scan interval, so you can see the engine is running.

## How it works

The frontend talks to the integration over websocket commands:

- `not_a_plc/get_program` — the canonical program (the "IR"), used to draw the rungs.
- `not_a_plc/subscribe_state` — the process image (inputs, memory bits, coils)
  pushed after each scan; every update recolours the SVG.
- `not_a_plc/save_program` — used by the editor panel only.

The "what is energised" decision is a pure function of `(program, state)`
([`src/power-flow.ts`](src/power-flow.ts)), kept free of any DOM so it is
unit-tested in isolation. The same render layer draws both the read-only card and
the editor canvas.

## Installation (manual, during development)

1. `npm install && npm run build` — produces `dist/not-a-plc-card.js`.
2. Copy that file to `config/www/not-a-plc-card.js` in Home Assistant.
3. Add it as a dashboard resource (Settings → Dashboards → Resources) as a
   JavaScript module: `/local/not-a-plc-card.js`.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest (pure logic: power-flow, elements, layout, validation, …)
npm run build       # vite library build -> dist/
```

The bundle is not committed; it is built on demand. Pushing a version tag runs the
release workflow, which builds `not-a-plc-card.js` and attaches it to the GitHub
release HACS installs from:

```bash
git tag v0.34.0
git push origin v0.34.0
```

## License

MIT — see [LICENSE](LICENSE). You may use, modify and redistribute this freely,
including commercially; the only condition is that the copyright notice and
licence text travel with copies. It comes with no warranty.

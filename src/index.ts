/**
 * Entry point: registers the custom element and advertises it to the Lovelace
 * card picker. Importing `./ladder-card` runs its `@customElement` decorator.
 */

import "./ladder-card";

const CARD_TYPE = "not-a-plc-card";

window.customCards = window.customCards ?? [];
window.customCards.push({
  type: CARD_TYPE,
  name: "Not a PLC",
  description: "Read-only live status view of a Not a PLC ladder program.",
  preview: false,
});

console.info(
  "%c NOT-A-PLC-CARD %c read-only status view ",
  "color: white; background: #3f51b5; font-weight: 700;",
  "color: #3f51b5; background: white;",
);

export { NotAPlcCard } from "./ladder-card";

/**
 * `not-a-plc-card` — a read-only Lovelace card that shows a Not a PLC program
 * "flowing" live.
 *
 * On first `hass` it fetches the program once (`not_a_plc/get_program`) and
 * subscribes to the process image (`not_a_plc/subscribe_state`). Each pushed
 * state re-runs `computePowerFlow` and recolours the SVG. It is purely a
 * monitor — it never writes.
 */

import {
  LitElement,
  PropertyValues,
  SVGTemplateResult,
  TemplateResult,
  css,
  html,
  svg,
} from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { HomeAssistant, LovelaceCardConfig } from "./ha";
import { Program, StateImage } from "./ir";
import { computePowerFlow } from "./power-flow";
import { renderNetwork } from "./render";

const VIEW_WIDTH = 720;

@customElement("not-a-plc-card")
export class NotAPlcCard extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;

  @state() private _config?: LovelaceCardConfig;
  @state() private _program?: Program;
  @state() private _stateImage: StateImage = {};
  @state() private _error?: string;
  @state() private _beat = false;

  private _unsub?: () => void;
  private _started = false;

  setConfig(config: LovelaceCardConfig): void {
    this._config = config;
  }

  getCardSize(): number {
    const rungs =
      this._program?.networks.reduce((n, net) => n + net.rungs.length, 0) ?? 3;
    return Math.max(3, rungs + 1);
  }

  static getStubConfig(): LovelaceCardConfig {
    return { type: "custom:not-a-plc-card" };
  }

  protected updated(changed: PropertyValues): void {
    if (changed.has("hass") && this.hass && !this._started) {
      this._started = true;
      void this._start();
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._unsub?.();
    this._unsub = undefined;
    this._started = false;
  }

  private async _start(): Promise<void> {
    if (!this.hass) return;
    try {
      const res = await this.hass.connection.sendMessagePromise<{ program: Program }>({
        type: "not_a_plc/get_program",
      });
      this._program = res.program;
      this._error = undefined;
      this._unsub = await this.hass.connection.subscribeMessage<{ state: StateImage }>(
        (msg) => {
          this._stateImage = msg.state;
          this._beat = !this._beat; // toggle the liveness dot each scan
        },
        { type: "not_a_plc/subscribe_state" },
      );
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
    }
  }

  protected render(): TemplateResult {
    return html`
      <ha-card .header=${this._config?.title ?? "Not a PLC"}>
        <div class="content">
          <div class="heartbeat ${this._beat ? "on" : ""}" title="Scan activity"></div>
          ${this._renderBody()}
        </div>
      </ha-card>
    `;
  }

  private _renderBody(): TemplateResult {
    if (this._error) {
      return html`<div class="error">${this._error}</div>`;
    }
    if (!this._program) {
      return html`<div class="hint">Loading program…</div>`;
    }
    if (this._program.networks.length === 0) {
      return html`<div class="hint">The program has no networks.</div>`;
    }

    const flow = computePowerFlow(this._program, this._stateImage);
    const groups: SVGTemplateResult[] = [];
    let y = 0;
    for (const network of this._program.networks) {
      const rendered = renderNetwork(network, flow, VIEW_WIDTH);
      groups.push(svg`<g transform="translate(0, ${y})">${rendered.part}</g>`);
      y += rendered.height;
    }

    return html`
      <svg
        viewBox="0 0 ${VIEW_WIDTH} ${y}"
        width="100%"
        preserveAspectRatio="xMidYMin meet"
        role="img"
        aria-label="Ladder program status"
      >
        ${groups}
      </svg>
    `;
  }

  static styles = css`
    .content {
      padding: 8px 12px 16px;
      overflow-x: auto;
      position: relative;
    }
    .heartbeat {
      position: absolute;
      top: 8px;
      right: 12px;
      width: 11px;
      height: 11px;
      border-radius: 50%;
      background: var(--disabled-text-color, #9e9e9e);
      opacity: 0.45;
      transition:
        background 120ms ease,
        opacity 120ms ease;
    }
    .heartbeat.on {
      background: var(--success-color, #4caf50);
      opacity: 1;
    }
    .hint,
    .error {
      padding: 16px;
      color: var(--secondary-text-color);
    }
    .error {
      color: var(--error-color, #db4437);
    }
    svg {
      display: block;
    }
    .rail {
      stroke: var(--primary-text-color);
      stroke-width: 2;
    }
    .wire {
      stroke: var(--disabled-text-color, #9e9e9e);
      stroke-width: 2;
    }
    .wire.live {
      stroke: var(--state-active-color, #4caf50);
      stroke-width: 3;
    }
    .symbol {
      stroke: var(--primary-text-color);
      stroke-width: 2;
    }
    .symbol.live {
      stroke: var(--state-active-color, #4caf50);
      stroke-width: 2.5;
    }
    .coil {
      stroke: var(--primary-text-color);
      stroke-width: 2;
    }
    .coil.live {
      stroke: var(--state-active-color, #4caf50);
      stroke-width: 2.5;
    }
    text.tag {
      fill: var(--primary-text-color);
      font-size: 13px;
      text-anchor: middle;
    }
    text.mode,
    text.coil-mode {
      fill: var(--secondary-text-color);
      font-size: 12px;
      text-anchor: middle;
    }
    text.coil-mode.live {
      fill: var(--state-active-color, #4caf50);
      font-weight: 600;
    }
    text.network-title {
      fill: var(--primary-text-color);
      font-size: 15px;
      font-weight: 600;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "not-a-plc-card": NotAPlcCard;
  }
}

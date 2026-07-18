/**
 * `not-a-plc-card` — a read-only Lovelace card that shows a Not-a-PLC program
 * "flowing" live.
 *
 * On first `hass` it fetches the program once (`not_a_plc/get_program`) and
 * subscribes to the process image (`not_a_plc/subscribe_state`). Each pushed
 * state re-runs `computePowerFlow` and recolours the SVG. It is purely a
 * monitor — it never writes.
 */

import { LitElement, SVGTemplateResult, TemplateResult, css, html, svg } from "lit";
import { property, state } from "lit/decorators.js";

import { defineOnce } from "./define";
import { HomeAssistant, LovelaceCardConfig } from "./ha";
import { Program, StateImage } from "./ir";
import { computePowerFlow } from "./power-flow";
import { renderNetwork } from "./render";

const VIEW_WIDTH = 760;

@defineOnce("not-a-plc-card")
export class NotAPlcCard extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;

  @state() private _config?: LovelaceCardConfig;
  @state() private _program?: Program;
  @state() private _stateImage: StateImage = {};
  @state() private _error?: string;
  @state() private _beat = false;

  private _unsub?: () => void;
  private _beatTimer?: number;
  // Key of the service we last (re)started for; undefined = not started yet.
  private _startedKey?: string;

  setConfig(config: LovelaceCardConfig): void {
    this._config = config;
  }

  getCardSize(): number {
    const rungs =
      this._program?.networks.reduce((n, net) => n + net.rungs.length, 0) ?? 3;
    return Math.max(3, rungs + 1);
  }

  static getConfigElement(): HTMLElement {
    return document.createElement("not-a-plc-card-editor");
  }

  static getStubConfig(): LovelaceCardConfig {
    return { type: "custom:not-a-plc-card" };
  }

  private _serviceId(): string | undefined {
    const service = this._config?.service;
    return typeof service === "string" && service ? service : undefined;
  }

  protected updated(): void {
    if (!this.hass) return;
    // (Re)start whenever the selected service changes (or on first hass).
    const key = this._serviceId() ?? "";
    if (this._startedKey !== key) {
      this._startedKey = key;
      void this._start();
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._unsub?.();
    this._unsub = undefined;
    this._stopHeartbeat();
    this._startedKey = undefined;
  }

  private _startHeartbeat(intervalMs: number): void {
    // The card cannot observe every scan without per-cycle traffic (that flooded
    // the socket), so blink locally at the configured scan interval as a "the
    // engine is cycling" cue. Genuine stall detection would need a throttled
    // server-side liveness tick — a later addition.
    this._stopHeartbeat();
    this._beatTimer = window.setInterval(() => {
      this._beat = !this._beat;
    }, Math.max(100, intervalMs));
  }

  private _stopHeartbeat(): void {
    if (this._beatTimer !== undefined) {
      window.clearInterval(this._beatTimer);
      this._beatTimer = undefined;
    }
  }

  private async _start(): Promise<void> {
    if (!this.hass) return;
    // Tear down any previous subscription (e.g. when the selected service changes).
    this._unsub?.();
    this._unsub = undefined;
    this._stopHeartbeat();

    const entryId = this._serviceId();
    const target: Record<string, unknown> = entryId ? { entry_id: entryId } : {};
    try {
      const res = await this.hass.connection.sendMessagePromise<{ program: Program }>({
        type: "not_a_plc/get_program",
        ...target,
      });
      this._program = res.program;
      this._stateImage = {};
      this._error = undefined;
      this._unsub = await this.hass.connection.subscribeMessage<{ state: StateImage }>(
        (msg) => {
          this._stateImage = msg.state;
        },
        { type: "not_a_plc/subscribe_state", ...target },
      );
      this._startHeartbeat(this._program.scan_interval_ms ?? 500);
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
    }
  }

  protected render(): TemplateResult {
    return html`
      <ha-card .header=${this._config?.title ?? "Not-a-PLC"}>
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
    const fbs = this._program.fbs ?? {};
    const groups: SVGTemplateResult[] = [];
    let y = 0;
    for (const network of this._program.networks) {
      const rendered = renderNetwork(network, flow, VIEW_WIDTH, fbs, this._stateImage);
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
    text.compare-text {
      fill: var(--primary-text-color);
      font-size: 12px;
      text-anchor: middle;
    }
    text.fb-text {
      fill: var(--primary-text-color);
      font-size: 11px;
      font-weight: 600;
      text-anchor: middle;
    }
    text.mode,
    text.coil-mode {
      fill: var(--secondary-text-color);
      font-size: 12px;
      text-anchor: middle;
    }
    text.pin-l,
    text.pin-r {
      fill: var(--secondary-text-color);
      font-size: 10px;
    }
    text.pin-l {
      text-anchor: start;
    }
    text.pin-r {
      text-anchor: end;
    }
    text.pin-v-l,
    text.pin-v-r {
      fill: var(--primary-text-color);
      font-size: 11px;
    }
    text.pin-v-l {
      text-anchor: end;
    }
    text.pin-v-r {
      text-anchor: start;
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

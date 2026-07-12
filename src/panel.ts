/**
 * `not-a-plc-panel` — the full-page editor panel (phase 4.1 scaffold).
 *
 * Registered as a Home Assistant sidebar panel by the integration (`panel_custom`
 * pointing at this bundle). It:
 *   - lists the running services and lets you pick one,
 *   - shows a structural preview of that service's program (reusing the card's
 *     render / power-flow layer),
 *   - lets you edit the program as lossless DSL text and save it back
 *     (`save_program_text` → validate → `.storage` → reload).
 *
 * The structured (form/drag) editing lands in later 4.x sub-phases; this proves
 * the panel ↔ get/save pipeline and is already useful (edit in the UI, no
 * `.storage` fiddling).
 */

import {
  LitElement,
  SVGTemplateResult,
  TemplateResult,
  css,
  html,
  svg,
} from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { HomeAssistant } from "./ha";
import { Program, ServiceInfo } from "./ir";
import { computePowerFlow } from "./power-flow";
import { renderNetwork } from "./render";

const VIEW_WIDTH = 720;

@customElement("not-a-plc-panel")
export class NotAPlcPanel extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;
  @property({ type: Boolean }) narrow = false;

  @state() private _services: ServiceInfo[] = [];
  @state() private _service = "";
  @state() private _program?: Program;
  @state() private _text = "";
  @state() private _status = "";
  @state() private _loaded = false;

  protected updated(): void {
    if (this.hass && !this._loaded) {
      this._loaded = true;
      void this._init();
    }
  }

  private async _init(): Promise<void> {
    await this._loadServices();
    await this._loadProgram();
  }

  private _target(): Record<string, unknown> {
    return this._service ? { entry_id: this._service } : {};
  }

  private async _loadServices(): Promise<void> {
    const conn = this.hass?.connection;
    if (!conn) return;
    try {
      const res = await conn.sendMessagePromise<{ services: ServiceInfo[] }>({
        type: "not_a_plc/list_services",
      });
      this._services = res.services;
      if (!this._service && this._services.length) {
        this._service = this._services[0].entry_id;
      }
    } catch {
      this._services = [];
    }
  }

  private async _loadProgram(): Promise<void> {
    const conn = this.hass?.connection;
    if (!conn) return;
    try {
      const prog = await conn.sendMessagePromise<{ program: Program }>({
        type: "not_a_plc/get_program",
        ...this._target(),
      });
      this._program = prog.program;
      const text = await conn.sendMessagePromise<{ text: string }>({
        type: "not_a_plc/get_program_text",
        ...this._target(),
      });
      this._text = text.text;
      this._status = "";
    } catch (err) {
      this._status = err instanceof Error ? err.message : String(err);
    }
  }

  private async _onService(e: Event): Promise<void> {
    this._service = (e.target as HTMLSelectElement).value;
    await this._loadProgram();
  }

  private async _save(): Promise<void> {
    const conn = this.hass?.connection;
    if (!conn) return;
    const textarea = this.renderRoot.querySelector("textarea");
    const text = textarea?.value ?? this._text;
    this._status = "Saving…";
    try {
      await conn.sendMessagePromise({
        type: "not_a_plc/save_program_text",
        ...this._target(),
        text,
      });
      this._status = "Saved.";
      await this._loadProgram();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._status = `Error: ${message}`;
    }
  }

  protected render(): TemplateResult {
    return html`
      <div class="topbar">
        <ha-menu-button .hass=${this.hass} .narrow=${this.narrow}></ha-menu-button>
        <div class="title">Not-a-PLC editor</div>
        <select
          class="service"
          .value=${this._service}
          @change=${this._onService}
          ?disabled=${this._services.length === 0}
        >
          ${this._services.map(
            (s) =>
              html`<option value=${s.entry_id} ?selected=${s.entry_id === this._service}>
                ${s.name}
              </option>`,
          )}
        </select>
      </div>
      <div class="body">
        <section class="preview">${this._renderPreview()}</section>
        <section class="edit">
          <label>Program (text DSL)</label>
          <textarea spellcheck="false" .value=${this._text}></textarea>
          <div class="actions">
            <button @click=${this._save}>Save</button>
            <span class="status">${this._status}</span>
          </div>
        </section>
      </div>
    `;
  }

  private _renderPreview(): TemplateResult {
    if (!this._program) return html`<div class="hint">Loading…</div>`;
    if (this._program.networks.length === 0) {
      return html`<div class="hint">This program has no networks.</div>`;
    }
    const flow = computePowerFlow(this._program, {});
    const fbTypes: Record<string, string> = {};
    for (const [name, fb] of Object.entries(this._program.fbs ?? {})) {
      fbTypes[name] = fb.type;
    }
    const groups: SVGTemplateResult[] = [];
    let y = 0;
    for (const network of this._program.networks) {
      const rendered = renderNetwork(network, flow, VIEW_WIDTH, fbTypes);
      groups.push(svg`<g transform="translate(0, ${y})">${rendered.part}</g>`);
      y += rendered.height;
    }
    return html`
      <svg viewBox="0 0 ${VIEW_WIDTH} ${y}" width="100%" role="img">
        ${groups}
      </svg>
    `;
  }

  static styles = css`
    :host {
      display: block;
      height: 100%;
      background: var(--primary-background-color);
      color: var(--primary-text-color);
    }
    .topbar {
      display: flex;
      align-items: center;
      gap: 12px;
      height: 56px;
      padding: 0 16px;
      background: var(--app-header-background-color, var(--primary-color));
      color: var(--app-header-text-color, #fff);
    }
    .title {
      font-size: 20px;
      font-weight: 500;
      flex: 1;
    }
    select,
    textarea,
    button {
      font: inherit;
      color: var(--primary-text-color);
      background: var(--card-background-color, #fff);
      border: 1px solid var(--divider-color, #ccc);
      border-radius: 4px;
      padding: 6px 8px;
    }
    .service {
      max-width: 240px;
    }
    .body {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      padding: 16px;
      align-items: start;
    }
    @media (max-width: 900px) {
      .body {
        grid-template-columns: 1fr;
      }
    }
    section {
      background: var(--card-background-color, #fff);
      border-radius: 8px;
      padding: 12px;
      overflow-x: auto;
    }
    .edit {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    label {
      font-size: 0.85em;
      color: var(--secondary-text-color);
    }
    textarea {
      min-height: 320px;
      font-family: var(--code-font-family, monospace);
      white-space: pre;
    }
    .actions {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    button {
      cursor: pointer;
      background: var(--primary-color);
      color: var(--text-primary-color, #fff);
      border: none;
      padding: 8px 16px;
    }
    .status {
      color: var(--secondary-text-color);
    }
    .hint {
      color: var(--secondary-text-color);
      padding: 16px;
    }
    /* energised colours match the card */
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
    .symbol,
    .coil {
      stroke: var(--primary-text-color);
      stroke-width: 2;
    }
    .symbol.live,
    .coil.live {
      stroke: var(--state-active-color, #4caf50);
      stroke-width: 2.5;
    }
    text.tag,
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
      font-size: 11px;
      text-anchor: middle;
    }
    text.network-title {
      fill: var(--primary-text-color);
      font-size: 14px;
      font-weight: 600;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "not-a-plc-panel": NotAPlcPanel;
  }
}

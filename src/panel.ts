/**
 * `not-a-plc-panel` — the full-page editor panel.
 *
 * Registered as a Home Assistant sidebar panel by the integration (`panel_custom`
 * pointing at this bundle). It:
 *   - lists the running services and lets you pick one,
 *   - shows a LIVE preview of that service's program (reusing the card's render /
 *     power-flow layer, coloured by a `subscribe_state` stream),
 *   - lets you bind each input tag to an entity via a self-contained
 *     `<input>` + `<datalist>` picker (phase 4.2) and save (`save_program`),
 *   - keeps a lossless DSL text editor as an escape hatch (`save_program_text`).
 *
 * Structured add/remove of tags and elements, and the drag-drop canvas, land in
 * later 4.x sub-phases.
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
import { Program, ServiceInfo, StateImage, TagDef } from "./ir";
import { computePowerFlow } from "./power-flow";
import { renderNetwork } from "./render";

const VIEW_WIDTH = 720;

// Domains offered by the entity picker per tag type (see project-plan §3a). We
// build our own picker from `hass.states` because HA's `ha-entity-picker` is a
// lazy-loaded element that is not reliably defined inside a custom panel.
const REAL_DOMAINS = ["sensor", "input_number", "number"];
const BOOL_DOMAINS = [
  "binary_sensor",
  "input_boolean",
  "switch",
  "light",
  "fan",
  "sun",
  "person",
  "device_tracker",
  "cover",
  "lock",
  "group",
];

@customElement("not-a-plc-panel")
export class NotAPlcPanel extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;
  @property({ type: Boolean }) narrow = false;

  @state() private _services: ServiceInfo[] = [];
  @state() private _service = "";
  @state() private _program?: Program;
  @state() private _stateImage: StateImage = {};
  @state() private _text = "";
  @state() private _status = "";
  @state() private _loaded = false;

  private _unsub?: () => void;

  protected updated(): void {
    if (this.hass && !this._loaded) {
      this._loaded = true;
      void this._init();
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._unsub?.();
    this._unsub = undefined;
  }

  private async _init(): Promise<void> {
    await this._loadServices();
    await this._loadProgram();
    await this._subscribe();
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

  private async _subscribe(): Promise<void> {
    const conn = this.hass?.connection;
    if (!conn) return;
    this._unsub?.();
    this._unsub = undefined;
    try {
      this._unsub = await conn.subscribeMessage<{ state: StateImage }>(
        (msg) => {
          this._stateImage = msg.state;
        },
        { type: "not_a_plc/subscribe_state", ...this._target() },
      );
    } catch {
      this._stateImage = {};
    }
  }

  private async _onService(e: Event): Promise<void> {
    this._service = (e.target as HTMLSelectElement).value;
    this._stateImage = {};
    await this._loadProgram();
    await this._subscribe();
  }

  private _setSource(name: string, value: string): void {
    if (!this._program) return;
    const tag = this._program.tags[name];
    const updated: TagDef = { ...tag, source: value || undefined };
    this._program = {
      ...this._program,
      tags: { ...this._program.tags, [name]: updated },
    };
    this._status = "Unsaved changes.";
  }

  private async _saveProgram(): Promise<void> {
    const conn = this.hass?.connection;
    if (!conn || !this._program) return;
    this._status = "Saving…";
    try {
      await conn.sendMessagePromise({
        type: "not_a_plc/save_program",
        ...this._target(),
        program: this._program,
      });
      this._status = "Saved.";
      await this._loadProgram();
    } catch (err) {
      this._status = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async _saveText(): Promise<void> {
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
      this._status = `Error: ${err instanceof Error ? err.message : String(err)}`;
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
        <span class="status">${this._status}</span>
      </div>
      <div class="body">
        <section class="preview">${this._renderPreview()}</section>
        <section class="edit">
          ${this._renderTags()}
          <details>
            <summary>Advanced: edit as text (DSL)</summary>
            <textarea spellcheck="false" .value=${this._text}></textarea>
            <button @click=${this._saveText}>Save text</button>
          </details>
        </section>
      </div>
    `;
  }

  private _renderTags(): TemplateResult {
    if (!this._program) return html`<div class="hint">Loading…</div>`;
    const entries = Object.entries(this._program.tags);
    return html`
      <div class="tags-header">
        <h3>Tags</h3>
        <button @click=${this._saveProgram}>Save</button>
      </div>
      <table class="tags">
        <thead>
          <tr><th>Name</th><th>Kind</th><th>Type</th><th>Binding</th></tr>
        </thead>
        <tbody>
          ${entries.map(([name, tag]) => this._renderTagRow(name, tag))}
        </tbody>
      </table>
      ${this._datalists()}
    `;
  }

  private _renderTagRow(name: string, tag: TagDef): TemplateResult {
    return html`
      <tr>
        <td>${name}</td>
        <td>${tag.kind}</td>
        <td>${tag.type ?? "BOOL"}</td>
        <td>${this._renderBinding(name, tag)}</td>
      </tr>
    `;
  }

  private _entityIds(domains: string[]): string[] {
    const states = this.hass?.states ?? {};
    return Object.keys(states)
      .filter((id) => domains.includes(id.split(".")[0]))
      .sort();
  }

  private _datalists(): TemplateResult {
    const options = (domains: string[]) =>
      this._entityIds(domains).map((id) => html`<option value=${id}></option>`);
    return html`
      <datalist id="np-real-entities">${options(REAL_DOMAINS)}</datalist>
      <datalist id="np-bool-entities">${options(BOOL_DOMAINS)}</datalist>
    `;
  }

  private _renderBinding(name: string, tag: TagDef): TemplateResult {
    if (tag.kind !== "input") {
      return html`<span class="muted">—</span>`;
    }
    const listId = tag.type === "REAL" ? "np-real-entities" : "np-bool-entities";
    return html`
      <input
        class="entity-input"
        list=${listId}
        .value=${tag.source ?? ""}
        placeholder="entity_id"
        @change=${(e: Event) =>
          this._setSource(name, (e.target as HTMLInputElement).value)}
      />
    `;
  }

  private _renderPreview(): TemplateResult {
    if (!this._program) return html`<div class="hint">Loading…</div>`;
    if (this._program.networks.length === 0) {
      return html`<div class="hint">This program has no networks.</div>`;
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
    .status {
      font-size: 0.9em;
      opacity: 0.9;
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
    .tags-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    h3 {
      margin: 4px 0 8px;
    }
    table.tags {
      width: 100%;
      border-collapse: collapse;
    }
    table.tags th,
    table.tags td {
      text-align: left;
      padding: 6px 8px;
      border-bottom: 1px solid var(--divider-color, #eee);
      vertical-align: middle;
    }
    table.tags th {
      font-size: 0.8em;
      color: var(--secondary-text-color);
    }
    .muted {
      color: var(--secondary-text-color);
    }
    input.entity-input {
      width: 100%;
      min-width: 180px;
      box-sizing: border-box;
    }
    details {
      margin-top: 12px;
    }
    summary {
      cursor: pointer;
      color: var(--secondary-text-color);
    }
    textarea {
      width: 100%;
      min-height: 240px;
      margin: 8px 0;
      font-family: var(--code-font-family, monospace);
      white-space: pre;
    }
    button {
      cursor: pointer;
      background: var(--primary-color);
      color: var(--text-primary-color, #fff);
      border: none;
      padding: 8px 16px;
    }
    .hint {
      color: var(--secondary-text-color);
      padding: 16px;
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

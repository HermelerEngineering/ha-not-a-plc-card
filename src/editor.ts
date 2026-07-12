/**
 * Config editor for `not-a-plc-card` — the UI shown in the Lovelace card editor.
 *
 * Lets the user pick which Not-a-PLC service the card renders (and set a title)
 * without touching YAML. Services come from `not_a_plc/list_services`. Emits the
 * standard `config-changed` event the card editor listens for.
 */

import { LitElement, TemplateResult, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { HomeAssistant, LovelaceCardConfig } from "./ha";
import { ServiceInfo } from "./ir";

@customElement("not-a-plc-card-editor")
export class NotAPlcCardEditor extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;

  @state() private _config?: LovelaceCardConfig;
  @state() private _services: ServiceInfo[] = [];
  @state() private _loaded = false;

  setConfig(config: LovelaceCardConfig): void {
    this._config = config;
  }

  protected updated(): void {
    if (this.hass && !this._loaded) {
      this._loaded = true;
      void this._loadServices();
    }
  }

  private async _loadServices(): Promise<void> {
    const conn = this.hass?.connection;
    if (!conn) return;
    try {
      const res = await conn.sendMessagePromise<{ services: ServiceInfo[] }>({
        type: "not_a_plc/list_services",
      });
      this._services = res.services;
    } catch {
      this._services = [];
    }
  }

  private _emit(patch: Partial<LovelaceCardConfig>): void {
    const base = this._config ?? { type: "custom:not-a-plc-card" };
    const config = { ...base, ...patch };
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _onTitle(e: Event): void {
    this._emit({ title: (e.target as HTMLInputElement).value || undefined });
  }

  private _onService(e: Event): void {
    this._emit({ service: (e.target as HTMLSelectElement).value || undefined });
  }

  protected render(): TemplateResult {
    if (!this._config) return html``;
    const service =
      typeof this._config.service === "string" ? this._config.service : "";
    const title = typeof this._config.title === "string" ? this._config.title : "";
    return html`
      <div class="form">
        <label class="field">
          <span>Title</span>
          <input type="text" .value=${title} @input=${this._onTitle} />
        </label>
        <label class="field">
          <span>Service</span>
          <select @change=${this._onService}>
            <option value="" ?selected=${!service}>First running service</option>
            ${this._services.map(
              (s) =>
                html`<option value=${s.entry_id} ?selected=${service === s.entry_id}>
                  ${s.name}
                </option>`,
            )}
          </select>
        </label>
      </div>
    `;
  }

  static styles = css`
    .form {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 8px 0;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .field span {
      font-size: 0.85em;
      color: var(--secondary-text-color);
    }
    input,
    select {
      padding: 8px;
      border-radius: 4px;
      border: 1px solid var(--divider-color, #ccc);
      background: var(--card-background-color, #fff);
      color: var(--primary-text-color);
      font-size: 1em;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "not-a-plc-card-editor": NotAPlcCardEditor;
  }
}

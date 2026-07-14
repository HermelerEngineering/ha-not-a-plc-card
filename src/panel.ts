/**
 * `not-a-plc-panel` — the full-page editor panel.
 *
 * Registered as a Home Assistant sidebar panel by the integration (`panel_custom`
 * pointing at this bundle). It:
 *   - lists the running services and lets you pick one,
 *   - shows a LIVE preview of that service's program (reusing the card's render /
 *     power-flow layer, coloured by a `subscribe_state` stream),
 *   - lets you manage the tag table (phase 4.2): add/remove tags, rename them
 *     (rewriting every reference across the IR), change kind/type, bind an input
 *     to an entity via a self-contained `<input>` + `<datalist>` picker (with type
 *     inference from the entity domain), set a coil's optional `writes` target and
 *     a memory tag's `retain` flag — then save (`save_program`),
 *   - lets you manage *function-block instances* (phase 4.3): add/remove/rename
 *     them and edit their typed params (timer preset, counter PV + reset/load tag,
 *     latch reset tag), so timers/counters/latches/edges are usable without the DSL,
 *   - lets you edit the program *structure* (phase 4.3): add/remove/move networks
 *     and rungs (with titles), and per rung add/remove/move/edit the top-level
 *     series elements (contact, compare, fb reference) and coils via forms — then
 *     save (`save_program`),
 *   - keeps a lossless DSL text editor as an escape hatch (`save_program_text`).
 *
 * Editing the contents of a branch / NOT group (nested series) and the drag-drop
 * canvas land in later 4.x sub-phases; those stay editable via the DSL for now.
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
import {
  Coil,
  CoilMode,
  CompareEl,
  CompareOp,
  ContactEl,
  ContactMode,
  Element,
  FbRefEl,
  FunctionBlockDef,
  Network,
  Program,
  Rung,
  ServiceInfo,
  StateImage,
  TagDef,
  TagKind,
  TagType,
  isBranch,
  isCompare,
  isContact,
  isFb,
  isNot,
} from "./ir";
import {
  FB_TYPES,
  FbField,
  addFb,
  fbFields,
  isFbReferenced,
  removeFb,
  renameFb,
  setFbParam,
  setFbType,
} from "./fbs";
import {
  addCoil,
  addElement,
  addNetwork,
  addRung,
  moveElement,
  moveNetwork,
  moveRung,
  newCoil,
  newCompare,
  newContact,
  newFbRef,
  removeCoil,
  removeElement,
  removeNetwork,
  removeRung,
  setNetworkTitle,
  setRungTitle,
  updateCoil,
  updateElement,
} from "./elements";
import { computePowerFlow } from "./power-flow";
import { renderNetwork } from "./render";
import {
  BOOL_DOMAINS,
  REAL_DOMAINS,
  addTag,
  domainsForType,
  inferType,
  isTagReferenced,
  removeTag,
  renameTag,
  setKind,
  setTag,
} from "./tags";

const VIEW_WIDTH = 720;

const TAG_KINDS: TagKind[] = ["input", "coil", "memory", "temp"];
const TAG_TYPES: TagType[] = ["BOOL", "REAL", "TIME"];
const COIL_MODES: CoilMode[] = ["=", "S", "R"];
const CONTACT_MODES: ContactMode[] = ["NO", "NC"];
const COMPARE_OPS: CompareOp[] = ["GT", "GE", "LT", "LE", "EQ", "NE"];
const WRITABLE_KINDS = new Set<TagKind>(["coil", "memory", "temp"]);

// We build our own entity picker from `hass.states` because HA's
// `ha-entity-picker` is a lazy-loaded element that is not reliably defined
// inside a custom panel.

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

  private _update(program: Program): void {
    this._program = program;
    this._status = "Unsaved changes.";
  }

  private _setSource(name: string, value: string): void {
    if (!this._program) return;
    const tag = this._program.tags[name];
    // Binding an input entity infers the tag type from its domain (overridable).
    const type = value ? inferType(value) : tag.type;
    this._update(
      setTag(this._program, name, { ...tag, source: value || undefined, type }),
    );
  }

  private _setWrites(name: string, value: string): void {
    if (!this._program) return;
    const tag = this._program.tags[name];
    const writes = value ? { target: value } : undefined;
    this._update(setTag(this._program, name, { ...tag, writes }));
  }

  private _setRetain(name: string, retain: boolean): void {
    if (!this._program) return;
    const tag = this._program.tags[name];
    this._update(
      setTag(this._program, name, { ...tag, retain: retain || undefined }),
    );
  }

  private _setKind(name: string, kind: TagKind): void {
    if (!this._program) return;
    const tag = this._program.tags[name];
    this._update(setTag(this._program, name, setKind(tag, kind)));
  }

  private _setType(name: string, type: TagType): void {
    if (!this._program) return;
    const tag = this._program.tags[name];
    this._update(setTag(this._program, name, { ...tag, type }));
  }

  private _renameTag(oldName: string, newName: string): void {
    if (!this._program) return;
    newName = newName.trim();
    if (!newName || newName === oldName) return;
    if (newName in this._program.tags) {
      this._status = `A tag named '${newName}' already exists.`;
      this.requestUpdate();
      return;
    }
    this._update(renameTag(this._program, oldName, newName));
  }

  private _addTag(): void {
    if (!this._program) return;
    const { program } = addTag(this._program);
    this._update(program);
  }

  private _removeTag(name: string): void {
    if (!this._program) return;
    if (isTagReferenced(this._program, name)) {
      this._status = `Cannot delete '${name}': it is still used in the program.`;
      this.requestUpdate();
      return;
    }
    this._update(removeTag(this._program, name));
  }

  // --- structure editing (phase 4.3) ------------------------------------

  /** Apply a pure structure edit to the working program. */
  private _edit(fn: (p: Program) => Program): void {
    if (!this._program) return;
    this._update(fn(this._program));
  }

  private _tagNames(pred?: (t: TagDef) => boolean): string[] {
    if (!this._program) return [];
    return Object.entries(this._program.tags)
      .filter(([, t]) => (pred ? pred(t) : true))
      .map(([name]) => name);
  }

  private _fbNames(): string[] {
    return Object.keys(this._program?.fbs ?? {});
  }

  private _addFb(): void {
    if (!this._program) return;
    this._update(addFb(this._program).program);
  }

  private _removeFb(name: string): void {
    if (!this._program) return;
    if (isFbReferenced(this._program, name)) {
      this._status = `Cannot delete '${name}': it is still used in a rung.`;
      this.requestUpdate();
      return;
    }
    this._update(removeFb(this._program, name));
  }

  private _renameFb(oldName: string, newName: string): void {
    if (!this._program) return;
    newName = newName.trim();
    if (!newName || newName === oldName) return;
    if (newName in (this._program.fbs ?? {}) || newName in this._program.tags) {
      this._status = `The name '${newName}' is already taken.`;
      this.requestUpdate();
      return;
    }
    this._update(renameFb(this._program, oldName, newName));
  }

  private _setFbParam(name: string, field: FbField, raw: string): void {
    let value: number | string | undefined;
    if (raw === "") {
      value = undefined;
    } else if (field.kind === "int") {
      const n = parseInt(raw, 10);
      value = Number.isNaN(n) ? undefined : n;
    } else {
      value = raw;
    }
    this._edit((p) => setFbParam(p, name, field.key, value));
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
          ${this._renderFbs()}
          ${this._renderStructure()}
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
        <div class="tags-actions">
          <button class="secondary" @click=${this._addTag}>+ Add tag</button>
          <button @click=${this._saveProgram}>Save</button>
        </div>
      </div>
      <table class="tags">
        <thead>
          <tr>
            <th>Name</th>
            <th>Kind</th>
            <th>Type</th>
            <th>Binding</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${entries.map(([name, tag]) => this._renderTagRow(name, tag))}
        </tbody>
      </table>
      ${entries.length === 0
        ? html`<div class="hint">No tags yet — add one.</div>`
        : ""}
      ${this._datalists()}
    `;
  }

  private _renderTagRow(name: string, tag: TagDef): TemplateResult {
    const type: TagType = tag.type ?? "BOOL";
    return html`
      <tr>
        <td>
          <input
            class="name-input"
            .value=${name}
            @change=${(e: Event) =>
              this._renameTag(name, (e.target as HTMLInputElement).value)}
          />
        </td>
        <td>
          <select
            .value=${tag.kind}
            @change=${(e: Event) =>
              this._setKind(name, (e.target as HTMLSelectElement).value as TagKind)}
          >
            ${TAG_KINDS.map(
              (k) => html`<option value=${k} ?selected=${k === tag.kind}>${k}</option>`,
            )}
          </select>
        </td>
        <td>
          <select
            .value=${type}
            @change=${(e: Event) =>
              this._setType(name, (e.target as HTMLSelectElement).value as TagType)}
          >
            ${TAG_TYPES.map(
              (t) => html`<option value=${t} ?selected=${t === type}>${t}</option>`,
            )}
          </select>
        </td>
        <td>${this._renderBinding(name, tag)}</td>
        <td>
          <button
            class="icon"
            title="Delete tag"
            @click=${() => this._removeTag(name)}
          >
            ✕
          </button>
        </td>
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

  private _entityPicker(
    value: string,
    domains: string[],
    placeholder: string,
    onChange: (v: string) => void,
  ): TemplateResult {
    const listId = domains === REAL_DOMAINS ? "np-real-entities" : "np-bool-entities";
    return html`
      <input
        class="entity-input"
        list=${listId}
        .value=${value}
        placeholder=${placeholder}
        @change=${(e: Event) => onChange((e.target as HTMLInputElement).value)}
      />
    `;
  }

  private _renderBinding(name: string, tag: TagDef): TemplateResult {
    if (tag.kind === "input") {
      return this._entityPicker(
        tag.source ?? "",
        domainsForType(tag.type ?? "BOOL"),
        "entity_id",
        (v) => this._setSource(name, v),
      );
    }
    if (tag.kind === "coil") {
      return this._entityPicker(
        tag.writes?.target ?? "",
        BOOL_DOMAINS,
        "writes to… (optional)",
        (v) => this._setWrites(name, v),
      );
    }
    if (tag.kind === "memory") {
      return html`
        <label class="retain">
          <input
            type="checkbox"
            .checked=${tag.retain ?? false}
            @change=${(e: Event) =>
              this._setRetain(name, (e.target as HTMLInputElement).checked)}
          />
          retain across restart
        </label>
      `;
    }
    return html`<span class="muted">—</span>`;
  }

  // --- function-block instances -------------------------------------------

  private _renderFbs(): TemplateResult {
    if (!this._program) return html``;
    const entries = Object.entries(this._program.fbs ?? {});
    return html`
      <div class="tags-header">
        <h3>Function blocks</h3>
        <button class="secondary" @click=${this._addFb}>+ Block</button>
      </div>
      ${entries.map(([name, def]) => this._renderFbRow(name, def))}
      ${entries.length === 0
        ? html`<div class="hint">
            No function blocks. Add one to use timers, counters, latches or edge
            detection in a rung.
          </div>`
        : ""}
    `;
  }

  private _renderFbRow(name: string, def: FunctionBlockDef): TemplateResult {
    return html`
      <div class="fb-row">
        <input
          class="name-input"
          .value=${name}
          @change=${(e: Event) =>
            this._renameFb(name, (e.target as HTMLInputElement).value)}
        />
        <select
          .value=${def.type}
          @change=${(e: Event) =>
            this._edit((p) =>
              setFbType(p, name, (e.target as HTMLSelectElement).value),
            )}
        >
          ${FB_TYPES.map(
            (t) => html`<option value=${t} ?selected=${t === def.type}>${t}</option>`,
          )}
        </select>
        ${fbFields(def.type).map((field) => this._renderFbParam(name, def, field))}
        <span class="spacer"></span>
        <button
          class="icon"
          title="Delete block"
          @click=${() => this._removeFb(name)}
        >
          ✕
        </button>
      </div>
    `;
  }

  private _renderFbParam(
    name: string,
    def: FunctionBlockDef,
    field: FbField,
  ): TemplateResult {
    const raw = def[field.key];
    if (field.kind === "int") {
      return html`
        <label class="fb-param">
          ${field.label}
          <input
            type="number"
            min="1"
            .value=${raw === undefined ? "" : String(raw)}
            @change=${(e: Event) =>
              this._setFbParam(name, field, (e.target as HTMLInputElement).value)}
          />
        </label>
      `;
    }
    return html`
      <label class="fb-param">
        ${field.label}${field.optional ? "" : " *"}
        ${this._tagSelect(typeof raw === "string" ? raw : "", this._tagNames(), (v) =>
          this._edit((p) => setFbParam(p, name, field.key, v || undefined)),
        )}
      </label>
    `;
  }

  // --- structure editor ---------------------------------------------------

  private _renderStructure(): TemplateResult {
    if (!this._program) return html``;
    return html`
      <div class="tags-header">
        <h3>Program</h3>
        <div class="tags-actions">
          <button class="secondary" @click=${() => this._edit(addNetwork)}>
            + Network
          </button>
          <button @click=${this._saveProgram}>Save</button>
        </div>
      </div>
      ${this._program.networks.map((net, ni) => this._renderNetworkEditor(net, ni))}
      ${this._program.networks.length === 0
        ? html`<div class="hint">No networks yet — add one.</div>`
        : ""}
    `;
  }

  private _moveButtons(up: () => void, down: () => void): TemplateResult {
    return html`
      <button class="icon" title="Move up" @click=${up}>↑</button>
      <button class="icon" title="Move down" @click=${down}>↓</button>
    `;
  }

  private _renderNetworkEditor(net: Network, ni: number): TemplateResult {
    return html`
      <div class="net">
        <div class="net-head">
          <span class="chip-id">${net.id}</span>
          <input
            class="title-input"
            placeholder="network title"
            .value=${net.title ?? ""}
            @change=${(e: Event) =>
              this._edit((p) =>
                setNetworkTitle(p, ni, (e.target as HTMLInputElement).value),
              )}
          />
          <span class="spacer"></span>
          ${this._moveButtons(
            () => this._edit((p) => moveNetwork(p, ni, -1)),
            () => this._edit((p) => moveNetwork(p, ni, 1)),
          )}
          <button
            class="icon"
            title="Delete network"
            @click=${() => this._edit((p) => removeNetwork(p, ni))}
          >
            ✕
          </button>
        </div>
        ${net.rungs.map((rung, ri) => this._renderRungEditor(rung, ni, ri))}
        <button class="secondary small" @click=${() => this._edit((p) => addRung(p, ni))}>
          + Rung
        </button>
      </div>
    `;
  }

  private _renderRungEditor(rung: Rung, ni: number, ri: number): TemplateResult {
    return html`
      <div class="rung">
        <div class="rung-head">
          <span class="chip-id">${rung.id}</span>
          <input
            class="title-input"
            placeholder="rung title"
            .value=${rung.title ?? ""}
            @change=${(e: Event) =>
              this._edit((p) =>
                setRungTitle(p, ni, ri, (e.target as HTMLInputElement).value),
              )}
          />
          <span class="spacer"></span>
          ${this._moveButtons(
            () => this._edit((p) => moveRung(p, ni, ri, -1)),
            () => this._edit((p) => moveRung(p, ni, ri, 1)),
          )}
          <button
            class="icon"
            title="Delete rung"
            @click=${() => this._edit((p) => removeRung(p, ni, ri))}
          >
            ✕
          </button>
        </div>
        <div class="rung-body">
          <div class="col">
            <div class="col-label">Series (AND)</div>
            ${rung.series.map((el, ei) => this._renderSeriesElement(el, ni, ri, ei))}
            <div class="add-row">
              <button
                class="chip"
                @click=${() => this._edit((p) => addElement(p, ni, ri, newContact()))}
              >
                + Contact
              </button>
              <button
                class="chip"
                @click=${() => this._edit((p) => addElement(p, ni, ri, newCompare()))}
              >
                + Compare
              </button>
              ${this._fbNames().length
                ? html`<button
                    class="chip"
                    @click=${() =>
                      this._edit((p) =>
                        addElement(p, ni, ri, newFbRef(this._fbNames()[0])),
                      )}
                  >
                    + FB
                  </button>`
                : ""}
            </div>
          </div>
          <div class="col">
            <div class="col-label">Coils</div>
            ${rung.coils.map((c, ci) => this._renderCoilEditor(c, ni, ri, ci))}
            <div class="add-row">
              <button
                class="chip"
                @click=${() => this._edit((p) => addCoil(p, ni, ri, newCoil()))}
              >
                + Coil
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private _tagSelect(
    value: string,
    names: string[],
    onChange: (v: string) => void,
  ): TemplateResult {
    return html`
      <select
        .value=${value}
        @change=${(e: Event) => onChange((e.target as HTMLSelectElement).value)}
      >
        <option value="" ?selected=${value === ""}>—</option>
        ${names.map(
          (n) => html`<option value=${n} ?selected=${n === value}>${n}</option>`,
        )}
      </select>
    `;
  }

  private _elActions(ni: number, ri: number, ei: number): TemplateResult {
    return html`
      ${this._moveButtons(
        () => this._edit((p) => moveElement(p, ni, ri, ei, -1)),
        () => this._edit((p) => moveElement(p, ni, ri, ei, 1)),
      )}
      <button
        class="icon"
        title="Delete element"
        @click=${() => this._edit((p) => removeElement(p, ni, ri, ei))}
      >
        ✕
      </button>
    `;
  }

  private _renderSeriesElement(
    el: Element,
    ni: number,
    ri: number,
    ei: number,
  ): TemplateResult {
    const set = (next: Element) =>
      this._edit((p) => updateElement(p, ni, ri, ei, next));

    let body: TemplateResult;
    if (isContact(el)) {
      const c = el as ContactEl;
      body = html`
        <span class="el-type">contact</span>
        ${this._tagSelect(c.tag, this._tagNames(), (v) => set({ ...c, tag: v }))}
        <select
          .value=${c.mode ?? "NO"}
          @change=${(e: Event) =>
            set({ ...c, mode: (e.target as HTMLSelectElement).value as ContactMode })}
        >
          ${CONTACT_MODES.map(
            (m) =>
              html`<option value=${m} ?selected=${m === (c.mode ?? "NO")}>${m}</option>`,
          )}
        </select>
      `;
    } else if (isCompare(el)) {
      const c = el as CompareEl;
      body = html`
        <span class="el-type">compare</span>
        ${this._tagSelect(
          c.left,
          this._tagNames((t) => t.type === "REAL"),
          (v) => set({ ...c, left: v }),
        )}
        <select
          .value=${c.op}
          @change=${(e: Event) =>
            set({ ...c, op: (e.target as HTMLSelectElement).value as CompareOp })}
        >
          ${COMPARE_OPS.map(
            (o) => html`<option value=${o} ?selected=${o === c.op}>${o}</option>`,
          )}
        </select>
        <input
          class="right-input"
          .value=${String(c.right)}
          placeholder="value or tag"
          @change=${(e: Event) =>
            set({ ...c, right: this._parseRight((e.target as HTMLInputElement).value) })}
        />
      `;
    } else if (isFb(el)) {
      const f = el as FbRefEl;
      body = html`
        <span class="el-type">fb</span>
        ${this._tagSelect(f.instance, this._fbNames(), (v) =>
          set({ ...f, instance: v }),
        )}
      `;
    } else if (isBranch(el)) {
      body = html`<span class="el-type">branch</span>
        <span class="muted">edit nested paths via DSL</span>`;
    } else if (isNot(el)) {
      body = html`<span class="el-type">NOT</span>
        <span class="muted">edit inner series via DSL</span>`;
    } else {
      body = html`<span class="muted">unknown element</span>`;
    }

    return html`<div class="el-row">${body}<span class="spacer"></span>${this._elActions(ni, ri, ei)}</div>`;
  }

  private _parseRight(raw: string): number | string {
    const trimmed = raw.trim();
    const num = Number(trimmed);
    return trimmed !== "" && !Number.isNaN(num) ? num : raw;
  }

  private _renderCoilEditor(
    coil: Coil,
    ni: number,
    ri: number,
    ci: number,
  ): TemplateResult {
    const set = (next: Coil) => this._edit((p) => updateCoil(p, ni, ri, ci, next));
    return html`
      <div class="el-row">
        ${this._tagSelect(
          coil.tag,
          this._tagNames((t) => WRITABLE_KINDS.has(t.kind)),
          (v) => set({ ...coil, tag: v }),
        )}
        <select
          .value=${coil.mode ?? "="}
          @change=${(e: Event) =>
            set({ ...coil, mode: (e.target as HTMLSelectElement).value as CoilMode })}
        >
          ${COIL_MODES.map(
            (m) =>
              html`<option value=${m} ?selected=${m === (coil.mode ?? "=")}>${m}</option>`,
          )}
        </select>
        <span class="spacer"></span>
        <button
          class="icon"
          title="Delete coil"
          @click=${() => this._edit((p) => removeCoil(p, ni, ri, ci))}
        >
          ✕
        </button>
      </div>
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
    .tags-actions {
      display: flex;
      gap: 8px;
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
    table.tags input,
    table.tags select {
      font: inherit;
      color: var(--primary-text-color);
      background: var(--card-background-color, #fff);
      border: 1px solid var(--divider-color, #ccc);
      border-radius: 4px;
      padding: 4px 6px;
      box-sizing: border-box;
    }
    input.entity-input {
      width: 100%;
      min-width: 160px;
    }
    input.name-input {
      width: 100%;
      min-width: 110px;
    }
    label.retain {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--secondary-text-color);
      font-size: 0.9em;
    }
    label.retain input {
      width: auto;
      min-width: 0;
    }
    button.secondary {
      background: var(--secondary-background-color, #e0e0e0);
      color: var(--primary-text-color);
    }
    button.icon {
      background: none;
      color: var(--secondary-text-color);
      padding: 4px 8px;
      font-size: 1em;
    }
    button.icon:hover {
      color: var(--error-color, #db4437);
    }
    button.small {
      padding: 4px 10px;
      font-size: 0.85em;
      margin-top: 6px;
    }
    .net {
      border: 1px solid var(--divider-color, #ddd);
      border-radius: 8px;
      padding: 8px 10px;
      margin: 10px 0;
    }
    .net-head,
    .rung-head {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .chip-id {
      font-family: var(--code-font-family, monospace);
      font-size: 0.8em;
      color: var(--secondary-text-color);
      background: var(--secondary-background-color, #eee);
      border-radius: 4px;
      padding: 1px 6px;
    }
    .spacer {
      flex: 1;
    }
    .title-input {
      font: inherit;
      color: var(--primary-text-color);
      background: var(--card-background-color, #fff);
      border: 1px solid var(--divider-color, #ccc);
      border-radius: 4px;
      padding: 4px 6px;
      min-width: 120px;
    }
    .rung {
      border-left: 3px solid var(--divider-color, #ddd);
      padding: 6px 0 6px 10px;
      margin: 8px 0;
    }
    .rung-body {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 12px;
      margin-top: 6px;
    }
    @media (max-width: 700px) {
      .rung-body {
        grid-template-columns: 1fr;
      }
    }
    .col-label {
      font-size: 0.75em;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--secondary-text-color);
      margin-bottom: 4px;
    }
    .el-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 0;
    }
    .el-row select,
    .el-row input {
      font: inherit;
      color: var(--primary-text-color);
      background: var(--card-background-color, #fff);
      border: 1px solid var(--divider-color, #ccc);
      border-radius: 4px;
      padding: 3px 5px;
    }
    .el-type {
      font-size: 0.7em;
      text-transform: uppercase;
      color: var(--secondary-text-color);
      min-width: 48px;
    }
    .right-input {
      width: 90px;
    }
    .add-row {
      display: flex;
      gap: 6px;
      margin-top: 4px;
      flex-wrap: wrap;
    }
    button.chip {
      background: var(--secondary-background-color, #e8e8e8);
      color: var(--primary-text-color);
      padding: 3px 10px;
      font-size: 0.85em;
    }
    .fb-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 0;
      flex-wrap: wrap;
    }
    .fb-row select,
    .fb-row input {
      font: inherit;
      color: var(--primary-text-color);
      background: var(--card-background-color, #fff);
      border: 1px solid var(--divider-color, #ccc);
      border-radius: 4px;
      padding: 3px 5px;
    }
    .fb-param {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 0.85em;
      color: var(--secondary-text-color);
    }
    .fb-param input {
      width: 80px;
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

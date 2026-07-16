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
 *     inference from the entity domain), set a coil's optional `writes` target — a
 *     BOOL coil actuates turn_on/off, a REAL coil writes its value via a service +
 *     value_key (prefilled per target domain) — and a memory tag's `retain` flag,
 *     then save (`save_program`),
 *   - lets you manage *function-block instances* (phase 4.3): add/remove/rename
 *     them and edit their typed params (timer preset, counter PV + reset/load tag,
 *     latch reset tag), so timers/counters/latches/edges are usable without the DSL,
 *   - supports the REAL outputs MOVE (`dst := src`) and CALC (`dst := a <op> b`,
 *     `+ − × ÷`) — the analog counterparts of a coil, writing a REAL value into a
 *     REAL tag when the rung conducts (palette `:=` / `+ − × ÷` tools + inspector;
 *     rendered as a `dst := …` box),
 *   - lets you edit the program *structure* (phase 4.3): add/remove/move networks
 *     and rungs (with titles), and per rung add/remove/move/edit the series elements
 *     — contact, compare, fb reference, an inline NOT power inverter, and nested
 *     branch (OR) groups edited recursively to any depth — plus coils, all via
 *     forms, then save (`save_program`),
 *   - offers a click-to-place **canvas on the live ladder** (phase 4.4 stage B): the
 *     renderer draws transparent hit-targets over the real SVG diagram — arm a
 *     palette tool and click a ＋ slot to insert an element/coil, or click an element
 *     to select and edit it in an inspector (reusing the form editors). Pointer-drag
 *     gestures (stage C) build on the same hit-targets later,
 *   - keeps a lossless DSL text editor as an escape hatch (`save_program_text`).
 */

import {
  LitElement,
  SVGTemplateResult,
  TemplateResult,
  css,
  html,
  svg,
} from "lit";
import { property, state } from "lit/decorators.js";

import { defineOnce } from "./define";
import { HomeAssistant } from "./ha";
import {
  BranchEl,
  Coil,
  CoilMode,
  CompareEl,
  CompareOp,
  ContactEl,
  ContactMode,
  Element,
  CalcEl,
  CalcOp,
  FbRefEl,
  FunctionBlockDef,
  MoveEl,
  Network,
  Output,
  Program,
  Rung,
  ServiceInfo,
  StateImage,
  TagDef,
  TagKind,
  TagType,
  isBranch,
  isCalc,
  isCompare,
  isContact,
  isFb,
  isMove,
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
  SeriesStep,
  addCoil,
  addElementIn,
  addNetwork,
  addRung,
  insertCoil,
  insertElementIn,
  moveElementIn,
  moveNetwork,
  moveRung,
  newBranch,
  newCalc,
  newCoil,
  newCompare,
  newContact,
  newFbRef,
  newMove,
  newNot,
  removeCoil,
  removeElementIn,
  removeNetwork,
  removeRung,
  setNetworkTitle,
  setRungTitle,
  updateCoil,
  updateElementIn,
} from "./elements";
import { ToolTarget, nearestSlot, reorderDelta } from "./canvas";
import { computePowerFlow } from "./power-flow";
import { CanvasEdit, renderNetwork } from "./render";
import {
  BOOL_DOMAINS,
  REAL_DOMAINS,
  WRITE_DOMAINS,
  addTag,
  defaultRealWrite,
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
const CALC_OPS: CalcOp[] = ["ADD", "SUB", "MUL", "DIV"];
const CALC_SYMBOL: Record<CalcOp, string> = {
  ADD: "+",
  SUB: "−",
  MUL: "×",
  DIV: "÷",
};
const WRITABLE_KINDS = new Set<TagKind>(["coil", "memory", "temp"]);

// We build our own entity picker from `hass.states` because HA's
// `ha-entity-picker` is a lazy-loaded element that is not reliably defined
// inside a custom panel.

/** A canvas palette tool: arm it, then click a slot to place its element. */
interface Tool {
  label: string;
  target: ToolTarget;
  make: () => Element | Output;
}

/** What the canvas has selected for the inspector. */
type Selection =
  | { kind: "el"; ni: number; ri: number; steps: SeriesStep[]; ei: number }
  | { kind: "coil"; ni: number; ri: number; ci: number };

@defineOnce("not-a-plc-panel")
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
  @state() private _tool?: Tool;
  @state() private _sel?: Selection;
  /** In-progress top-level element drag (pointer-drag reorder, stage C). */
  @state() private _drag?: { ni: number; ri: number; ei: number; drop: number };

  private _unsub?: () => void;
  /** Per-rung insertion-slot x-positions reported by the renderer, `${ni}:${ri}`. */
  private _geom = new Map<string, number[]>();
  private _dragSvg: SVGSVGElement | null = null;
  private _dragStartX = 0;
  private _dragMoved = false;
  private readonly _onDragMove = (ev: PointerEvent) => this._dragMove(ev);
  private readonly _onDragUp = () => this._dragUp();

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
    window.removeEventListener("pointermove", this._onDragMove);
    window.removeEventListener("pointerup", this._onDragUp);
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
    this._sel = undefined;
    this._tool = undefined;
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
          <details open>
            <summary>Canvas editor (click-to-place)</summary>
            ${this._renderCanvas()}
          </details>
          <details>
            <summary>Structure editor (forms)</summary>
            ${this._renderStructure()}
          </details>
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
      <datalist id="np-write-entities">${options(WRITE_DOMAINS)}</datalist>
    `;
  }

  private _entityPicker(
    value: string,
    domains: string[],
    placeholder: string,
    onChange: (v: string) => void,
  ): TemplateResult {
    const listId =
      domains === REAL_DOMAINS
        ? "np-real-entities"
        : domains === WRITE_DOMAINS
          ? "np-write-entities"
          : "np-bool-entities";
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
      if ((tag.type ?? "BOOL") === "REAL") return this._renderRealWrite(name, tag);
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

  /** REAL coil: pick a target entity + the service/key that writes its value. */
  private _renderRealWrite(name: string, tag: TagDef): TemplateResult {
    const w = tag.writes;
    return html`
      <div class="real-write">
        ${this._entityPicker(
          w?.target ?? "",
          WRITE_DOMAINS,
          "writes to… (optional)",
          (v) => this._setRealWriteTarget(name, v),
        )}
        ${w
          ? html`
              <input
                class="entity-input"
                .value=${w.service ?? ""}
                placeholder="service (domain.service)"
                @change=${(e: Event) =>
                  this._setRealWriteField(name, "service", (e.target as HTMLInputElement).value)}
              />
              <input
                class="entity-input"
                .value=${w.value_key ?? ""}
                placeholder="value key"
                @change=${(e: Event) =>
                  this._setRealWriteField(name, "value_key", (e.target as HTMLInputElement).value)}
              />
            `
          : ""}
      </div>
    `;
  }

  private _setRealWriteTarget(name: string, target: string): void {
    if (!this._program) return;
    const tag = this._program.tags[name];
    if (!target) {
      this._update(setTag(this._program, name, { ...tag, writes: undefined }));
      return;
    }
    // Prefill the service/key from the target's domain unless already set.
    const preset = defaultRealWrite(target);
    const writes = {
      target,
      service: tag.writes?.service || preset.service || undefined,
      value_key: tag.writes?.value_key || preset.value_key || undefined,
    };
    this._update(setTag(this._program, name, { ...tag, writes }));
  }

  private _setRealWriteField(
    name: string,
    field: "service" | "value_key",
    value: string,
  ): void {
    if (!this._program) return;
    const tag = this._program.tags[name];
    if (!tag.writes) return;
    this._update(
      setTag(this._program, name, {
        ...tag,
        writes: { ...tag.writes, [field]: value || undefined },
      }),
    );
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
            ${this._renderSeries(rung.series, ni, ri, [])}
          </div>
          <div class="col">
            <div class="col-label">Outputs</div>
            ${rung.coils.map((c, ci) => this._renderCoilEditor(c, ni, ri, ci))}
            <div class="add-row">
              <button
                class="chip"
                @click=${() => this._edit((p) => addCoil(p, ni, ri, newCoil()))}
              >
                + Coil
              </button>
              <button
                class="chip"
                @click=${() => this._edit((p) => addCoil(p, ni, ri, newMove()))}
              >
                + Move
              </button>
              <button
                class="chip"
                @click=${() => this._edit((p) => addCoil(p, ni, ri, newCalc()))}
              >
                + Calc
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

  /** Render one series level (elements + an add toolbar); recurses for branch/NOT. */
  private _renderSeries(
    series: Element[],
    ni: number,
    ri: number,
    steps: SeriesStep[],
  ): TemplateResult {
    const add = (el: Element) =>
      this._edit((p) => addElementIn(p, ni, ri, steps, el));
    return html`
      ${series.map((el, ei) => this._renderSeriesElement(el, ni, ri, steps, ei))}
      <div class="add-row">
        <button class="chip" @click=${() => add(newContact())}>+ Contact</button>
        <button class="chip" @click=${() => add(newCompare())}>+ Compare</button>
        <button class="chip" @click=${() => add(newBranch())}>+ Branch</button>
        <button class="chip" @click=${() => add(newNot())}>+ NOT</button>
        ${steps.length === 0 && this._fbNames().length
          ? html`<button class="chip" @click=${() => add(newFbRef(this._fbNames()[0]))}>
              + FB
            </button>`
          : ""}
      </div>
    `;
  }

  private _elActions(
    ni: number,
    ri: number,
    steps: SeriesStep[],
    ei: number,
  ): TemplateResult {
    return html`
      ${this._moveButtons(
        () => this._edit((p) => moveElementIn(p, ni, ri, steps, ei, -1)),
        () => this._edit((p) => moveElementIn(p, ni, ri, steps, ei, 1)),
      )}
      <button
        class="icon"
        title="Delete element"
        @click=${() => this._edit((p) => removeElementIn(p, ni, ri, steps, ei))}
      >
        ✕
      </button>
    `;
  }

  private _removeBranchPath(
    ni: number,
    ri: number,
    steps: SeriesStep[],
    ei: number,
    branch: BranchEl,
    pi: number,
  ): void {
    if (branch.branch.length <= 1) {
      this._edit((p) => removeElementIn(p, ni, ri, steps, ei));
    } else {
      const next: BranchEl = { branch: branch.branch.filter((_, i) => i !== pi) };
      this._edit((p) => updateElementIn(p, ni, ri, steps, ei, next));
    }
  }

  private _renderSeriesElement(
    el: Element,
    ni: number,
    ri: number,
    steps: SeriesStep[],
    ei: number,
  ): TemplateResult {
    const set = (next: Element) =>
      this._edit((p) => updateElementIn(p, ni, ri, steps, ei, next));

    if (isBranch(el)) {
      const b = el as BranchEl;
      return html`
        <div class="nested">
          <div class="el-row">
            <span class="el-type">branch (OR)</span>
            <span class="spacer"></span>
            ${this._elActions(ni, ri, steps, ei)}
          </div>
          ${b.branch.map(
            (path, pi) => html`
              <div class="path">
                <div class="path-head">
                  <span class="path-label">path ${pi + 1}</span>
                  <button
                    class="icon"
                    title="Remove path"
                    @click=${() => this._removeBranchPath(ni, ri, steps, ei, b, pi)}
                  >
                    ✕
                  </button>
                </div>
                ${this._renderSeries(path, ni, ri, [...steps, { index: ei, path: pi }])}
              </div>
            `,
          )}
          <button class="chip" @click=${() => set({ branch: [...b.branch, []] })}>
            + Path
          </button>
        </div>
      `;
    }

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
    } else if (isNot(el)) {
      body = html`<span class="el-type">NOT</span>
        <span class="muted">inverts the running power</span>`;
    } else {
      body = html`<span class="muted">unknown element</span>`;
    }

    return html`<div class="el-row">${body}<span class="spacer"></span>${this._elActions(ni, ri, steps, ei)}</div>`;
  }

  private _parseRight(raw: string): number | string {
    const trimmed = raw.trim();
    const num = Number(trimmed);
    return trimmed !== "" && !Number.isNaN(num) ? num : raw;
  }

  private _renderCoilEditor(
    output: Output,
    ni: number,
    ri: number,
    ci: number,
  ): TemplateResult {
    const del = html`<span class="spacer"></span>
      <button
        class="icon"
        title="Delete output"
        @click=${() => this._edit((p) => removeCoil(p, ni, ri, ci))}
      >
        ✕
      </button>`;

    const realDst = this._tagNames(
      (t) => WRITABLE_KINDS.has(t.kind) && t.type === "REAL",
    );

    if (isMove(output)) {
      const set = (next: MoveEl) => this._edit((p) => updateCoil(p, ni, ri, ci, next));
      return html`
        <div class="el-row">
          <span class="el-type">move</span>
          ${this._tagSelect(output.dst, realDst, (v) => set({ ...output, dst: v }))}
          <span class="muted">:=</span>
          <input
            class="right-input"
            .value=${String(output.src)}
            placeholder="value or REAL tag"
            @change=${(e: Event) =>
              set({ ...output, src: this._parseRight((e.target as HTMLInputElement).value) })}
          />
          ${del}
        </div>
      `;
    }

    if (isCalc(output)) {
      const set = (next: CalcEl) => this._edit((p) => updateCoil(p, ni, ri, ci, next));
      return html`
        <div class="el-row">
          <span class="el-type">calc</span>
          ${this._tagSelect(output.dst, realDst, (v) => set({ ...output, dst: v }))}
          <span class="muted">:=</span>
          <input
            class="right-input"
            .value=${String(output.a)}
            placeholder="a"
            @change=${(e: Event) =>
              set({ ...output, a: this._parseRight((e.target as HTMLInputElement).value) })}
          />
          <select
            .value=${output.op}
            @change=${(e: Event) =>
              set({ ...output, op: (e.target as HTMLSelectElement).value as CalcOp })}
          >
            ${CALC_OPS.map(
              (o) =>
                html`<option value=${o} ?selected=${o === output.op}>
                  ${CALC_SYMBOL[o]}
                </option>`,
            )}
          </select>
          <input
            class="right-input"
            .value=${String(output.b)}
            placeholder="b"
            @change=${(e: Event) =>
              set({ ...output, b: this._parseRight((e.target as HTMLInputElement).value) })}
          />
          ${del}
        </div>
      `;
    }

    const coil = output;
    const set = (next: Coil) => this._edit((p) => updateCoil(p, ni, ri, ci, next));
    return html`
      <div class="el-row">
        ${this._tagSelect(
          coil.tag,
          this._tagNames((t) => WRITABLE_KINDS.has(t.kind) && (t.type ?? "BOOL") === "BOOL"),
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
        ${del}
      </div>
    `;
  }

  // --- click-to-place canvas (phase 4.4) ----------------------------------

  private _tools(): Tool[] {
    const tools: Tool[] = [
      { label: "] [", target: "element", make: () => newContact() },
      { label: "]/[", target: "element", make: () => newContact("", "NC") },
      { label: "[ > ]", target: "element", make: () => newCompare() },
      { label: "OR", target: "element", make: () => newBranch() },
      { label: "NOT", target: "element", make: () => newNot() },
      { label: "( )", target: "coil", make: () => newCoil() },
      { label: ":=", target: "coil", make: () => newMove() },
      ...CALC_OPS.map((op) => ({
        label: CALC_SYMBOL[op],
        target: "coil" as ToolTarget,
        make: () => newCalc(op),
      })),
    ];
    const fb = this._fbNames()[0];
    if (fb) {
      tools.splice(5, 0, {
        label: "FB",
        target: "element",
        make: () => newFbRef(fb),
      });
    }
    return tools;
  }

  private _armTool(tool?: Tool): void {
    this._tool = this._tool?.label === tool?.label ? undefined : tool;
    this._sel = undefined;
  }

  private _elementAt(
    ni: number,
    ri: number,
    steps: SeriesStep[],
    ei: number,
  ): Element | undefined {
    let series = this._program?.networks[ni]?.rungs[ri]?.series;
    for (const step of steps) {
      const el = series?.[step.index];
      if (!el || !isBranch(el)) return undefined;
      series = el.branch[step.path];
    }
    return series?.[ei];
  }

  private _placeElement(ni: number, ri: number, steps: SeriesStep[], index: number): void {
    const tool = this._tool;
    if (!this._program || tool?.target !== "element") return;
    const el = tool.make() as Element;
    this._update(insertElementIn(this._program, ni, ri, steps, index, el));
  }

  private _placeCoil(ni: number, ri: number, index: number): void {
    const tool = this._tool;
    if (!this._program || tool?.target !== "coil") return;
    const output = tool.make() as Output;
    this._update(insertCoil(this._program, ni, ri, index, output));
  }

  private _selectEl(ni: number, ri: number, steps: SeriesStep[], ei: number): void {
    if (this._tool) return; // placing, not selecting
    this._sel = { kind: "el", ni, ri, steps, ei };
  }

  private _selectCoil(ni: number, ri: number, ci: number): void {
    if (this._tool) return;
    this._sel = { kind: "coil", ni, ri, ci };
  }

  // --- pointer-drag reorder of top-level elements (stage C) ------------------

  private _elPointerDown(ni: number, ri: number, ei: number, ev: PointerEvent): void {
    // Only a plain left-button press in select mode starts a drag.
    if (this._tool || ev.button !== 0) return;
    // NB: `Element` here is the IR type, so reach the DOM node via `SVGElement`.
    const target = ev.target as SVGElement | null;
    this._dragSvg = target?.closest("svg") ?? null;
    this._dragStartX = ev.clientX;
    this._dragMoved = false;
    this._drag = { ni, ri, ei, drop: ei };
    window.addEventListener("pointermove", this._onDragMove);
    window.addEventListener("pointerup", this._onDragUp);
  }

  private _toUserX(svg: SVGSVGElement, clientX: number): number {
    const ctm = svg.getScreenCTM();
    if (!ctm) return clientX;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = 0;
    return pt.matrixTransform(ctm.inverse()).x;
  }

  private _dragMove(ev: PointerEvent): void {
    if (!this._drag || !this._dragSvg) return;
    if (Math.abs(ev.clientX - this._dragStartX) > 4) this._dragMoved = true;
    const slots = this._geom.get(`${this._drag.ni}:${this._drag.ri}`);
    if (!slots) return;
    const drop = nearestSlot(slots, this._toUserX(this._dragSvg, ev.clientX));
    if (drop !== this._drag.drop) this._drag = { ...this._drag, drop };
  }

  private _dragUp(): void {
    window.removeEventListener("pointermove", this._onDragMove);
    window.removeEventListener("pointerup", this._onDragUp);
    const d = this._drag;
    this._drag = undefined;
    this._dragSvg = null;
    if (!d) return;
    // Released without moving: treat as a plain click → select for the inspector.
    if (!this._dragMoved) {
      this._selectEl(d.ni, d.ri, [], d.ei);
      return;
    }
    const delta = reorderDelta(d.ei, d.drop);
    if (delta !== 0) {
      this._edit((p) => moveElementIn(p, d.ni, d.ri, [], d.ei, delta));
    }
  }

  private _renderCanvas(): TemplateResult {
    if (!this._program) return html``;
    return html`
      <div class="tags-header">
        <h3>Canvas <span class="beta">beta</span></h3>
        <div class="tags-actions">
          <button class="secondary" @click=${() => this._edit(addNetwork)}>
            + Network
          </button>
          <button @click=${this._saveProgram}>Save</button>
        </div>
      </div>
      <div class="palette">
        <span class="palette-label">Place:</span>
        ${this._tools().map(
          (t) => html`<button
            class="chip ${this._tool?.label === t.label ? "armed" : ""}"
            @click=${() => this._armTool(t)}
          >
            ${t.label}
          </button>`,
        )}
        <button
          class="chip ${this._tool ? "" : "armed"}"
          @click=${() => this._armTool(undefined)}
        >
          Select
        </button>
      </div>
      <div class="hint">
        ${this._tool
          ? `Click a ＋ slot to place “${this._tool.label}”.`
          : "Click an element to edit it below, or drag it to reorder."}
      </div>
      ${this._program.networks.map((net, ni) => this._renderCanvasNetwork(net, ni))}
      ${this._renderInspector()}
    `;
  }

  /** Build the interaction config the renderer wires its hit-targets to. */
  private _editConfig(ni: number): CanvasEdit {
    let selected: CanvasEdit["selected"];
    if (this._sel && this._sel.ni === ni) {
      selected =
        this._sel.kind === "el"
          ? { kind: "el", ni, ri: this._sel.ri, ei: this._sel.ei }
          : { kind: "coil", ni, ri: this._sel.ri, ci: this._sel.ci };
    }
    return {
      ni,
      armed: this._tool?.target ?? null,
      selected,
      drag:
        this._drag?.ni === ni
          ? { ri: this._drag.ri, ei: this._drag.ei, drop: this._drag.drop }
          : null,
      onInsertElement: (ri, index) => this._placeElement(ni, ri, [], index),
      onInsertCoil: (ri, index) => this._placeCoil(ni, ri, index),
      onSelectCoil: (ri, ci) => this._selectCoil(ni, ri, ci),
      onGeometry: (ri, slotXs) => this._geom.set(`${ni}:${ri}`, slotXs),
      onElementPointerDown: (ri, ei, ev) => this._elPointerDown(ni, ri, ei, ev),
    };
  }

  private _renderCanvasNetwork(net: Network, ni: number): TemplateResult {
    const flow = computePowerFlow(this._program!, this._stateImage);
    const rendered = renderNetwork(
      net,
      flow,
      VIEW_WIDTH,
      this._program!.fbs ?? {},
      this._stateImage,
      this._editConfig(ni),
    );
    return html`
      <div class="cv-net">
        <div class="cv-net-head">
          <span class="chip-id">${net.id}</span>
          ${net.title ? html`<span>${net.title}</span>` : ""}
          <span class="spacer"></span>
          <button class="secondary small" @click=${() => this._edit((p) => addRung(p, ni))}>
            + Rung
          </button>
          <button
            class="icon"
            title="Delete network"
            @click=${() => this._edit((p) => removeNetwork(p, ni))}
          >
            ✕
          </button>
        </div>
        <svg
          class="cv-svg ${this._tool ? "arming" : ""}"
          viewBox="0 0 ${VIEW_WIDTH} ${rendered.height}"
          width="100%"
          role="img"
        >
          ${rendered.part}
        </svg>
      </div>
    `;
  }

  private _renderInspector(): TemplateResult {
    if (!this._sel || !this._program) return html``;
    if (this._sel.kind === "el") {
      const { ni, ri, steps, ei } = this._sel;
      const el = this._elementAt(ni, ri, steps, ei);
      if (!el) return html``;
      return html`
        <div class="inspector">
          <div class="col-label">Selected element</div>
          ${this._renderSeriesElement(el, ni, ri, steps, ei)}
        </div>
      `;
    }
    const { ni, ri, ci } = this._sel;
    const coil = this._program.networks[ni]?.rungs[ri]?.coils[ci];
    if (!coil) return html``;
    return html`
      <div class="inspector">
        <div class="col-label">Selected coil</div>
        ${this._renderCoilEditor(coil, ni, ri, ci)}
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
    .real-write {
      display: flex;
      flex-direction: column;
      gap: 4px;
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
    .nested {
      border: 1px dashed var(--divider-color, #ccc);
      border-radius: 6px;
      padding: 4px 8px;
      margin: 4px 0;
    }
    .path {
      border-left: 2px solid var(--divider-color, #ddd);
      padding-left: 8px;
      margin: 4px 0 4px 6px;
    }
    .path-head {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .path-label {
      font-size: 0.72em;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--secondary-text-color);
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
    .beta {
      font-size: 0.6em;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-primary-color, #fff);
      background: var(--primary-color);
      border-radius: 4px;
      padding: 1px 5px;
      vertical-align: middle;
    }
    .palette {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      margin: 6px 0;
    }
    .palette-label {
      font-size: 0.8em;
      color: var(--secondary-text-color);
    }
    button.chip.armed {
      background: var(--primary-color);
      color: var(--text-primary-color, #fff);
      outline: 2px solid var(--primary-color);
    }
    .cv-net {
      border: 1px solid var(--divider-color, #ddd);
      border-radius: 8px;
      padding: 8px 10px;
      margin: 10px 0;
    }
    .cv-net-head {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }
    .cv-svg {
      display: block;
      margin-top: 4px;
    }
    /* Editor hit-targets overlaid on the ladder SVG. */
    .cv-svg .hit-el {
      fill: transparent;
      pointer-events: all;
      cursor: pointer;
    }
    .cv-svg .hit-el.drag-el {
      cursor: grab;
      touch-action: none;
    }
    .cv-svg .hit-el:hover {
      fill: color-mix(in srgb, var(--primary-color) 12%, transparent);
    }
    .cv-svg .hit-el.dragging {
      fill: color-mix(in srgb, var(--primary-color) 20%, transparent);
      cursor: grabbing;
    }
    .cv-svg .drop-indicator {
      stroke: var(--primary-color);
      stroke-width: 2.5;
      stroke-linecap: round;
      pointer-events: none;
    }
    .cv-svg .hit-el.sel {
      fill: color-mix(in srgb, var(--primary-color) 16%, transparent);
      stroke: var(--primary-color);
      stroke-width: 1.5;
    }
    .cv-svg .hit-slot {
      fill: color-mix(in srgb, var(--primary-color) 25%, transparent);
      stroke: var(--primary-color);
      stroke-width: 1;
      stroke-dasharray: 3 2;
      pointer-events: all;
      cursor: pointer;
    }
    .cv-svg .hit-slot:hover {
      fill: var(--primary-color);
    }
    .cv-svg .sel-outline {
      fill: none;
      stroke: var(--primary-color);
      stroke-width: 1.5;
    }
    .inspector {
      margin-top: 10px;
      padding: 8px 10px;
      border: 1px solid var(--primary-color);
      border-radius: 8px;
      background: color-mix(in srgb, var(--primary-color) 6%, transparent);
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

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

import { LitElement, TemplateResult, css, html } from "lit";
import { property, state } from "lit/decorators.js";

import {
  ACTION_SERVICES,
  actionEntity,
  actionSpec,
  actionValue,
  withEntity,
  withService,
  withValue,
} from "./actions";
import { defineOnce } from "./define";
import { formatDuration, parseDuration } from "./duration";
import { HomeAssistant } from "./ha";
import {
  BranchEl,
  Coil,
  CoilMode,
  CompareEl,
  CompareOp,
  ActionEl,
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
  isAction,
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
  fbOutputRefs,
  isFbReferenced,
  isSourceType,
  removeFb,
  renameFb,
  setFbParam,
  setFbType,
} from "./fbs";
import {
  SeriesStep,
  addBranchPath,
  addCoil,
  addElementIn,
  addNetwork,
  addRung,
  cloneElement,
  insertCoil,
  insertElementIn,
  moveCoilToRung,
  moveElementIn,
  moveElementToRung,
  moveNetwork,
  moveRung,
  newAction,
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
  wrapInBranch,
} from "./elements";
import {
  RungGeom,
  ToolTarget,
  hitRung,
  nearestTarget,
  reorderDelta,
  rungDropGap,
} from "./canvas";
import { computePowerFlow } from "./power-flow";
import { validateProgram } from "./validate";
import { sameSteps } from "./layout";
import { CanvasEdit, RUNG_GAP, renderNetwork } from "./render";
import {
  BOOL_DOMAINS,
  REAL_DOMAINS,
  WRITE_DOMAINS,
  addTag,
  defaultRealWrite,
  inferType,
  isTagReferenced,
  removeTag,
  renameTag,
  setKind,
  setTag,
} from "./tags";

const VIEW_WIDTH = 760;

const TAG_KINDS: TagKind[] = ["input", "coil", "memory", "temp"];
// Display labels for the tag-kind picker. The IR kind stays `coil`, but in the
// tag list "output" reads better since such a tag can also be REAL (not only a
// boolean coil). This relabel is scoped to the tag list only.
const TAG_KIND_LABELS: Record<TagKind, string> = {
  input: "input",
  coil: "output",
  memory: "memory",
  temp: "temp",
};
const TAG_TYPES: TagType[] = ["BOOL", "REAL", "TIME"];
const COIL_MODES: CoilMode[] = ["=", "S", "R"];
const CONTACT_MODES: ContactMode[] = ["NO", "NC"];
// Canvas zoom presets: a factor that multiplies the ladder's on-screen size, so
// large networks can be scaled down to fit (or up for readability).
const ZOOM_PRESETS: { label: string; factor: number }[] = [
  { label: "Small", factor: 0.7 },
  { label: "Medium", factor: 1 },
  { label: "Large", factor: 1.4 },
];
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
  /**
   * For a function-block tool: the block type to create. Placing such a tool
   * auto-creates a fresh instance of this type (no pre-declaration needed), so
   * `make` only returns a placeholder ref — `_elementFor` supplies the real one.
   */
  fbType?: string;
}

/** What the canvas has selected for the inspector. */
type Selection =
  | { kind: "el"; ni: number; ri: number; steps: SeriesStep[]; ei: number }
  | { kind: "coil"; ni: number; ri: number; ci: number };

/**
 * A readable message from a failed websocket command. HA rejects with a plain
 * `{ code, message }` object (not an Error), which `String(err)` renders as
 * "[object Object]" — pull the `message` out.
 */
function wsErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/** A stable identity for a place-drag target, to skip redundant re-renders. */
function placeKey(t?: { ni: number; ri: number; steps: SeriesStep[]; index: number }): string {
  if (!t) return "";
  const steps = t.steps.map((s) => `${s.index}.${s.path}`).join("-");
  return `${t.ni}|${t.ri}|${steps}|${t.index}`;
}

function coilTargetKey(t?: { ni: number; ri: number; gap: number }): string {
  return t ? `${t.ni}|${t.ri}|${t.gap}` : "";
}

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
  /** Collapse state of the (space-hungry) tag and function-block lists. */
  @state() private _tagsOpen = true;
  @state() private _fbsOpen = true;
  /** Canvas zoom factor (multiplies the SVG's on-screen size). */
  @state() private _zoom = 1;
  /** Whether the parameter popup is open (second click of the selection). */
  @state() private _modal = false;
  /**
   * In-progress element drag-reorder: the source element (ni/ri/steps/ei), whether
   * it has moved past the click threshold yet, and the resolved drop slot (any
   * insertion slot in the rung — top-level or inside a branch).
   */
  @state() private _drag?: {
    ni: number;
    ri: number;
    steps: SeriesStep[];
    ei: number;
    moved: boolean;
    // Whether a copy modifier (Ctrl/Cmd) is currently held: drop duplicates the
    // element instead of moving it.
    copy: boolean;
    // The resolved drop slot — any insertion slot in any rung/network (top-level
    // or inside a branch), so an element can be dragged across rungs.
    target?: { ni: number; ri: number; steps: SeriesStep[]; index: number };
  };
  /** In-progress rung reorder drag: source rung and the resolved drop gap. */
  @state() private _rungDrag?: {
    ni: number;
    ri: number;
    moved: boolean;
    drop?: number;
  };
  /** In-progress output drag: source output and the resolved target coil gap. */
  @state() private _coilDrag?: {
    ni: number;
    ri: number;
    ci: number;
    moved: boolean;
    // The resolved drop gap — the coil stack of any rung/network under the pointer.
    target?: { ni: number; ri: number; gap: number };
  };
  /** In-progress palette element being dragged onto the live view, and its target. */
  @state() private _placeTool?: Tool;
  @state() private _placeTarget?: {
    ni: number;
    ri: number;
    steps: SeriesStep[];
    index: number;
  };

  private _unsub?: () => void;
  /** Per-network rung geometry reported by the renderer (rebuilt each render). */
  private _geom = new Map<number, RungGeom[]>();
  private _dragStartX = 0;
  private _dragStartY = 0;
  private _placeStartX = 0;
  private _placeStartY = 0;
  private _placeMoved = false;
  private readonly _onDragMove = (ev: PointerEvent) => this._dragMove(ev);
  private readonly _onDragUp = (ev: PointerEvent) => this._dragUp(ev);
  private readonly _onRungMove = (ev: PointerEvent) => this._rungMove(ev);
  private readonly _onRungUp = () => this._rungUp();
  private _rungStartX = 0;
  private _rungStartY = 0;
  private readonly _onCoilMove = (ev: PointerEvent) => this._coilMove(ev);
  private readonly _onCoilUp = () => this._coilUp();
  private _coilStartX = 0;
  private _coilStartY = 0;
  private readonly _onPlaceMove = (ev: PointerEvent) => this._placeMove(ev);
  private readonly _onPlaceUp = () => this._placeUp();

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
    window.removeEventListener("pointermove", this._onPlaceMove);
    window.removeEventListener("pointerup", this._onPlaceUp);
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
    // An ambiguous domain (light/cover/…) returns null → keep the current type,
    // so picking e.g. a light for a REAL tag reading `brightness` stays REAL.
    const type = (value ? inferType(value) : null) ?? tag.type;
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

  private _setAttribute(name: string, value: string): void {
    if (!this._program) return;
    const tag = this._program.tags[name];
    this._update(
      setTag(this._program, name, { ...tag, attribute: value.trim() || undefined }),
    );
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

  /**
   * Everything valid on the numeric side of a compare: REAL tags plus each
   * function block's numeric outputs (`t1.ET`, `c1.CV`, `clock.TOD`, …). Without
   * the fb refs those were unreachable once operand entry became a dropdown.
   */
  private _realOperands(): string[] {
    const tags = this._tagNames((t) => t.type === "REAL");
    return this._program ? [...tags, ...fbOutputRefs(this._program)] : tags;
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
      this._status = `Error: ${wsErrorMessage(err)}`;
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
      this._status = `Error: ${wsErrorMessage(err)}`;
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
        <section class="define-block">
          ${this._renderTags()}
          ${this._renderFbs()}
        </section>
        <section class="toolbar-block">
          ${this._renderValidation()}
          ${this._renderCanvasControls()}
        </section>
        <section class="canvas-scroll">
          ${this._renderCanvasNetworks()}
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
        ${this._renderInspector()}
      </div>
    `;
  }

  private _renderTags(): TemplateResult {
    if (!this._program) return html`<div class="hint">Loading…</div>`;
    const entries = Object.entries(this._program.tags);
    return html`
      <div class="tags-header">
        <button
          class="collapse"
          @click=${() => (this._tagsOpen = !this._tagsOpen)}
        >
          <span class="chevron">${this._tagsOpen ? "▾" : "▸"}</span>
          Tags <span class="count">${entries.length}</span>
        </button>
        <div class="tags-actions">
          <button class="secondary" @click=${this._addTag}>+ Add tag</button>
          <button @click=${this._saveProgram}>Save</button>
        </div>
      </div>
      ${this._tagsOpen
        ? html`
            <div class="list-body">
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
            </div>
          `
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
              (k) =>
                html`<option value=${k} ?selected=${k === tag.kind}>
                  ${TAG_KIND_LABELS[k]}
                </option>`,
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

  private _entityIds(domains: string[] | null): string[] {
    const states = this.hass?.states ?? {};
    return Object.keys(states)
      .filter((id) => domains === null || domains.includes(id.split(".")[0]))
      .sort();
  }

  /** Attribute keys of a source entity, for the per-tag attribute dropdown. */
  private _attributeKeys(source: string | undefined): string[] {
    if (!source) return [];
    const attrs = this.hass?.states?.[source]?.attributes ?? {};
    return Object.keys(attrs).sort();
  }

  /** The string values of an entity's list-valued attribute (e.g. preset_modes). */
  private _stateOptions(entityId: string, attr: string): string[] {
    const raw = this.hass?.states?.[entityId]?.attributes?.[attr];
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
  }

  private _datalists(): TemplateResult {
    const options = (domains: string[]) =>
      this._entityIds(domains).map((id) => html`<option value=${id}></option>`);
    return html`
      <datalist id="np-real-entities">${options(REAL_DOMAINS)}</datalist>
      <datalist id="np-bool-entities">${options(BOOL_DOMAINS)}</datalist>
      <datalist id="np-write-entities">${options(WRITE_DOMAINS)}</datalist>
      <datalist id="np-all-entities">
        ${this._entityIds(null).map((id) => html`<option value=${id}></option>`)}
      </datalist>
    `;
  }

  private _entityPicker(
    value: string,
    domains: string[],
    placeholder: string,
    onChange: (v: string) => void,
    listId?: string,
  ): TemplateResult {
    const resolvedList =
      listId ??
      (domains === REAL_DOMAINS
        ? "np-real-entities"
        : domains === WRITE_DOMAINS
          ? "np-write-entities"
          : "np-bool-entities");
    return html`
      <input
        class="entity-input"
        list=${resolvedList}
        .value=${value}
        placeholder=${placeholder}
        @change=${(e: Event) => onChange((e.target as HTMLInputElement).value)}
      />
    `;
  }

  private _renderBinding(name: string, tag: TagDef): TemplateResult {
    if (tag.kind === "input") {
      return html`
        ${this._entityPicker(
          tag.source ?? "",
          [],
          "entity_id",
          (v) => this._setSource(name, v),
          "np-all-entities",
        )}
        <input
          class="attr-input"
          list="np-attr-${name}"
          .value=${tag.attribute ?? ""}
          placeholder="attribute (optional)"
          title="Read state.attributes[…] instead of the entity state"
          @change=${(e: Event) =>
            this._setAttribute(name, (e.target as HTMLInputElement).value)}
        />
        <datalist id="np-attr-${name}">
          ${this._attributeKeys(tag.source).map(
            (k) => html`<option value=${k}></option>`,
          )}
        </datalist>
      `;
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
        <button
          class="collapse"
          @click=${() => (this._fbsOpen = !this._fbsOpen)}
        >
          <span class="chevron">${this._fbsOpen ? "▾" : "▸"}</span>
          Function blocks <span class="count">${entries.length}</span>
        </button>
        <button class="secondary" @click=${this._addFb}>+ Block</button>
      </div>
      ${this._fbsOpen
        ? html`
            <div class="list-body">
              <table class="tags">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Parameters</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${entries.map(([name, def]) => this._renderFbRow(name, def))}
                </tbody>
              </table>
              ${entries.length === 0
                ? html`<div class="hint">
                    No function blocks. Add one to use timers, counters, latches
                    or edge detection in a rung — or just drag the FB tool onto a
                    rung and configure it there.
                  </div>`
                : ""}
            </div>
          `
        : ""}
    `;
  }

  private _renderFbRow(name: string, def: FunctionBlockDef): TemplateResult {
    const fields = fbFields(def.type);
    return html`
      <tr>
        <td>
          <input
            class="name-input"
            .value=${name}
            @change=${(e: Event) =>
              this._renameFb(name, (e.target as HTMLInputElement).value)}
          />
        </td>
        <td>
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
        </td>
        <td>
          <div class="fb-params">
            ${fields.length === 0
              ? html`<span class="muted">—</span>`
              : fields.map((field) => this._renderFbParam(name, def, field))}
          </div>
        </td>
        <td>
          <button
            class="icon"
            title="Delete block"
            @click=${() => this._removeFb(name)}
          >
            ✕
          </button>
        </td>
      </tr>
    `;
  }

  private _renderFbParam(
    name: string,
    def: FunctionBlockDef,
    field: FbField,
  ): TemplateResult {
    const raw = def[field.key];
    if (field.kind === "duration") {
      const ms = typeof raw === "number" ? raw : undefined;
      const shown = ms === undefined ? "" : formatDuration(ms);
      return html`
        <label class="fb-param">
          ${field.label}
          <input
            class="dur-input"
            .value=${shown}
            placeholder="5s"
            title="Duration — e.g. 500ms, 5s, 3m, 1h (a bare number means seconds)"
            @change=${(e: Event) => {
              const input = e.target as HTMLInputElement;
              const parsed = parseDuration(input.value);
              // Keep the previous value on a typo rather than clearing it.
              if (parsed === undefined) {
                input.value = shown;
                return;
              }
              this._edit((p) => setFbParam(p, name, field.key, parsed));
            }}
          />
        </label>
      `;
    }
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
      <button class="icon neutral" title="Move up" @click=${up}>↑</button>
      <button class="icon neutral" title="Move down" @click=${down}>↓</button>
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
              <button
                class="chip"
                @click=${() => this._edit((p) => addCoil(p, ni, ri, newAction()))}
              >
                + Service
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
        ${steps.length === 0
          ? html`<button class="chip" @click=${() => this._addFbElement(ni, ri, steps)}>
              + FB
            </button>`
          : ""}
      </div>
    `;
  }

  /** Add a fresh fb instance and an `fb` element referencing it (top level). */
  private _addFbElement(ni: number, ri: number, steps: SeriesStep[]): void {
    if (!this._program) return;
    const { program, name } = addFb(this._program);
    this._update(addElementIn(program, ni, ri, steps, newFbRef(name)));
  }

  private _elActions(
    ni: number,
    ri: number,
    steps: SeriesStep[],
    ei: number,
  ): TemplateResult {
    const el = this._elementAt(ni, ri, steps, ei);
    const canWrap = el !== undefined && !isBranch(el);
    return html`
      ${this._moveButtons(
        () => this._edit((p) => moveElementIn(p, ni, ri, steps, ei, -1)),
        () => this._edit((p) => moveElementIn(p, ni, ri, steps, ei, 1)),
      )}
      ${canWrap
        ? html`<button
            class="chip"
            title="Wrap this element in an OR branch"
            @click=${() => this._wrapInOr(ni, ri, steps, ei)}
          >
            Wrap OR
          </button>`
        : ""}
      <button
        class="icon"
        title="Delete element"
        @click=${() => this._edit((p) => removeElementIn(p, ni, ri, steps, ei))}
      >
        ✕
      </button>
    `;
  }

  /** Wrap the element at (steps, ei) in an OR branch; keep it selected. */
  private _wrapInOr(ni: number, ri: number, steps: SeriesStep[], ei: number): void {
    this._edit((p) => wrapInBranch(p, ni, ri, steps, ei));
    this._sel = { kind: "el", ni, ri, steps, ei };
  }

  /**
   * Select-then-OR: if `tool` is the OR/branch tool and a (non-branch) element is
   * currently selected, wrap that element in an OR branch and report handled.
   */
  private _maybeWrapSelection(tool: Tool): boolean {
    // The OR tool makes a branch; `tool.make()` is Element | Output, so narrow by
    // the `branch` property rather than isBranch (which wants an Element).
    if (tool.target !== "element" || !("branch" in tool.make())) return false;
    const s = this._sel;
    if (!this._program || s?.kind !== "el") return false;
    const el = this._elementAt(s.ni, s.ri, s.steps, s.ei);
    if (!el || isBranch(el)) return false;
    this._wrapInOr(s.ni, s.ri, s.steps, s.ei);
    return true;
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
        ${this._tagSelect(c.left, this._realOperands(), (v) => set({ ...c, left: v }))}
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

    if (isAction(output)) {
      return this._renderActionEditor(output, ni, ri, ci, del);
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

  private _renderActionEditor(
    output: ActionEl,
    ni: number,
    ri: number,
    ci: number,
    del: TemplateResult,
  ): TemplateResult {
    const set = (next: ActionEl) => this._edit((p) => updateCoil(p, ni, ri, ci, next));
    const spec = actionSpec(output.service);

    // A small <select>, including the current value even if it's off-list so it
    // is preserved and shown rather than silently dropped.
    const pick = (
      value: string,
      options: string[],
      placeholder: string,
      onChange: (v: string) => void,
    ): TemplateResult => {
      const opts = value && !options.includes(value) ? [value, ...options] : options;
      return html`
        <select
          .value=${value}
          @change=${(e: Event) => onChange((e.target as HTMLSelectElement).value)}
        >
          <option value="" ?selected=${!value}>${placeholder}</option>
          ${opts.map(
            (o) => html`<option value=${o} ?selected=${o === value}>${o}</option>`,
          )}
        </select>
      `;
    };

    const serviceSelect = html`
      <select
        title="Service to call on the rung's rising edge"
        .value=${spec ? output.service : "__custom__"}
        @change=${(e: Event) => {
          const v = (e.target as HTMLSelectElement).value;
          set(withService(output, v === "__custom__" ? "" : v));
        }}
      >
        ${ACTION_SERVICES.map(
          (s) =>
            html`<option value=${s.service} ?selected=${s.service === output.service}>
              ${s.label}
            </option>`,
        )}
        <option value="__custom__" ?selected=${!spec}>Custom…</option>
      </select>
    `;

    if (!spec) {
      // Custom / advanced: free service string + raw JSON data.
      const setData = (raw: string) => {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            set({ ...output, data: parsed as Record<string, unknown> });
          }
        } catch {
          /* keep the previous data until valid JSON is entered */
        }
      };
      return html`
        <div class="el-row">
          <span class="el-type">do</span>
          ${serviceSelect}
          <input
            class="right-input"
            .value=${output.service}
            placeholder="domain.service"
            @change=${(e: Event) =>
              set({ ...output, service: (e.target as HTMLInputElement).value.trim() })}
          />
          <input
            class="action-data"
            .value=${JSON.stringify(output.data)}
            placeholder='{"entity_id":"scene.movie"}'
            title="Static service data (JSON)"
            @change=${(e: Event) => setData((e.target as HTMLInputElement).value)}
          />
          ${del}
        </div>
      `;
    }

    const entity = actionEntity(output);
    const entitySelect = pick(
      entity,
      this._entityIds([spec.domain]),
      "entity…",
      (v) => set(withEntity(output, v)),
    );
    const valueSelect =
      spec.optionsAttr && spec.valueKey
        ? pick(
            actionValue(output, spec.valueKey),
            entity ? this._stateOptions(entity, spec.optionsAttr) : [],
            spec.valueKey,
            (v) => set(withValue(output, spec.valueKey!, v)),
          )
        : null;

    return html`
      <div class="el-row">
        <span class="el-type">do</span>
        ${serviceSelect} ${entitySelect} ${valueSelect ?? ""} ${del}
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
      { label: "do", target: "coil", make: () => newAction() },
    ];
    // One tool per function-block type, so a TON/CTU/… can be dragged straight
    // from the palette. Placing one auto-creates a fresh instance of that type
    // (no pre-declaration needed) and opens its popup to set the parameters.
    tools.splice(
      5,
      0,
      // Source blocks (CLOCK) are declared, never placed — no palette chip.
      ...FB_TYPES.filter((type) => !isSourceType(type)).map((type) => ({
        label: type,
        target: "element" as ToolTarget,
        make: () => newFbRef(""),
        fbType: type,
      })),
    );
    return tools;
  }

  /**
   * The element to insert for an armed element tool, plus the program it must be
   * inserted into. For the FB tool this auto-creates a fresh instance (default
   * type) — so an fb can be placed without pre-declaring — and returns a ref to
   * it; its type/params are then configured in the popup. Returns null for a
   * non-element tool.
   */
  private _elementFor(
    tool: Tool,
    program: Program,
  ): { program: Program; el: Element } | null {
    if (tool.target !== "element") return null;
    if (tool.fbType) {
      const { program: next, name } = addFb(program, tool.fbType);
      return { program: next, el: newFbRef(name) };
    }
    return { program, el: tool.make() as Element };
  }

  private _armTool(tool?: Tool): void {
    this._tool = this._tool?.label === tool?.label ? undefined : tool;
    this._sel = undefined;
    this._modal = false;
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
    if (!this._program || !tool) return;
    // A function block is only valid at the top level of a rung.
    if (tool.fbType && steps.length > 0) return;
    const made = this._elementFor(tool, this._program);
    if (!made) return;
    this._update(insertElementIn(made.program, ni, ri, steps, index, made.el));
    // Place-then-select: drop the tool and select the new element. A freshly-
    // placed FB opens its popup straight away so the new instance can be
    // configured; other elements use the two-click open.
    this._tool = undefined;
    this._sel = { kind: "el", ni, ri, steps, ei: index };
    this._modal = !!tool.fbType;
  }

  private _placeCoil(ni: number, ri: number, index: number): void {
    const tool = this._tool;
    if (!this._program || tool?.target !== "coil") return;
    const output = tool.make() as Output;
    this._update(insertCoil(this._program, ni, ri, index, output));
    this._tool = undefined;
    this._sel = { kind: "coil", ni, ri, ci: index };
    this._modal = false;
  }

  /**
   * Add a new OR-path to a branch. If an element tool is armed, seed the path
   * with that element (then switch to select mode on it); otherwise add an empty
   * path (fill it via its slots).
   */
  private _addBranchPath(ni: number, ri: number, steps: SeriesStep[], ei: number): void {
    if (!this._program) return;
    const tool = this._tool;
    const branch = this._elementAt(ni, ri, steps, ei);
    const pathIndex = branch && isBranch(branch) ? branch.branch.length : 0;
    // Seed the new path with the armed element — but not an FB (the model forbids
    // a function block inside a branch); for FB, add an empty path instead.
    if (tool && tool.target === "element" && !tool.fbType) {
      this._update(addBranchPath(this._program, ni, ri, steps, ei, [tool.make() as Element]));
      this._tool = undefined;
      this._sel = {
        kind: "el",
        ni,
        ri,
        steps: [...steps, { index: ei, path: pathIndex }],
        ei: 0,
      };
      this._modal = false;
    } else {
      this._update(addBranchPath(this._program, ni, ri, steps, ei, []));
    }
  }

  private _selectEl(ni: number, ri: number, steps: SeriesStep[], ei: number): void {
    if (this._tool) return; // placing, not selecting
    const s = this._sel;
    // First click selects (outline); a second click on the same element opens the
    // popup — so a plain click, and place-then-select, never trigger the modal.
    if (
      s?.kind === "el" &&
      s.ni === ni &&
      s.ri === ri &&
      s.ei === ei &&
      sameSteps(s.steps, steps)
    ) {
      this._modal = true;
      return;
    }
    this._sel = { kind: "el", ni, ri, steps, ei };
    this._modal = false;
  }

  private _selectCoil(ni: number, ri: number, ci: number): void {
    if (this._tool) return;
    const s = this._sel;
    if (s?.kind === "coil" && s.ni === ni && s.ri === ri && s.ci === ci) {
      this._modal = true;
      return;
    }
    this._sel = { kind: "coil", ni, ri, ci };
    this._modal = false;
  }

  // --- pointer-drag reorder of elements (top-level or into/within a branch) ---

  private _elPointerDown(
    ni: number,
    ri: number,
    steps: SeriesStep[],
    ei: number,
    ev: PointerEvent,
  ): void {
    // Only a plain left-button press in select mode starts a drag.
    if (this._tool || ev.button !== 0) return;
    this._dragStartX = ev.clientX;
    this._dragStartY = ev.clientY;
    this._drag = { ni, ri, steps, ei, moved: false, copy: ev.ctrlKey || ev.metaKey };
    window.addEventListener("pointermove", this._onDragMove);
    window.addEventListener("pointerup", this._onDragUp);
  }

  private _toUserXY(
    svg: SVGSVGElement,
    clientX: number,
    clientY: number,
  ): { x: number; y: number } {
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: clientX, y: clientY };
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  private _dragMove(ev: PointerEvent): void {
    const d = this._drag;
    if (!d) return;
    let moved = d.moved;
    if (
      !moved &&
      (Math.abs(ev.clientX - this._dragStartX) > 4 ||
        Math.abs(ev.clientY - this._dragStartY) > 4)
    ) {
      moved = true;
    }
    // Resolve the drop slot in whatever network/rung is under the pointer, so an
    // element can be dragged to another rung (even in another network). Nearest x
    // within a slot's y-band; top-level or inside a branch.
    let target = d.target;
    const svg = this._canvasUnder(ev.clientX, ev.clientY);
    const ni = svg ? Number(svg.dataset.ni) : NaN;
    const geoms = svg ? this._geom.get(ni) : undefined;
    if (svg && geoms) {
      const { x, y } = this._toUserXY(svg, ev.clientX, ev.clientY);
      const all = geoms.flatMap((g) => g.targets.map((t) => ({ ...t, ri: g.ri })));
      const t = nearestTarget(all, x, y);
      target = t ? { ni, ri: t.ri, steps: t.steps, index: t.index } : undefined;
    } else {
      target = undefined;
    }
    const copy = ev.ctrlKey || ev.metaKey;
    if (moved !== d.moved || copy !== d.copy || placeKey(target) !== placeKey(d.target)) {
      this._drag = { ...d, moved, copy, target };
    }
  }

  private _dragUp(ev: PointerEvent): void {
    window.removeEventListener("pointermove", this._onDragMove);
    window.removeEventListener("pointerup", this._onDragUp);
    const d = this._drag;
    this._drag = undefined;
    if (!d) return;
    // Released without moving: treat as a plain click → select (first click) or
    // open the popup (second click of the same element).
    if (!d.moved) {
      this._selectEl(d.ni, d.ri, d.steps, d.ei);
      return;
    }
    if (!d.target) return;
    const to = d.target;
    if (ev.ctrlKey || ev.metaKey) {
      // Ctrl/Cmd held: duplicate the element at the drop slot, leaving the
      // original in place. An fb element gets a fresh instance of the same type
      // (so the copy is an independent block, matching place-an-fb).
      this._duplicateElement(d, to);
    } else {
      this._edit((p) =>
        moveElementToRung(p, { ni: d.ni, ri: d.ri, steps: d.steps, ei: d.ei }, to),
      );
    }
    // Clear selection: the old position may no longer point at this element.
    this._sel = undefined;
  }

  private _duplicateElement(
    from: { ni: number; ri: number; steps: SeriesStep[]; ei: number },
    to: { ni: number; ri: number; steps: SeriesStep[]; index: number },
  ): void {
    if (!this._program) return;
    const src = this._elementAt(from.ni, from.ri, from.steps, from.ei);
    if (!src) return;
    this._edit((p) => {
      let prog = p;
      let copy = cloneElement(src);
      if (isFb(copy)) {
        const type = prog.fbs?.[(copy as FbRefEl).instance]?.type;
        const { program: next, name } = addFb(prog, type);
        prog = next;
        copy = { ...(copy as FbRefEl), instance: name };
      }
      return insertElementIn(prog, to.ni, to.ri, to.steps, to.index, copy);
    });
  }

  // --- reorder rungs by dragging their handle --------------------------------

  private _rungPointerDown(ni: number, ri: number, ev: PointerEvent): void {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    this._rungStartX = ev.clientX;
    this._rungStartY = ev.clientY;
    this._rungDrag = { ni, ri, moved: false };
    window.addEventListener("pointermove", this._onRungMove);
    window.addEventListener("pointerup", this._onRungUp);
  }

  private _rungMove(ev: PointerEvent): void {
    const d = this._rungDrag;
    if (!d) return;
    let moved = d.moved;
    if (
      !moved &&
      (Math.abs(ev.clientX - this._rungStartX) > 4 ||
        Math.abs(ev.clientY - this._rungStartY) > 4)
    ) {
      moved = true;
    }
    // Rungs reorder within their own network; resolve the drop gap from the
    // pointer y over that network's rung bands.
    let drop = d.drop;
    const svg = this._canvasUnder(ev.clientX, ev.clientY);
    const geoms = svg && Number(svg.dataset.ni) === d.ni ? this._geom.get(d.ni) : undefined;
    if (svg && geoms) {
      const { y } = this._toUserXY(svg, ev.clientX, ev.clientY);
      drop = rungDropGap(geoms, y);
    }
    if (moved !== d.moved || drop !== d.drop) this._rungDrag = { ...d, moved, drop };
  }

  private _rungUp(): void {
    window.removeEventListener("pointermove", this._onRungMove);
    window.removeEventListener("pointerup", this._onRungUp);
    const d = this._rungDrag;
    this._rungDrag = undefined;
    if (!d || !d.moved || d.drop == null) return;
    const delta = reorderDelta(d.ri, d.drop);
    if (delta !== 0) this._edit((p) => moveRung(p, d.ni, d.ri, delta));
  }

  // --- reorder outputs by dragging them in the coil stack --------------------

  private _coilPointerDown(ni: number, ri: number, ci: number, ev: PointerEvent): void {
    if (this._tool || ev.button !== 0) return;
    this._coilStartX = ev.clientX;
    this._coilStartY = ev.clientY;
    this._coilDrag = { ni, ri, ci, moved: false };
    window.addEventListener("pointermove", this._onCoilMove);
    window.addEventListener("pointerup", this._onCoilUp);
  }

  private _coilMove(ev: PointerEvent): void {
    const d = this._coilDrag;
    if (!d) return;
    let moved = d.moved;
    if (
      !moved &&
      (Math.abs(ev.clientX - this._coilStartX) > 4 ||
        Math.abs(ev.clientY - this._coilStartY) > 4)
    ) {
      moved = true;
    }
    // Resolve the drop gap in the coil stack of whatever rung is under the pointer,
    // so an output can be dragged to another rung (even in another network): the
    // rung whose y-band contains the pointer, then the gap in its coil bands.
    let target = d.target;
    const svg = this._canvasUnder(ev.clientX, ev.clientY);
    const ni = svg ? Number(svg.dataset.ni) : NaN;
    const geoms = svg ? this._geom.get(ni) : undefined;
    if (svg && geoms) {
      const { y } = this._toUserXY(svg, ev.clientX, ev.clientY);
      const g = geoms.find((r) => y >= r.top && y <= r.bottom);
      if (g) {
        const bands = g.coilBands ?? [];
        const gap = bands.length
          ? rungDropGap(
              bands.map((b) => ({ ri: b.ci, top: b.top, bottom: b.bottom })),
              y,
            )
          : 0;
        target = { ni, ri: g.ri, gap };
      } else {
        target = undefined;
      }
    } else {
      target = undefined;
    }
    if (moved !== d.moved || coilTargetKey(target) !== coilTargetKey(d.target)) {
      this._coilDrag = { ...d, moved, target };
    }
  }

  private _coilUp(): void {
    window.removeEventListener("pointermove", this._onCoilMove);
    window.removeEventListener("pointerup", this._onCoilUp);
    const d = this._coilDrag;
    this._coilDrag = undefined;
    if (!d) return;
    // Released without moving: treat as a plain click → select / open the popup.
    if (!d.moved) {
      this._selectCoil(d.ni, d.ri, d.ci);
      return;
    }
    const to = d.target;
    if (!to) return;
    this._edit((p) =>
      moveCoilToRung(
        p,
        { ni: d.ni, ri: d.ri, ci: d.ci },
        { ni: to.ni, ri: to.ri, index: to.gap },
      ),
    );
    // Clear selection: the old position may no longer point at this output.
    this._sel = undefined;
  }

  // --- drag a new element from the palette onto the live view ----------------

  private _chipPointerDown(tool: Tool, ev: PointerEvent): void {
    if (ev.button !== 0) return;
    ev.preventDefault(); // don't start a text selection while dragging
    this._placeTool = tool;
    this._placeTarget = undefined;
    this._placeStartX = ev.clientX;
    this._placeStartY = ev.clientY;
    this._placeMoved = false;
    window.addEventListener("pointermove", this._onPlaceMove);
    window.addEventListener("pointerup", this._onPlaceUp);
  }

  /** The `<svg class="cv-svg">` under the pointer (in this panel's shadow root). */
  private _canvasUnder(clientX: number, clientY: number): SVGSVGElement | null {
    const node = this.shadowRoot?.elementFromPoint(clientX, clientY) ?? null;
    return (node?.closest("svg.cv-svg") as SVGSVGElement | null) ?? null;
  }

  private _placeMove(ev: PointerEvent): void {
    const tool = this._placeTool;
    if (!tool) return;
    if (
      Math.abs(ev.clientX - this._placeStartX) > 4 ||
      Math.abs(ev.clientY - this._placeStartY) > 4
    ) {
      this._placeMoved = true;
    }
    const svg = this._canvasUnder(ev.clientX, ev.clientY);
    const ni = svg ? Number(svg.dataset.ni) : NaN;
    const geoms = svg ? this._geom.get(ni) : undefined;
    if (!svg || !geoms) {
      if (this._placeTarget) this._placeTarget = undefined;
      return;
    }
    const { x, y } = this._toUserXY(svg, ev.clientX, ev.clientY);
    let next: typeof this._placeTarget;
    if (tool.target === "coil") {
      // A coil appends below the stack, past the rung's series band, so let a
      // coil drop reach down through the inter-rung gap.
      const hit = hitRung(geoms, x, y, RUNG_GAP);
      next = hit ? { ni, ri: hit.ri, steps: [], index: hit.index } : undefined;
    } else {
      // An element can land in any insertion slot, top-level or inside a branch.
      const all = geoms.flatMap((g) => g.targets.map((t) => ({ ...t, ri: g.ri })));
      const t = nearestTarget(all, x, y);
      next = t ? { ni, ri: t.ri, steps: t.steps, index: t.index } : undefined;
    }
    // Only re-render when the resolved target actually changes.
    if (placeKey(next) !== placeKey(this._placeTarget)) this._placeTarget = next;
  }

  private _placeUp(): void {
    window.removeEventListener("pointermove", this._onPlaceMove);
    window.removeEventListener("pointerup", this._onPlaceUp);
    const tool = this._placeTool;
    const target = this._placeTarget;
    this._placeTool = undefined;
    this._placeTarget = undefined;
    if (!tool) return;
    // A press-release without a drag behaves like the old click: arm the tool —
    // except pressing the OR tool while an element is selected wraps that element
    // in an OR branch (select-then-OR), matching the popup's "Wrap OR" action.
    if (!this._placeMoved) {
      if (!this._maybeWrapSelection(tool)) this._armTool(tool);
      return;
    }
    // A coil tool appends to the rung it was dropped on; an element tool inserts
    // at the resolved slot (which may be inside a branch path).
    if (target) {
      this._insertTool(tool, target.ni, target.ri, target.steps, target.index);
    }
  }

  /**
   * Insert a fresh element/coil from `tool` at a position in a rung, then select
   * it (place-then-configure). Coils ignore `steps` and append.
   */
  private _insertTool(
    tool: Tool,
    ni: number,
    ri: number,
    steps: SeriesStep[],
    index: number,
  ): void {
    if (!this._program) return;
    if (tool.target === "coil") {
      const coils = this._program.networks[ni]?.rungs[ri]?.coils.length ?? 0;
      const at = Math.min(index, coils);
      this._update(insertCoil(this._program, ni, ri, at, tool.make() as Output));
      this._sel = { kind: "coil", ni, ri, ci: at };
      this._modal = false;
    } else {
      // A function block is only valid at the top level of a rung.
      if (tool.fbType && steps.length > 0) return;
      const made = this._elementFor(tool, this._program);
      if (!made) return;
      this._update(insertElementIn(made.program, ni, ri, steps, index, made.el));
      this._sel = { kind: "el", ni, ri, steps, ei: index };
      // A dropped FB opens its popup to configure the new instance.
      this._modal = !!tool.fbType;
    }
  }

  /** The pinned canvas controls: title + actions, the palette, and the hint. */
  private _renderCanvasControls(): TemplateResult {
    if (!this._program) return html``;
    return html`
      <div class="tags-header">
        <h3>Canvas <span class="beta">beta</span></h3>
        <div class="tags-actions">
          <div class="zoom" role="group" aria-label="Canvas zoom">
            <span class="palette-label">Zoom:</span>
            ${ZOOM_PRESETS.map(
              (z) => html`<button
                class="seg ${this._zoom === z.factor ? "armed" : ""}"
                @click=${() => (this._zoom = z.factor)}
              >
                ${z.label}
              </button>`,
            )}
          </div>
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
            class="chip draggable ${t.fbType ? "fb" : ""}
              ${this._tool?.label === t.label ? "armed" : ""}
              ${this._placeTool?.label === t.label ? "dragging" : ""}"
            title=${t.fbType ? `Function block: ${t.fbType}` : t.label}
            @pointerdown=${(ev: PointerEvent) => this._chipPointerDown(t, ev)}
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
        ${this._placeTool
          ? `Drag onto a rung to place “${this._placeTool.label}”.`
          : this._tool
            ? `Drag a tool onto the ladder, or click a ＋ slot to place “${this._tool.label}”.`
            : "Drag a tool onto the ladder to add it. Click to select an element, click it again to edit; drag to move (across rungs too), Ctrl-drag to duplicate. Drag an output to reorder it in the coil stack; drag a rung's ⋮ handle to reorder rungs."}
      </div>
    `;
  }

  /** The scrollable ladder itself (one SVG per network). */
  private _renderCanvasNetworks(): TemplateResult {
    // Rebuilt from scratch by the renderer's onGeometry callbacks each render.
    this._geom = new Map();
    if (!this._program) return html``;
    return html`
      ${this._program.networks.map((net, ni) => this._renderCanvasNetwork(net, ni))}
    `;
  }

  /** Build the interaction config the renderer wires its hit-targets to. */
  private _editConfig(ni: number): CanvasEdit {
    let selected: CanvasEdit["selected"];
    if (this._sel && this._sel.ni === ni) {
      selected =
        this._sel.kind === "el"
          ? { kind: "el", ni, ri: this._sel.ri, steps: this._sel.steps, ei: this._sel.ei }
          : { kind: "coil", ni, ri: this._sel.ri, ci: this._sel.ci };
    }
    // An active reorder drag (past the click threshold) behaves like an armed
    // element tool for the overlay: every network shows insert slots (incl. inside
    // branches) so the element can be dropped in any rung, and the target network
    // highlights the resolved drop slot.
    const reordering = this._drag?.moved ?? false;
    let placeDrop: CanvasEdit["placeDrop"] = null;
    const pt = this._placeTarget;
    const dt = this._drag?.target;
    if (this._placeTool?.target === "element" && pt && pt.ni === ni) {
      placeDrop = { ri: pt.ri, steps: pt.steps, index: pt.index };
    } else if (reordering && dt && dt.ni === ni) {
      placeDrop = { ri: dt.ri, steps: dt.steps, index: dt.index };
    }
    // Positions flagged by validation (this network only), to tint red on the view.
    const issues = this._program ? validateProgram(this._program) : [];
    const netErrors = issues.filter((i) => i.level === "error" && i.ni === ni);
    const errorEls = netErrors
      .filter((i) => i.steps !== undefined && i.ei !== undefined)
      .map((i) => ({ ri: i.ri, steps: i.steps!, ei: i.ei! }));
    const errorCoils = netErrors
      .filter((i) => i.ci !== undefined)
      .map((i) => ({ ri: i.ri, ci: i.ci! }));
    return {
      ni,
      // While dragging a palette tool or reordering an element, arm "element" so the
      // insert slots show (the active drag wins over any persistently armed tool).
      armed:
        this._placeTool?.target ?? this._tool?.target ?? (reordering ? "element" : null),
      selected,
      dragSource:
        // Don't ghost the source while copying (Ctrl/Cmd) — the original stays.
        this._drag?.ni === ni && !this._drag?.copy
          ? { ri: this._drag.ri, steps: this._drag.steps, ei: this._drag.ei }
          : null,
      placeDrop,
      errorEls,
      errorCoils,
      // Show nested insert slots for a persistently armed element tool, a palette
      // element drag, or a reorder drag (so it can land inside a branch) — but not
      // for the FB tool, since the model forbids a function block inside a branch.
      allowNestedInsert:
        (this._tool?.target === "element" && !this._tool?.fbType) ||
        (this._placeTool?.target === "element" && !this._placeTool?.fbType) ||
        reordering,
      onInsertElement: (ri, steps, index) => this._placeElement(ni, ri, steps, index),
      onSelectElement: (ri, steps, ei) => this._selectEl(ni, ri, steps, ei),
      onAddPath: (ri, steps, ei) => this._addBranchPath(ni, ri, steps, ei),
      onInsertCoil: (ri, index) => this._placeCoil(ni, ri, index),
      onSelectCoil: (ri, ci) => this._selectCoil(ni, ri, ci),
      onCoilPointerDown: (ri, ci, ev) => this._coilPointerDown(ni, ri, ci, ev),
      coilDrag:
        this._coilDrag?.moved && this._coilDrag.target?.ni === ni
          ? { ri: this._coilDrag.target.ri, gap: this._coilDrag.target.gap }
          : null,
      coilDragSource:
        this._coilDrag?.moved && this._coilDrag.ni === ni
          ? { ri: this._coilDrag.ri, ci: this._coilDrag.ci }
          : null,
      onRungPointerDown: (ri, ev) => this._rungPointerDown(ni, ri, ev),
      rungDrop:
        this._rungDrag?.moved && this._rungDrag.ni === ni ? this._rungDrag.drop ?? null : null,
      onRungTitle: (ri, title) => this._edit((p) => setRungTitle(p, ni, ri, title)),
      onGeometry: (ri, geom) => {
        const arr = this._geom.get(ni) ?? [];
        arr.push({ ri, ...geom });
        this._geom.set(ni, arr);
      },
      onElementPointerDown: (ri, steps, ei, ev) =>
        this._elPointerDown(ni, ri, steps, ei, ev),
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
          <input
            class="net-title-input"
            .value=${net.title ?? ""}
            placeholder="network name"
            @change=${(e: Event) =>
              this._edit((p) =>
                setNetworkTitle(p, ni, (e.target as HTMLInputElement).value),
              )}
          />
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
          class="cv-svg ${this._tool || this._placeTool ? "arming" : ""}"
          data-ni=${ni}
          viewBox="0 0 ${rendered.width} ${rendered.height}"
          width=${rendered.width * this._zoom}
          height=${rendered.height * this._zoom}
          role="img"
        >
          ${rendered.part}
        </svg>
      </div>
    `;
  }

  /**
   * The parameter editor for the selected element/coil, shown as a modal popup
   * over the canvas. For a function-block element it also embeds the referenced
   * instance's parameters (type + preset/PV/reset/…) so they can be changed here
   * without going to the separate "Function blocks" section.
   */
  private _renderInspector(): TemplateResult {
    if (!this._sel || !this._modal || !this._program) return html``;
    let title: string;
    let body: TemplateResult;
    if (this._sel.kind === "el") {
      const { ni, ri, steps, ei } = this._sel;
      const el = this._elementAt(ni, ri, steps, ei);
      if (!el) return html``;
      title = this._elementTitle(el);
      body = html`
        ${this._renderSeriesElement(el, ni, ri, steps, ei)}
        ${isFb(el) ? this._renderFbInstancePanel((el as FbRefEl).instance) : ""}
      `;
    } else {
      const { ni, ri, ci } = this._sel;
      const coil = this._program.networks[ni]?.rungs[ri]?.coils[ci];
      if (!coil) return html``;
      title = this._coilTitle(coil);
      body = this._renderCoilEditor(coil, ni, ri, ci);
    }
    return html`
      <div class="modal-backdrop" @click=${() => this._closeInspector()}>
        <div
          class="modal"
          role="dialog"
          aria-label=${title}
          @click=${(e: Event) => e.stopPropagation()}
        >
          <div class="modal-head">
            <span class="modal-title">${title}</span>
            <span class="spacer"></span>
            <button
              class="icon neutral"
              title="Close"
              @click=${() => this._closeInspector()}
            >
              ✕
            </button>
          </div>
          <div class="modal-body">${body}</div>
        </div>
      </div>
    `;
  }

  private _closeInspector(): void {
    // Close the popup but keep the element selected (outlined); click it again to
    // reopen.
    this._modal = false;
  }

  private _elementTitle(el: Element): string {
    if (isContact(el)) return "Contact";
    if (isCompare(el)) return "Compare";
    if (isFb(el)) return `Function block: ${(el as FbRefEl).instance}`;
    if (isNot(el)) return "NOT (inverter)";
    if (isBranch(el)) return "Branch (OR)";
    return "Element";
  }

  private _coilTitle(output: Output): string {
    if (isMove(output)) return "Move ( := )";
    if (isCalc(output)) return "Calc";
    if (isAction(output)) return "Service call";
    return "Coil";
  }

  /** Type + parameter editor for the fb instance an `fb` element references. */
  private _renderFbInstancePanel(name: string): TemplateResult {
    const def = this._program?.fbs?.[name];
    if (!def) return html``;
    const fields = fbFields(def.type);
    return html`
      <div class="modal-section">
        <div class="col-label">Block parameters</div>
        <div class="fb-params">
          <label class="fb-param">
            type
            <select
              .value=${def.type}
              @change=${(e: Event) =>
                this._edit((p) =>
                  setFbType(p, name, (e.target as HTMLSelectElement).value),
                )}
            >
              ${FB_TYPES.map(
                (t) =>
                  html`<option value=${t} ?selected=${t === def.type}>${t}</option>`,
              )}
            </select>
          </label>
          ${fields.map((field) => this._renderFbParam(name, def, field))}
        </div>
        ${fields.length === 0
          ? html`<div class="muted">This block type has no parameters.</div>`
          : ""}
      </div>
    `;
  }

  private _renderValidation(): TemplateResult {
    if (!this._program) return html``;
    const issues = validateProgram(this._program);
    if (issues.length === 0) {
      return html`<div class="validation ok">✓ No problems found</div>`;
    }
    const errors = issues.filter((i) => i.level === "error").length;
    const warns = issues.length - errors;
    const summary = [
      errors ? `${errors} error${errors > 1 ? "s" : ""}` : "",
      warns ? `${warns} warning${warns > 1 ? "s" : ""}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    return html`
      <details class="validation bad" open>
        <summary>${summary} — fix before saving</summary>
        <ul>
          ${issues.map(
            (i) => html`<li class="v-${i.level}">
              <span class="v-loc">${i.location}</span> ${i.message}
            </li>`,
          )}
        </ul>
      </details>
    `;
  }

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--primary-background-color);
      color: var(--primary-text-color);
    }
    .topbar {
      flex: 0 0 auto;
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
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 16px;
      overflow: hidden;
    }
    section {
      background: var(--card-background-color, #fff);
      border-radius: 8px;
      padding: 12px;
    }
    /* Three stacked blocks: (1) tag/FB definition, (2) the toolbar, (3) the
       scrolling canvas. The first two keep their natural height (pinned); the
       lists inside block 1 cap their own height so block 2's palette stays
       visible above the scrolling ladder. */
    .define-block,
    .toolbar-block {
      flex: 0 0 auto;
    }
    /* A long tag/FB list scrolls within its own capped area so it never pushes
       the palette below the fold. */
    .list-body {
      max-height: 30vh;
      overflow-y: auto;
    }
    /* The ladder scrolls independently below the pinned controls. */
    .canvas-scroll {
      flex: 1;
      min-height: 0;
      overflow: auto;
    }
    .tags-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    /* A section heading that toggles its list open/closed. */
    button.collapse {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: none;
      border: none;
      padding: 4px 0;
      margin: 0;
      font-size: 1.05em;
      font-weight: 500;
      color: var(--primary-text-color);
      cursor: pointer;
    }
    button.collapse .chevron {
      width: 1em;
      color: var(--secondary-text-color);
    }
    button.collapse .count {
      color: var(--secondary-text-color);
      font-weight: 400;
      font-size: 0.85em;
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
    input.attr-input {
      width: 100%;
      min-width: 160px;
      margin-top: 4px;
      font: inherit;
      color: var(--primary-text-color);
      background: var(--card-background-color, #fff);
      border: 1px solid var(--divider-color, #ccc);
      border-radius: 4px;
      padding: 4px 6px;
      box-sizing: border-box;
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
    /* Icon buttons are destructive (delete/remove) by default, so they read red
       to distinguish them from neutral actions like the modal close or reorder. */
    button.icon {
      background: none;
      color: var(--error-color, #db4437);
      padding: 4px 8px;
      font-size: 1em;
    }
    button.icon:hover {
      color: var(--error-color, #db4437);
      opacity: 0.75;
    }
    button.icon.neutral {
      color: var(--secondary-text-color);
    }
    button.icon.neutral:hover {
      color: var(--primary-text-color);
      opacity: 1;
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
    /* Network name, editable next to the id chip (the SVG omits it in the editor). */
    .net-title-input {
      font: inherit;
      font-weight: 600;
      color: var(--primary-text-color);
      background: transparent;
      border: 1px solid transparent;
      border-radius: 4px;
      padding: 2px 6px;
      min-width: 8em;
    }
    .net-title-input:hover,
    .net-title-input:focus {
      border-color: var(--divider-color, #ccc);
      background: var(--card-background-color, #fff);
    }
    /* Inline rung-title input drawn in the SVG (via foreignObject) in the editor. */
    .rung-title-input {
      font: inherit;
      font-size: 12px;
      color: var(--secondary-text-color);
      background: transparent;
      border: 1px solid transparent;
      border-radius: 4px;
      padding: 1px 4px;
      width: 96%;
      box-sizing: border-box;
    }
    .rung-title-input:hover,
    .rung-title-input:focus {
      border-color: var(--divider-color, #ccc);
      background: var(--card-background-color, #fff);
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
    .action-data {
      flex: 1;
      min-width: 180px;
      font-family: var(--code-font-family, monospace);
      font-size: 0.85em;
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
    .fb-params {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .fb-params select,
    .fb-params input {
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
    .zoom {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .zoom button.seg {
      padding: 4px 8px;
      font-size: 0.85em;
    }
    .zoom button.seg.armed {
      background: var(--primary-color);
      color: var(--text-primary-color, #fff);
      border-color: var(--primary-color);
    }
    button.chip.armed {
      background: var(--primary-color);
      color: var(--text-primary-color, #fff);
      outline: 2px solid var(--primary-color);
    }
    /* All palette buttons (the draggable tools and Select) are the same square. */
    .palette button.chip {
      width: 46px;
      height: 46px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
    }
    button.chip.draggable {
      cursor: grab;
      touch-action: none;
    }
    /* Function-block chips carry longer labels (R_TRIG, F_TRIG) — shrink to fit. */
    .palette button.chip.fb {
      font-size: 10px;
      letter-spacing: -0.2px;
    }
    button.chip.dragging {
      cursor: grabbing;
      outline: 2px dashed var(--primary-color);
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
    /* Dragging elements/outputs/rungs across the ladder would otherwise sweep-select
       the SVG text labels (and network headers between networks); suppress native
       text selection across the whole canvas. The two inline title inputs re-enable
       it so they stay editable. */
    .canvas-scroll {
      user-select: none;
      -webkit-user-select: none;
    }
    .canvas-scroll .rung-title-input,
    .canvas-scroll .net-title-input {
      user-select: text;
      -webkit-user-select: text;
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
    .cv-svg .add-path {
      cursor: pointer;
    }
    .cv-svg .add-path circle {
      fill: var(--card-background-color, #fff);
      stroke: var(--primary-color);
      stroke-width: 1.5;
    }
    .cv-svg .add-path text {
      fill: var(--primary-color);
      text-anchor: middle;
      font-size: 15px;
      font-weight: 700;
      pointer-events: none;
    }
    .cv-svg .add-path:hover circle {
      fill: color-mix(in srgb, var(--primary-color) 18%, transparent);
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
    .cv-svg .hit-slot.targeted {
      fill: var(--primary-color);
      stroke-dasharray: none;
    }
    .cv-svg .sel-outline {
      fill: none;
      stroke: var(--primary-color);
      stroke-width: 1.5;
    }
    .cv-svg .err-cell {
      fill: color-mix(in srgb, var(--error-color, #c62828) 22%, transparent);
      pointer-events: none;
    }
    .cv-svg .drag-ghost {
      fill: color-mix(in srgb, var(--primary-color) 10%, transparent);
      stroke: var(--primary-color);
      stroke-width: 1.5;
      stroke-dasharray: 4 3;
      opacity: 0.6;
      pointer-events: none;
    }
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 20;
    }
    .modal {
      background: var(--card-background-color, #fff);
      border: 1px solid var(--divider-color, #ccc);
      border-radius: 10px;
      min-width: 320px;
      max-width: min(600px, 94vw);
      max-height: 85vh;
      overflow: auto;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.35);
    }
    /* Inside the popup, stack an element editor's fields vertically so wide
       editors (a service call's service/entity/value) never overflow sideways.
       The inline structure editor keeps its compact horizontal row. */
    .modal .el-row {
      flex-direction: column;
      align-items: stretch;
      gap: 8px;
    }
    .modal .el-row .spacer {
      display: none;
    }
    .modal .el-row .el-type {
      min-width: 0;
    }
    .modal .el-row select,
    .modal .el-row input,
    .modal .el-row .right-input,
    .modal .el-row .action-data {
      width: 100%;
      box-sizing: border-box;
    }
    .modal .el-row > button.icon {
      align-self: flex-end;
    }
    .modal-head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--divider-color, #eee);
      position: sticky;
      top: 0;
      background: var(--card-background-color, #fff);
    }
    .modal-title {
      font-weight: 500;
    }
    .modal-body {
      padding: 12px 14px;
    }
    .modal-section {
      margin-top: 12px;
      padding-top: 10px;
      border-top: 1px solid var(--divider-color, #eee);
    }
    .validation {
      margin-bottom: 10px;
      padding: 8px 10px;
      border-radius: 8px;
      font-size: 0.9em;
    }
    .validation.ok {
      color: var(--success-color, #2e7d32);
      background: color-mix(in srgb, var(--success-color, #2e7d32) 10%, transparent);
    }
    .validation.bad {
      background: color-mix(in srgb, var(--error-color, #c62828) 10%, transparent);
    }
    .validation.bad summary {
      cursor: pointer;
      font-weight: 500;
      color: var(--error-color, #c62828);
    }
    .validation ul {
      margin: 8px 0 2px;
      padding-left: 18px;
    }
    .validation li {
      margin: 2px 0;
    }
    .validation li.v-warning {
      color: var(--warning-color, #ef6c00);
    }
    .validation .v-loc {
      font-family: monospace;
      opacity: 0.8;
      margin-right: 4px;
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
    text.network-title {
      fill: var(--primary-text-color);
      font-size: 14px;
      font-weight: 600;
    }
    text.rung-title {
      fill: var(--secondary-text-color);
      font-size: 12px;
      font-weight: 500;
    }
    .rung-handle {
      cursor: grab;
      touch-action: none;
    }
    .rung-handle .rung-handle-hit {
      fill: transparent;
    }
    .rung-handle:hover .rung-handle-hit {
      fill: var(--secondary-background-color, #eee);
    }
    .rung-handle .rung-grip {
      fill: var(--secondary-text-color);
      font-size: 16px;
      font-weight: 700;
      text-anchor: middle;
      pointer-events: none;
      user-select: none;
    }
    line.rung-drop-line,
    line.coil-drop-line {
      stroke: var(--primary-color);
      stroke-width: 3;
      stroke-linecap: round;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "not-a-plc-panel": NotAPlcPanel;
  }
}

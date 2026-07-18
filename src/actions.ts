/**
 * Metadata + pure edit helpers for the service-call (`Action`) output editor.
 *
 * Lit-free so it can be unit-tested. The panel uses this to offer structured
 * dropdowns — pick a service, then an entity of that service's domain, then
 * (for option-style services) one of the entity's available options read live
 * from `state.attributes[optionsAttr]` — instead of hand-writing service data.
 */

import { ActionEl } from "./ir";

export interface ActionServiceSpec {
  /** The `domain.service` string stored in the IR. */
  service: string;
  /** Human label for the dropdown. */
  label: string;
  /** Entity domain this service targets (filters the entity picker). */
  domain: string;
  /**
   * Attribute on the target entity that lists the selectable values
   * (e.g. `preset_modes`), if this is an option-style service.
   */
  optionsAttr?: string;
  /** Service-data key the chosen value goes under (e.g. `preset_mode`). */
  valueKey?: string;
}

/**
 * A curated set of common services. Option-style entries carry the entity
 * attribute holding the choices and the data key the choice goes under; the
 * rest just target an entity. Not exhaustive — a "Custom…" escape hatch in the
 * editor still allows any service + raw JSON data.
 */
export const ACTION_SERVICES: ActionServiceSpec[] = [
  // Option / mode / preset selectors (value picked from an entity attribute).
  { service: "select.select_option", label: "Select · option", domain: "select", optionsAttr: "options", valueKey: "option" },
  { service: "input_select.select_option", label: "Input select · option", domain: "input_select", optionsAttr: "options", valueKey: "option" },
  { service: "fan.set_preset_mode", label: "Fan · preset mode", domain: "fan", optionsAttr: "preset_modes", valueKey: "preset_mode" },
  { service: "climate.set_preset_mode", label: "Climate · preset mode", domain: "climate", optionsAttr: "preset_modes", valueKey: "preset_mode" },
  { service: "climate.set_hvac_mode", label: "Climate · HVAC mode", domain: "climate", optionsAttr: "hvac_modes", valueKey: "hvac_mode" },
  { service: "climate.set_fan_mode", label: "Climate · fan mode", domain: "climate", optionsAttr: "fan_modes", valueKey: "fan_mode" },
  { service: "humidifier.set_mode", label: "Humidifier · mode", domain: "humidifier", optionsAttr: "available_modes", valueKey: "mode" },
  { service: "media_player.select_source", label: "Media player · source", domain: "media_player", optionsAttr: "source_list", valueKey: "source" },
  { service: "media_player.select_sound_mode", label: "Media player · sound mode", domain: "media_player", optionsAttr: "sound_mode_list", valueKey: "sound_mode" },
  // Entity-only activations (no option attribute).
  { service: "scene.turn_on", label: "Scene · activate", domain: "scene" },
  { service: "script.turn_on", label: "Script · run", domain: "script" },
  { service: "light.turn_on", label: "Light · on", domain: "light" },
  { service: "light.turn_off", label: "Light · off", domain: "light" },
  { service: "switch.turn_on", label: "Switch · on", domain: "switch" },
  { service: "switch.turn_off", label: "Switch · off", domain: "switch" },
  { service: "fan.turn_on", label: "Fan · on", domain: "fan" },
  { service: "fan.turn_off", label: "Fan · off", domain: "fan" },
  { service: "cover.open_cover", label: "Cover · open", domain: "cover" },
  { service: "cover.close_cover", label: "Cover · close", domain: "cover" },
  { service: "lock.lock", label: "Lock · lock", domain: "lock" },
  { service: "lock.unlock", label: "Lock · unlock", domain: "lock" },
];

/** The spec for a service string, or undefined if it is not a known service. */
export function actionSpec(service: string): ActionServiceSpec | undefined {
  return ACTION_SERVICES.find((s) => s.service === service);
}

/** The `entity_id` currently in an action's data, or "" if none/not a string. */
export function actionEntity(action: ActionEl): string {
  const id = action.data.entity_id;
  return typeof id === "string" ? id : "";
}

/** The chosen value under `valueKey`, or "" if unset/not a string. */
export function actionValue(action: ActionEl, valueKey: string): string {
  const v = action.data[valueKey];
  return typeof v === "string" ? v : "";
}

/**
 * Change the service. Keeps the current `entity_id` only if it still matches the
 * new service's domain; drops every other data key (the value key changes with
 * the service). An unknown service keeps the data untouched (custom/advanced).
 */
export function withService(action: ActionEl, service: string): ActionEl {
  const spec = actionSpec(service);
  if (!spec) return { ...action, service };
  const entity = actionEntity(action);
  const keepEntity = entity && entity.split(".")[0] === spec.domain;
  const data: Record<string, unknown> = keepEntity ? { entity_id: entity } : {};
  return { ...action, service, data };
}

/** Set the target entity, preserving any already-chosen option value. */
export function withEntity(action: ActionEl, entityId: string): ActionEl {
  const data = { ...action.data };
  if (entityId) data.entity_id = entityId;
  else delete data.entity_id;
  return { ...action, data };
}

/** Set (or clear, when value is "") the option value under `valueKey`. */
export function withValue(action: ActionEl, valueKey: string, value: string): ActionEl {
  const data = { ...action.data };
  if (value) data[valueKey] = value;
  else delete data[valueKey];
  return { ...action, data };
}

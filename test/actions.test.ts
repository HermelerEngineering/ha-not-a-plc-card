import { describe, expect, it } from "vitest";

import {
  ACTION_SERVICES,
  actionEntity,
  actionSpec,
  actionValue,
  withEntity,
  withService,
  withValue,
} from "../src/actions";
import { ActionEl } from "../src/ir";

const base = (over: Partial<ActionEl> = {}): ActionEl => ({
  type: "action",
  service: "fan.set_preset_mode",
  data: {},
  ...over,
});

describe("actionSpec", () => {
  it("finds a known service and its option metadata", () => {
    expect(actionSpec("fan.set_preset_mode")).toMatchObject({
      domain: "fan",
      optionsAttr: "preset_modes",
      valueKey: "preset_mode",
    });
    expect(actionSpec("scene.turn_on")).toMatchObject({ domain: "scene" });
    expect(actionSpec("scene.turn_on")?.optionsAttr).toBeUndefined();
  });

  it("returns undefined for an unknown service", () => {
    expect(actionSpec("foo.bar")).toBeUndefined();
    expect(actionSpec("")).toBeUndefined();
  });

  it("every service string is a domain.service", () => {
    for (const s of ACTION_SERVICES) expect(s.service).toContain(".");
  });
});

describe("data accessors", () => {
  it("reads entity_id and a value key as strings", () => {
    const a = base({ data: { entity_id: "fan.office", preset_mode: "eco" } });
    expect(actionEntity(a)).toBe("fan.office");
    expect(actionValue(a, "preset_mode")).toBe("eco");
  });

  it("returns '' for missing / non-string data", () => {
    const a = base({ data: { entity_id: 5 } });
    expect(actionEntity(a)).toBe("");
    expect(actionValue(a, "preset_mode")).toBe("");
  });
});

describe("withService", () => {
  it("keeps the entity when the new domain matches, drops the value key", () => {
    const a = base({ data: { entity_id: "fan.office", preset_mode: "eco" } });
    const next = withService(a, "fan.turn_on");
    expect(next.service).toBe("fan.turn_on");
    expect(next.data).toEqual({ entity_id: "fan.office" });
  });

  it("drops the entity when the new domain differs", () => {
    const a = base({ data: { entity_id: "fan.office", preset_mode: "eco" } });
    const next = withService(a, "scene.turn_on");
    expect(next.data).toEqual({});
  });

  it("keeps data untouched for an unknown (custom) service", () => {
    const a = base({ data: { entity_id: "fan.office", x: 1 } });
    const next = withService(a, "foo.bar");
    expect(next).toEqual({ ...a, service: "foo.bar" });
  });
});

describe("withEntity / withValue", () => {
  it("sets and clears the entity", () => {
    const a = base({ data: { preset_mode: "eco" } });
    expect(withEntity(a, "fan.office").data).toEqual({
      preset_mode: "eco",
      entity_id: "fan.office",
    });
    expect(withEntity(withEntity(a, "fan.office"), "").data).toEqual({
      preset_mode: "eco",
    });
  });

  it("sets and clears the option value", () => {
    const a = base({ data: { entity_id: "fan.office" } });
    expect(withValue(a, "preset_mode", "eco").data).toEqual({
      entity_id: "fan.office",
      preset_mode: "eco",
    });
    expect(withValue(withValue(a, "preset_mode", "eco"), "preset_mode", "").data).toEqual({
      entity_id: "fan.office",
    });
  });
});

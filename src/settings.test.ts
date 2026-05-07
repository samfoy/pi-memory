/**
 * Tests for readSettingsConfig — pi-memory config resolution from
 * ~/.pi/agent/settings.json (global) and {cwd}/.pi/settings.json (local).
 *
 * Precedence: local `memory` or `pi-memory` → overrides global `memory`.
 * Fields supported: lessonInjection, consolidationModel.
 *
 * NOTE: the global settings file at ~/.pi/agent/settings.json may or may not
 * exist on the machine running the tests. These tests assert behavior
 * _relative_ to whatever the global baseline is, so they do not depend on
 * its contents.
 */
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { readSettingsConfig } from "./index.js";

let tmpProject: string;

function writeProjectSettings(obj: Record<string, unknown>): void {
  const dir = path.join(tmpProject, ".pi");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(obj), "utf-8");
}

describe("readSettingsConfig", () => {
  before(() => {
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "mem-settings-"));
  });

  beforeEach(() => {
    try {
      fs.rmSync(path.join(tmpProject, ".pi"), { recursive: true, force: true });
    } catch {}
  });

  after(() => {
    fs.rmSync(tmpProject, { recursive: true, force: true });
  });

  it("reads consolidationModel from project-local `memory` block", () => {
    writeProjectSettings({ memory: { consolidationModel: "openai/gpt-4.1-mini" } });
    const cfg = readSettingsConfig(tmpProject);
    assert.equal(cfg.consolidationModel, "openai/gpt-4.1-mini");
  });

  it("reads consolidationModel from project-local `pi-memory` block", () => {
    writeProjectSettings({ "pi-memory": { consolidationModel: "ollama/qwen3:8b" } });
    const cfg = readSettingsConfig(tmpProject);
    assert.equal(cfg.consolidationModel, "ollama/qwen3:8b");
  });

  it("prefers `memory` over `pi-memory` when both are present locally", () => {
    writeProjectSettings({
      memory: { consolidationModel: "from-memory" },
      "pi-memory": { consolidationModel: "from-pi-memory" },
    });
    const cfg = readSettingsConfig(tmpProject);
    assert.equal(cfg.consolidationModel, "from-memory");
  });

  it("ignores non-string consolidationModel", () => {
    writeProjectSettings({ memory: { consolidationModel: 42 } });
    const cfg = readSettingsConfig(tmpProject);
    assert.equal(cfg.consolidationModel, undefined);
  });

  it("ignores empty / whitespace-only consolidationModel", () => {
    writeProjectSettings({ memory: { consolidationModel: "   " } });
    const cfg = readSettingsConfig(tmpProject);
    assert.equal(cfg.consolidationModel, undefined);
  });

  it("trims surrounding whitespace on a valid model string", () => {
    writeProjectSettings({ memory: { consolidationModel: "  claude-sonnet-4-20250514  " } });
    const cfg = readSettingsConfig(tmpProject);
    assert.equal(cfg.consolidationModel, "claude-sonnet-4-20250514");
  });

  it("still reads lessonInjection alongside consolidationModel", () => {
    writeProjectSettings({
      memory: {
        lessonInjection: "selective",
        consolidationModel: "openai/gpt-4.1-mini",
      },
    });
    const cfg = readSettingsConfig(tmpProject);
    assert.equal(cfg.lessonInjection, "selective");
    assert.equal(cfg.consolidationModel, "openai/gpt-4.1-mini");
  });

  it("returns undefined consolidationModel when no settings.json is present", () => {
    // Note: a global settings.json at ~/.pi/agent/settings.json *may* set a
    // value on the host; don't assert absolute equality. Assert that when
    // no local config is present, we at least don't fabricate a value.
    const cfg = readSettingsConfig(tmpProject);
    // If a global override exists, it must be a non-empty string; otherwise undefined.
    if (cfg.consolidationModel !== undefined) {
      assert.equal(typeof cfg.consolidationModel, "string");
      assert.ok(cfg.consolidationModel.length > 0);
    }
  });

  it("ignores malformed JSON in local settings.json", () => {
    fs.mkdirSync(path.join(tmpProject, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(tmpProject, ".pi", "settings.json"), "{ not json", "utf-8");
    // Should not throw.
    const cfg = readSettingsConfig(tmpProject);
    // Only global values can survive here; local is corrupt.
    // Can't assert absolute value for the same reason as above.
    assert.ok(cfg === cfg); // smoke test: function returned without throwing.
  });

  it("a malformed consolidationModel does not clobber a valid lessonInjection", () => {
    writeProjectSettings({
      memory: {
        lessonInjection: "selective",
        consolidationModel: 123, // invalid
      },
    });
    const cfg = readSettingsConfig(tmpProject);
    assert.equal(cfg.lessonInjection, "selective");
    assert.equal(cfg.consolidationModel, undefined);
  });
});

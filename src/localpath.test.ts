/**
 * Tests for resolveDbPath — project-local DB resolution.
 *
 * Resolution order:
 *   1. "pi-memory".localPath from {cwd}/.pi/settings.json → {localPath}/memory.db
 *   2. "pi-total-recall".localPath cascade → {localPath}/memory/memory.db
 *   3. Global default: ~/.pi/memory/memory.db
 */
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { homedir } from "node:os";

import { resolveDbPath } from "./index.js";

const DEFAULT_DB_PATH = path.join(homedir(), ".pi", "memory", "memory.db");

let tmpProject: string;
let tmpLocal: string;
let tmpCascade: string;

function writeProjectSettings(obj: Record<string, unknown>): void {
  const dir = path.join(tmpProject, ".pi");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(obj), "utf-8");
}

describe("resolveDbPath", () => {
  before(() => {
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "mem-proj-"));
    tmpLocal = fs.mkdtempSync(path.join(os.tmpdir(), "mem-local-"));
    tmpCascade = fs.mkdtempSync(path.join(os.tmpdir(), "mem-cascade-"));
  });

  beforeEach(() => {
    try {
      fs.rmSync(path.join(tmpProject, ".pi"), { recursive: true, force: true });
    } catch {}
  });

  after(() => {
    fs.rmSync(tmpProject, { recursive: true, force: true });
    fs.rmSync(tmpLocal, { recursive: true, force: true });
    fs.rmSync(tmpCascade, { recursive: true, force: true });
  });

  it("returns global default when no settings.json", () => {
    assert.equal(resolveDbPath(tmpProject), DEFAULT_DB_PATH);
  });

  it("returns global default for empty settings.json", () => {
    writeProjectSettings({});
    assert.equal(resolveDbPath(tmpProject), DEFAULT_DB_PATH);
  });

  it("returns global default for malformed settings.json", () => {
    fs.mkdirSync(path.join(tmpProject, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(tmpProject, ".pi", "settings.json"), "{ bad }", "utf-8");
    assert.equal(resolveDbPath(tmpProject), DEFAULT_DB_PATH);
  });

  it("returns global default when pi-memory.localPath is empty string", () => {
    writeProjectSettings({ "pi-memory": { localPath: "" } });
    assert.equal(resolveDbPath(tmpProject), DEFAULT_DB_PATH);
  });

  it("returns global default when pi-memory.localPath is not a string", () => {
    writeProjectSettings({ "pi-memory": { localPath: 42 } });
    assert.equal(resolveDbPath(tmpProject), DEFAULT_DB_PATH);
  });

  it("resolves relative pi-memory.localPath relative to cwd, not process CWD", () => {
    writeProjectSettings({ "pi-memory": { localPath: ".pi/memory-local" } });
    // Should resolve relative to the project root (tmpProject), not process.cwd()
    assert.equal(
      resolveDbPath(tmpProject),
      path.resolve(tmpProject, ".pi/memory-local", "memory.db"),
    );
    // And it must NOT be relative to process.cwd() (which would be unpredictable)
    assert.notEqual(
      resolveDbPath(tmpProject),
      path.join(".pi/memory-local", "memory.db"),
    );
  });

  it("resolves relative pi-total-recall.localPath relative to cwd", () => {
    writeProjectSettings({ "pi-total-recall": { localPath: ".pi/total-recall" } });
    assert.equal(
      resolveDbPath(tmpProject),
      path.resolve(tmpProject, ".pi/total-recall", "memory", "memory.db"),
    );
    assert.notEqual(
      resolveDbPath(tmpProject),
      path.join(".pi/total-recall", "memory", "memory.db"),
    );
  });

  it("absolute pi-memory.localPath still works after the resolve() fix", () => {
    writeProjectSettings({ "pi-memory": { localPath: tmpLocal } });
    // path.resolve(cwd, absolutePath, ...) should return absolutePath/... unchanged
    assert.equal(resolveDbPath(tmpProject), path.resolve(tmpLocal, "memory.db"));
  });

  it("cascades from pi-total-recall.localPath to {base}/memory/memory.db", () => {
    writeProjectSettings({ "pi-total-recall": { localPath: tmpCascade } });
    assert.equal(resolveDbPath(tmpProject), path.join(tmpCascade, "memory", "memory.db"));
  });

  it("package-specific pi-memory.localPath wins over pi-total-recall cascade", () => {
    writeProjectSettings({
      "pi-memory": { localPath: tmpLocal },
      "pi-total-recall": { localPath: tmpCascade },
    });
    assert.equal(resolveDbPath(tmpProject), path.join(tmpLocal, "memory.db"));
  });

  it("returns global default when pi-total-recall.localPath is empty string", () => {
    writeProjectSettings({ "pi-total-recall": { localPath: "" } });
    assert.equal(resolveDbPath(tmpProject), DEFAULT_DB_PATH);
  });

  it("returns global default when pi-total-recall.localPath is not a string", () => {
    writeProjectSettings({ "pi-total-recall": { localPath: null } });
    assert.equal(resolveDbPath(tmpProject), DEFAULT_DB_PATH);
  });

  it("ignores unrelated settings keys", () => {
    writeProjectSettings({
      someOtherKey: { localPath: tmpLocal },
      memory: { lessonInjection: "selective" }, // this is a config key, not a path
    });
    assert.equal(resolveDbPath(tmpProject), DEFAULT_DB_PATH);
  });

  it("doesn't leak: different cwd reads different settings", () => {
    writeProjectSettings({ "pi-memory": { localPath: tmpLocal } });
    const otherProject = fs.mkdtempSync(path.join(os.tmpdir(), "mem-other-"));
    try {
      assert.equal(resolveDbPath(otherProject), DEFAULT_DB_PATH);
    } finally {
      fs.rmSync(otherProject, { recursive: true, force: true });
    }
  });
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface PackageManifest {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

test("does not install or advertise the legacy vector backend", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as PackageManifest;

  for (const dependencies of [
    manifest.dependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ]) {
    assert.equal(dependencies?.["@xenova/transformers"], undefined);
  }
});

test("does not install a duplicate Pi host in consumers", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as PackageManifest;

  assert.equal(
    manifest.peerDependenciesMeta?.["@earendil-works/pi-coding-agent"]?.optional,
    true,
  );
});

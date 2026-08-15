/**
 * Contract guard against reintroducing a checkout-wide archive hook: no root
 * lifecycle script may download or extract an artifact bundle over the working
 * tree (the retired sync-artifacts.mjs postinstall rewrote tracked files and
 * exited healthy on failure). Runs against the real repository manifest.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

const FORBIDDEN = [
  /sync-artifacts/i,
  /eliza-archive/i,
  /artifacts-manifest/i,
  /fetch-archive-artifacts/i,
];
const LIFECYCLE = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
];

describe("no global archive hook", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };
  const scripts = manifest.scripts ?? {};

  test("root lifecycle scripts never invoke an archive fetch or sync", () => {
    for (const name of LIFECYCLE) {
      const command = scripts[name];
      if (!command) continue;
      for (const pattern of FORBIDDEN) {
        expect(
          pattern.test(command),
          `root "${name}" script must not match ${pattern}: ${command}`,
        ).toBe(false);
      }
    }
  });

  test("no root script re-exposes an implicit tree-wide artifact sync", () => {
    expect(scripts["sync:artifacts"]).toBeUndefined();
  });

  test("the retired sync machinery stays deleted", () => {
    expect(
      existsSync(path.join(REPO_ROOT, "packages/scripts/sync-artifacts.mjs")),
    ).toBe(false);
    expect(
      existsSync(
        path.join(REPO_ROOT, "packages/scripts/artifacts-manifest.json"),
      ),
    ).toBe(false);
  });
});

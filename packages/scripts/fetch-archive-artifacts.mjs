#!/usr/bin/env node
/**
 * Explicit, opt-in fetcher for the large historical artifact bundle hosted on
 * the elizaOS/eliza-archive release. Nothing in the repository runs this
 * automatically: install hooks must never download or extract an archive over
 * the working tree (see packages/scripts/__tests__/no-global-archive-hook.test.ts).
 *
 * A consumer that genuinely needs a legacy fixture, media asset, or binary
 * invokes this with an out-of-tree destination and copies the specific files
 * it owns into place:
 *
 *   node packages/scripts/fetch-archive-artifacts.mjs --dest /tmp/eliza-archive
 *   node packages/scripts/fetch-archive-artifacts.mjs --dest /tmp/eliza-archive \
 *     --include packages/shared/assets-classic/
 *
 * Unlike the retired postinstall sync, every failure here (download, digest,
 * extraction) exits non-zero with an actionable message, and extraction is
 * refused when --dest resolves to the repository root or any directory inside
 * the checkout, so the bundle can never silently rewrite tracked files.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Pinned bundle identity; update deliberately when the archive release changes. */
const ASSET = {
  url: "https://github.com/elizaOS/eliza-archive/releases/download/dev-artifacts/eliza-dev-artifacts.tar.gz",
  sha256: "f33042edcde955adfdcde1c1a98c62817d09e5f624f3b5b842aea7c4db975550",
  bytes: 1018170326,
};

const log = (m) => console.log(`[fetch-archive-artifacts] ${m}`);
const fail = (m) => {
  console.error(`[fetch-archive-artifacts] ERROR: ${m}`);
  process.exit(1);
};

function parseArgs(argv) {
  const opts = { dest: "", includes: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dest") {
      opts.dest = argv[++i] ?? "";
    } else if (arg === "--include") {
      const value = argv[++i];
      if (!value) fail("--include requires a path prefix argument");
      opts.includes.push(value);
    } else if (arg === "--help" || arg === "-h") {
      log(
        "usage: fetch-archive-artifacts.mjs --dest <out-of-tree dir> [--include <archive path prefix>]...",
      );
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  if (!opts.dest) {
    fail(
      "--dest is required and must point outside the repository checkout, e.g. --dest /tmp/eliza-archive",
    );
  }
  return opts;
}

const { dest, includes } = parseArgs(process.argv.slice(2));
const destAbs = resolve(dest);
if (destAbs === REPO_ROOT || destAbs.startsWith(REPO_ROOT + sep)) {
  fail(
    `refusing to extract into the repository checkout (${destAbs}); ` +
      "pick an out-of-tree --dest and copy only the files your package owns",
  );
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024;
    unit = units[i];
  }
  return `${value >= 10 || unit === "B" ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

async function streamToFile(response, file) {
  const writer = createWriteStream(file);
  const reader = response.body.getReader();
  let received = 0;
  let lastLogAt = Date.now();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (!writer.write(value)) await once(writer, "drain");
      const now = Date.now();
      if (now - lastLogAt >= 5000) {
        log(
          `downloaded ${formatBytes(received)} of ${formatBytes(ASSET.bytes)}`,
        );
        lastLogAt = now;
      }
    }
  } finally {
    reader.releaseLock();
  }
  await new Promise((res, rej) =>
    writer.end((err) => (err ? rej(err) : res())),
  );
  return received;
}

const tmp = join(tmpdir(), `eliza-archive-fetch-${process.pid}.tar.gz`);
try {
  log(`downloading ${ASSET.url} (${formatBytes(ASSET.bytes)})`);
  const response = await fetch(ASSET.url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    fail(
      `download failed with HTTP ${response.status}; the eliza-archive release ` +
        "may be unavailable — retry later or fetch the asset manually",
    );
  }
  await streamToFile(response, tmp);

  log("verifying sha256 digest");
  const digest = createHash("sha256").update(readFileSync(tmp)).digest("hex");
  if (digest !== ASSET.sha256) {
    fail(
      `sha256 mismatch (got ${digest}, want ${ASSET.sha256}); ` +
        "the download is corrupt or the release asset changed — not extracting",
    );
  }

  mkdirSync(destAbs, { recursive: true });
  log(
    `extracting into ${destAbs}${includes.length ? ` (only: ${includes.join(", ")})` : ""}`,
  );
  // Windows: prefer the System32 bsdtar; a GNU tar first on PATH misreads
  // `C:\...` archive paths as rsh host:path specs.
  const tarBin =
    process.platform === "win32"
      ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
      : "tar";
  execFileSync(tarBin, ["-xzf", tmp, "-C", destAbs, ...includes], {
    stdio: "inherit",
  });
  log(`done — archive contents available under ${destAbs}`);
} catch (err) {
  // error-policy:J1 CLI process boundary; translate any fetch/extract failure into a non-zero exit with guidance.
  fail(
    `${err.message}\nretry with: node packages/scripts/fetch-archive-artifacts.mjs --dest ${dest}`,
  );
} finally {
  if (existsSync(tmp)) rmSync(tmp, { force: true });
}

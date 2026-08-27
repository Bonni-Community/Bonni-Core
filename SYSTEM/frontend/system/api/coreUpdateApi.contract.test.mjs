import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./coreUpdateApi.js", import.meta.url), "utf8");

test("deployment lifecycle finalization is isolated behind one generations-bound adapter", () => {
  const start = source.indexOf("export function finalizeCoreDeploymentLifecycle");
  const end = source.indexOf("\nexport function", start + 1);
  const adapter = source.slice(start, end > start ? end : undefined);
  assert.match(source, /const DEPLOYMENT_LIFECYCLE_PATH = `\$\{BASE_PATH\}\/deployment-lifecycle`/u);
  assert.match(adapter, /export function finalizeCoreDeploymentLifecycle\(token, \{ holdId, generation \}\)/u);
  assert.match(adapter, /DEPLOYMENT_LIFECYCLE_FINALIZE_PROOF_INVALID/u);
  assert.match(adapter, /\^\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\{7,127\}\$/u);
  assert.match(adapter, /normalizedGeneration <= 0/u);
  assert.match(adapter, /`\$\{DEPLOYMENT_LIFECYCLE_PATH\}\/finalize`/u);
  assert.match(adapter, /body:\s*\{\s*holdId: normalizedHoldId,\s*generation: normalizedGeneration,?\s*\}/u);
  assert.doesNotMatch(adapter, /(?:activeSlot|previousSlot|standbySlot|targetVersion)/u);
});

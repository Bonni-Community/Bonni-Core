import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/core/domain-messages/domain-message-runtime.ts", import.meta.url),
  "utf8",
);

test("Kontor subledger reports are restricted to the declared Bonni finance apps", () => {
  const protocol = "bonni.finance.kontor.subledger.reported/v1";
  const policyBlocks = [...source.matchAll(/Object\.freeze\(\{([\s\S]*?)\}\),/g)]
    .map((match) => match[1])
    .filter((block) => block.includes(`protocol: "${protocol}"`));

  assert.equal(policyBlocks.length, 3);
  assert.ok(policyBlocks.some((block) => (
    block.includes('sourceModule: "app.stueberlapp"')
    && block.includes('sourceDomain: "stueberl"')
  )));
  assert.ok(policyBlocks.some((block) => (
    block.includes('sourceModule: "app.hocketapp"')
    && block.includes('sourceDomain: "hocket"')
  )));
  assert.ok(policyBlocks.some((block) => (
    block.includes('sourceModule: "app.posapp"')
    && block.includes('sourceDomain: "pos"')
  )));
  assert.ok(policyBlocks.every((block) => (
    block.includes('targetModule: "app.kontorapp"')
    && block.includes('targetDomain: "kontor"')
  )));
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("status cards keep the React key outside the spread props", async () => {
  const source = await readFile(
    new URL("./ControlCenterStyle.jsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /statusCards\.map\(\(\{\s*key,\s*\.\.\.cardProps\s*\}\)\s*=>/);
  assert.match(source, /<MetricCard\s+key=\{key\}\s+\{\.\.\.cardProps\}\s*\/>/);
  assert.doesNotMatch(source, /<MetricCard\s+key=\{card\.key\}\s+\{\.\.\.card\}\s*\/>/);
});

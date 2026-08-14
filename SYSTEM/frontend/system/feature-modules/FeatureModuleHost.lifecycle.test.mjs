import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./FeatureModuleHost.jsx", import.meta.url),
  "utf8",
);

test("opaque RPC requests survive ordinary Core context rerenders", () => {
  const lifecycleEffect = source.match(
    /useEffect\(\(\) => \{\s*const activeRequests = activeRequestsRef\.current;[\s\S]*?\n  \}, \[\n([\s\S]*?)\n  \]\);/,
  );

  assert.ok(lifecycleEffect, "RPC lifecycle effect not found");
  assert.doesNotMatch(
    lifecycleEffect[1],
    /\b(?:token|user|shell|activeWorkspace|allowedWorkspaces)\b/,
  );
  assert.match(source, /token: contextRef\.current\?\.token/);
  assert.match(source, /signature === lastContextSignatureRef\.current/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL(
    "../src/platform/module-manager/frontend/module-frontend-runtime.ts",
    import.meta.url,
  ),
  "utf8",
);

test("opaque feature-module assets opt into cross-origin resource loading", () => {
  assert.match(
    source,
    /res\.setHeader\("Cross-Origin-Resource-Policy", "cross-origin"\)/,
  );
  assert.match(source, /serveStaticFrontend\(req, res, next\)/);
});

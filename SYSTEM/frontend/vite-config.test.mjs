import assert from "node:assert/strict";
import test from "node:test";

import { configureFeatureModuleAssetProxy } from "./vite.config.js";
import { readFileSync } from "node:fs";

test("Vite exposes only proxied feature-module assets to opaque app iframes", () => {
  let proxyResponseHandler = null;

  configureFeatureModuleAssetProxy({
    on(event, handler) {
      if (event === "proxyRes") proxyResponseHandler = handler;
    },
  });

  assert.equal(typeof proxyResponseHandler, "function");

  const proxyResponse = {
    headers: {
      "cross-origin-resource-policy": "same-origin",
    },
  };
  proxyResponseHandler(proxyResponse);

  assert.equal(
    proxyResponse.headers["cross-origin-resource-policy"],
    "cross-origin",
  );
});

test("Vite forwards the public Meet entry to the manifest-driven backend", () => {
  const source = readFileSync(new URL("./vite.config.js", import.meta.url), "utf8");
  assert.match(source, /"\/meet"\s*:\s*\{/);
  assert.match(source, /"\/feature-modules"\s*:\s*\{/);
  assert.match(source, /"\/api"\s*:\s*\{/);
});

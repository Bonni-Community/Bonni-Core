import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupObsoleteTechnicalData,
  technicalDataRevision,
  TECHNICAL_DATA_VERSION_KEY,
} from "./technicalDataCleanup.js";

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    snapshot() {
      return Object.fromEntries(values);
    },
  };
}

test("version cleanup removes only obsolete technical browser data", async () => {
  const local = storage({
    runtimeEndpoint: JSON.stringify({ origin: "http://localhost:4000" }),
    token: "login-stays-valid",
    user: JSON.stringify({ id: "member-1" }),
    activeArea: "member",
    bonniStoreLanguage: "de",
  });
  const session = storage({
    "bonni.apiOrigin": "http://127.0.0.1:4001",
    token: "session-login-stays-valid",
  });
  const deletedCaches = [];
  const cacheStorage = {
    async keys() {
      return ["bonni-core-v1", "stueberl-assets-old", "another-project-cache"];
    },
    async delete(name) {
      deletedCaches.push(name);
      return true;
    },
  };
  let unregistered = 0;
  const serviceWorkerContainer = {
    async getRegistrations() {
      return [
        {
          active: { scriptURL: "http://localhost:5173/sw.js" },
          async unregister() {
            unregistered += 1;
            return true;
          },
        },
        {
          active: { scriptURL: "http://localhost:5173/matrix-worker.js" },
          async unregister() {
            throw new Error("fremder Worker darf nicht entfernt werden");
          },
        },
      ];
    },
  };

  const result = await cleanupObsoleteTechnicalData({
    appVersion: "0.1.16",
    localStorage: local,
    sessionStorage: session,
    cacheStorage,
    serviceWorkerContainer,
    origin: "http://localhost:5173",
  });

  assert.equal(result.changed, true);
  assert.deepEqual(deletedCaches, ["bonni-core-v1", "stueberl-assets-old"]);
  assert.equal(unregistered, 1);
  assert.deepEqual(local.snapshot(), {
    token: "login-stays-valid",
    user: JSON.stringify({ id: "member-1" }),
    activeArea: "member",
    bonniStoreLanguage: "de",
    [TECHNICAL_DATA_VERSION_KEY]: technicalDataRevision("0.1.16"),
  });
  assert.deepEqual(session.snapshot(), {
    token: "session-login-stays-valid",
  });
});

test("cleanup runs only once for the same technical data revision", async () => {
  const local = storage({
    [TECHNICAL_DATA_VERSION_KEY]: technicalDataRevision("0.1.16"),
    runtimeEndpoint: "new-runtime-selection",
  });

  const result = await cleanupObsoleteTechnicalData({
    appVersion: "0.1.16",
    localStorage: local,
    sessionStorage: storage(),
    cacheStorage: null,
    serviceWorkerContainer: null,
    origin: "http://localhost:5173",
  });

  assert.equal(result.changed, false);
  assert.equal(local.snapshot().runtimeEndpoint, "new-runtime-selection");
});

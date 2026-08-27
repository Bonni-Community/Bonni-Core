import assert from "node:assert/strict";
import test from "node:test";

import { apiRequest, normalizeBrowserApiUrl } from "./apiClient.js";

class MemoryStorage {
  #values = new Map();

  get length() {
    return this.#values.size;
  }

  key(index) {
    return [...this.#values.keys()][index] ?? null;
  }

  getItem(key) {
    return this.#values.get(key) ?? null;
  }

  setItem(key, value) {
    this.#values.set(key, String(value));
  }

  removeItem(key) {
    this.#values.delete(key);
  }
}

test("browser API requests cannot bypass the same-origin proxy", () => {
  assert.equal(
    normalizeBrowserApiUrl(
      "http://127.0.0.1:4001/api/apps/stueberlapp/application-docks/member/analysis",
      "http://localhost:5173",
    ),
    "http://localhost:5173/api/apps/stueberlapp/application-docks/member/analysis",
  );
  assert.equal(
    normalizeBrowserApiUrl(
      "http://localhost:4000/api/auth/shell",
      "http://localhost:5173",
    ),
    "http://localhost:5173/api/auth/shell",
  );
  assert.equal(
    normalizeBrowserApiUrl(
      "https://example.org/public/image.png",
      "http://localhost:5173",
    ),
    "https://example.org/public/image.png",
  );
});

test("an invalid authenticated session also removes local update monitor access", async (t) => {
  const hadWindow = Object.hasOwn(globalThis, "window");
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  let reloads = 0;
  globalThis.window = {
    localStorage,
    sessionStorage,
    location: {
      origin: "http://localhost:5173",
      port: "5173",
      reload() {
        reloads += 1;
      },
    },
    setTimeout(callback) {
      callback();
      return 1;
    },
  };
  globalThis.fetch = async () => new Response(JSON.stringify({
    code: "SESSION_EXPIRED",
  }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
  t.after(() => {
    if (hadWindow) globalThis.window = previousWindow;
    else delete globalThis.window;
    globalThis.fetch = previousFetch;
  });

  for (const storage of [localStorage, sessionStorage]) {
    storage.setItem("token", "expired-user-token");
    storage.setItem("bonni.local-update.monitor-access", "monitor-bearer-token");
    storage.setItem("unrelated.preference", "preserved");
  }
  sessionStorage.setItem("bonni.core-update.accepted-transition", "accepted");
  sessionStorage.setItem("bonni.local-update.timeline:u-019-test", "timeline");

  await assert.rejects(
    apiRequest("/private", {
      token: "expired-user-token",
      allowFailover: false,
    }),
    (error) => error.status === 401 && error.code === "SESSION_EXPIRED",
  );

  for (const storage of [localStorage, sessionStorage]) {
    assert.equal(storage.getItem("token"), null);
    assert.equal(storage.getItem("bonni.local-update.monitor-access"), null);
    assert.equal(storage.getItem("unrelated.preference"), "preserved");
  }
  assert.equal(sessionStorage.getItem("bonni.core-update.accepted-transition"), null);
  assert.equal(sessionStorage.getItem("bonni.local-update.timeline:u-019-test"), null);
  assert.match(sessionStorage.getItem("bonni.sessionMessage"), /abgelaufen/u);
  assert.equal(reloads, 1);
});

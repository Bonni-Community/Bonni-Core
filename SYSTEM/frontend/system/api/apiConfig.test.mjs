import assert from "node:assert/strict";
import test from "node:test";

test("browser API requests stay same-origin even with a stored backend address", async () => {
  const originalWindow = globalThis.window;
  globalThis.window = {
    location: {
      origin: "http://localhost:5173",
      port: "5173",
    },
    localStorage: {
      getItem(key) {
        if (key !== "runtimeEndpoint") return null;
        return JSON.stringify({
          mode: "emergency",
          origin: "http://172.20.0.1:4001",
        });
      },
    },
  };

  try {
    const config = await import(`./apiConfig.js?same-origin=${Date.now()}`);
    assert.equal(config.API_ORIGIN_URL, "http://localhost:5173");
    assert.deepEqual(config.API_ORIGIN_CANDIDATES, ["http://localhost:5173"]);
    assert.deepEqual(
      config.buildApiUrls("/api/apps/stueberlapp/application-docks/member/account"),
      ["http://localhost:5173/api/apps/stueberlapp/application-docks/member/account"],
    );
  } finally {
    globalThis.window = originalWindow;
  }
});

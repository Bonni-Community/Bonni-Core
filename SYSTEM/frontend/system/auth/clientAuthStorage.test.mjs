import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { clearClientAuthStorage } from "./clientAuthStorage.js";

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

test("manual logout uses the tested client auth cleanup", async () => {
  const useSessionSource = await readFile(new URL("./useSession.js", import.meta.url), "utf8");
  const logoutStart = useSessionSource.indexOf("async function logout(options = {})");
  const loginStart = useSessionSource.indexOf("async function login(e)", logoutStart);

  assert.ok(logoutStart >= 0 && loginStart > logoutStart);
  assert.match(
    useSessionSource.slice(logoutStart, loginStart),
    /clearClientAuthStorage\(\)/u,
  );
});

test("client auth cleanup removes the installation monitor bearer token", () => {
  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  const exactKeys = [
    "token",
    "user",
    "shell",
    "activeArea",
    "lastActivityAt",
    "bonni.local-update.monitor-access",
    "bonni.core-update.accepted-transition",
    "bonni.core-update.last-action-error",
  ];
  const updateSessionKeys = [
    "bonni.local-update.timeline:u-019-test",
    "bonni.local-update.dismissed-error:u-019-test",
    "bonni.local-update.action-error:u-019-test",
  ];
  for (const storage of [localStorage, sessionStorage]) {
    for (const key of exactKeys) storage.setItem(key, "sensitive");
    storage.setItem("unrelated.preference", "preserved");
  }
  for (const key of updateSessionKeys) sessionStorage.setItem(key, "session state");

  clearClientAuthStorage({ localStorage, sessionStorage });

  for (const storage of [localStorage, sessionStorage]) {
    for (const key of exactKeys) assert.equal(storage.getItem(key), null, key);
    assert.equal(storage.getItem("unrelated.preference"), "preserved");
  }
  for (const key of updateSessionKeys) assert.equal(sessionStorage.getItem(key), null, key);
});

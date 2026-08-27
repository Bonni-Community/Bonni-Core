import assert from "node:assert/strict";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { Window } from "../../../../../app/kontorapp/frontend/node_modules/happy-dom/lib/index.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(directory, "../../../..");
const browser = new Window({ url: "http://localhost/" });
const previousGlobals = new Map();
let vite;
let React;
let act;
let createRoot;
let Simulate;
let JitsiTab;
let fetchHandler;

function installGlobals() {
  for (const key of [
    "window", "document", "navigator", "HTMLElement", "HTMLInputElement",
    "HTMLButtonElement", "Event", "InputEvent", "KeyboardEvent", "MutationObserver",
    "AbortController", "URL", "Blob", "FormData",
  ]) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === "window" ? browser : browser[key],
    });
  }
  previousGlobals.set("fetch", Object.getOwnPropertyDescriptor(globalThis, "fetch"));
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (...args) => fetchHandler(...args),
  });
  previousGlobals.set("IS_REACT_ACT_ENVIRONMENT", Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT"));
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
}

function restoreGlobals() {
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pathOf(value) {
  return new URL(String(value), "http://localhost/").pathname;
}

function settings(secretConfigured = true) {
  return {
    settings: {
      enabled: false,
      serverUrl: "https://meet.example.test",
      appId: "bonni-test",
      secretConfigured,
      version: 1,
      updatedAt: null,
    },
  };
}

function challenge(id = "challenge:1", expiresAt) {
  return {
    challenge: {
      id,
      provider: "local",
      providerLabel: "Bonni Core",
      proofFields: [{
        name: "code",
        label: "Authenticator-Code",
        type: "password",
        autocomplete: "one-time-code",
      }],
      ...(expiresAt ? { expiresAt } : {}),
    },
  };
}

function change(input, value) {
  Simulate.change(input, { target: { value } });
}

function button(host, text) {
  return [...host.querySelectorAll("button")].find((entry) => entry.textContent.includes(text));
}

async function flush(iterations = 2) {
  for (let index = 0; index < iterations; index += 1) {
    await act(async () => new Promise((resolve) => browser.setTimeout(resolve, 0)));
  }
}

before(async () => {
  installGlobals();
  const reactModule = await import("react");
  React = reactModule.default;
  act = reactModule.act;
  ({ createRoot } = await import("react-dom/client"));
  ({ Simulate } = await import("react-dom/test-utils"));
  vite = await createServer({
    configFile: false,
    root: frontendRoot,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
    plugins: [react()],
  });
  ({ default: JitsiTab } = await vite.ssrLoadModule(
    "/platform/control-center/schnittstellen/tab/Jitsi.jsx",
  ));
});

after(async () => {
  await vite?.close();
  browser.close();
  restoreGlobals();
});

test("Jitsi secret leaves DOM/state before challenge await and the save ref is one-shot", async () => {
  let resolveChallenge;
  let resolveSave;
  let savedBody = null;
  let challengeRequests = 0;
  fetchHandler = async (url, options = {}) => {
    const requestPath = pathOf(url);
    if (requestPath === "/api/system/integrations/jitsi" && (options.method || "GET") === "GET") {
      return json(settings());
    }
    if (requestPath === "/api/security/2fa/challenge") {
      challengeRequests += 1;
      return new Promise((resolve) => { resolveChallenge = () => resolve(json(challenge())); });
    }
    if (requestPath.endsWith("/verify")) return json({ ok: true });
    if (requestPath === "/api/system/integrations/jitsi" && options.method === "PUT") {
      savedBody = JSON.parse(options.body);
      return new Promise((resolve) => { resolveSave = () => resolve(json(settings(true))); });
    }
    throw new Error(`unexpected request ${options.method || "GET"} ${requestPath}`);
  };

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(JitsiTab, { token: "token" })));
  await flush();
  const secretInput = host.querySelector('.cc-system-form-grid input[type="password"]');
  const exactSecret = "😀".repeat(512);
  await act(async () => change(secretInput, exactSecret));
  await act(async () => {
    const saveButton = button(host, "Mit Zwei-Faktor");
    saveButton.click();
    saveButton.click();
    await Promise.resolve();
  });
  assert.equal(secretInput.value, "", "secret must be purged before challenge creation resolves");
  assert.equal(challengeRequests, 1, "double click must create exactly one challenge");

  await act(async () => resolveChallenge());
  await flush();
  const proofInput = host.querySelector(".bonni-2fa-proof input");
  await act(async () => change(proofInput, "123456"));
  await act(async () => {
    host.querySelector(".bonni-2fa-proof").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  await flush();
  assert.equal(secretInput.value, "");
  assert.equal(savedBody.secret, exactSecret);
  await act(async () => resolveSave());
  await flush();
  savedBody.secret = "";

  await act(async () => root.unmount());
  host.remove();
});

test("Jitsi secret is purged on challenge rejection, cancel, pagehide and unmount", async () => {
  let challengeMode = "reject";
  let lastSaveBody = null;
  fetchHandler = async (url, options = {}) => {
    const requestPath = pathOf(url);
    if (requestPath === "/api/system/integrations/jitsi" && (options.method || "GET") === "GET") {
      return json(settings());
    }
    if (requestPath === "/api/security/2fa/challenge") {
      if (challengeMode === "reject") throw new Error("challenge rejected");
      return json(challenge(
        `challenge:${challengeMode}`,
        challengeMode === "expiry" ? new Date(Date.now() + 30).toISOString() : undefined,
      ));
    }
    if (requestPath.endsWith("/verify")) return json({ ok: true });
    if (requestPath === "/api/system/integrations/jitsi" && options.method === "PUT") {
      lastSaveBody = JSON.parse(options.body);
      return json(settings(true));
    }
    throw new Error(`unexpected request ${options.method || "GET"} ${requestPath}`);
  };

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(JitsiTab, { token: "token" })));
  await flush();
  const secretInput = host.querySelector('.cc-system-form-grid input[type="password"]');
  await act(async () => change(secretInput, "r".repeat(32)));
  await act(async () => { button(host, "Mit Zwei-Faktor").click(); await Promise.resolve(); });
  await flush();
  assert.equal(secretInput.value, "");
  assert.match(host.textContent, /Backend nicht erreichbar/);

  challengeMode = "cancel";
  await act(async () => change(secretInput, "c".repeat(32)));
  await act(async () => button(host, "Mit Zwei-Faktor").click());
  await flush();
  await act(async () => button(host.querySelector(".bonni-2fa-proof"), "Abbrechen").click());
  assert.equal(secretInput.value, "");
  assert.equal(host.querySelector(".bonni-2fa-proof"), null);

  // A new save without a secret proves that cancel cleared the staged ref.
  challengeMode = "after-cancel";
  await act(async () => button(host, "Mit Zwei-Faktor").click());
  await flush();
  const proofInput = host.querySelector(".bonni-2fa-proof input");
  await act(async () => change(proofInput, "123456"));
  await act(async () => host.querySelector(".bonni-2fa-proof").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })));
  await flush(3);
  assert.equal(Object.hasOwn(lastSaveBody, "secret"), false);

  challengeMode = "expiry";
  await act(async () => change(secretInput, "e".repeat(32)));
  await act(async () => button(host, "Mit Zwei-Faktor").click());
  await flush();
  assert.ok(host.querySelector(".bonni-2fa-proof"));
  await act(async () => new Promise((resolve) => browser.setTimeout(resolve, 60)));
  assert.equal(host.querySelector(".bonni-2fa-proof"), null, "expired challenge must be removed");
  assert.equal(secretInput.value, "");
  assert.match(host.textContent, /abgelaufen/);

  // A fresh proof after expiry must not inherit the expired staged secret.
  lastSaveBody = null;
  challengeMode = "after-expiry";
  await act(async () => button(host, "Mit Zwei-Faktor").click());
  await flush();
  const proofAfterExpiry = host.querySelector(".bonni-2fa-proof input");
  await act(async () => change(proofAfterExpiry, "123456"));
  await act(async () => host.querySelector(".bonni-2fa-proof").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })));
  await flush(3);
  assert.equal(Object.hasOwn(lastSaveBody, "secret"), false);

  await act(async () => change(secretInput, "p".repeat(32)));
  await act(async () => window.dispatchEvent(new browser.Event("pagehide")));
  assert.equal(secretInput.value, "");

  await act(async () => change(secretInput, "u".repeat(32)));
  await act(async () => root.unmount());
  assert.equal(secretInput.value, "", "the held old input node must be purged during unmount");
  host.remove();
});

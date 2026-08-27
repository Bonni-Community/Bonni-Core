import assert from "node:assert/strict";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { Window } from "../../../../../../app/kontorapp/frontend/node_modules/happy-dom/lib/index.js";

const componentDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(componentDirectory, "../../../../..");
const browser = new Window({ url: "http://localhost/" });
const previousGlobals = {};
const REFERENCE = "PR-ABCDE-23456";
const EXPIRES_AT = "2035-04-05T12:30:00.000Z";
let vite;
let React;
let act;
let useState;
let createRoot;
let Simulate;
let PasswordRecoveryFlow;

function installBrowserGlobals() {
  for (const name of [
    "window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Event", "InputEvent",
  ]) {
    previousGlobals[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: name === "window" ? browser : browser[name],
    });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

function restoreBrowserGlobals() {
  for (const [name, descriptor] of Object.entries(previousGlobals)) {
    if (descriptor === undefined) delete globalThis[name];
    else Object.defineProperty(globalThis, name, descriptor);
  }
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
}

function button(host, text) {
  return [...host.querySelectorAll("button")].find((entry) => entry.textContent.trim() === text);
}

function change(element, value) {
  Simulate.change(element, { target: { value } });
}

async function flush() {
  await act(async () => new Promise((resolve) => browser.setTimeout(resolve, 0)));
}

function status(statusName, supportCodeAllowed, reference = REFERENCE) {
  return {
    status: statusName,
    reference: statusName === "NONE" ? null : reference,
    expiresAt: statusName === "NONE" ? null : EXPIRES_AT,
    supportCodeAllowed,
  };
}

before(async () => {
  installBrowserGlobals();
  const reactModule = await import("react");
  React = reactModule.default;
  act = reactModule.act;
  useState = reactModule.useState;
  ({ createRoot } = await import("react-dom/client"));
  ({ Simulate } = await import("react-dom/test-utils"));
  vite = await createServer({
    configFile: false,
    root: frontendRoot,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
    plugins: [react({ jsxRuntime: "classic" })],
  });
  ({ default: PasswordRecoveryFlow } = await vite.ssrLoadModule(
    "/core/modules/security/identity/components/PasswordRecoveryFlow.jsx",
  ));
});

after(async () => {
  await vite?.close();
  browser.close();
  restoreBrowserGlobals();
});

test("username-only request is neutral and pending survives closing the view", async () => {
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host);
  let requests = 0;
  let statusReads = 0;
  let requestedLogin = null;
  const api = {
    async getStatus() { statusReads += 1; return status("NONE", true); },
    async request(loginName) {
      requests += 1;
      requestedLogin = loginName;
      return { status: "REQUESTED", reference: REFERENCE };
    },
    async resume() { throw new Error("unexpected"); },
    async complete() { throw new Error("unexpected"); },
  };

  function Harness() {
    const [active, setActive] = useState(true);
    return React.createElement(React.Fragment, null,
      React.createElement("button", { id: "reopen", type: "button", onClick: () => setActive(true) }, "reopen"),
      React.createElement(PasswordRecoveryFlow, {
        active,
        loginName: "user.name",
        api,
        onActiveChange: setActive,
      }));
  }

  await act(async () => root.render(React.createElement(Harness)));
  await flush();
  assert.match(host.textContent, /user\.name/u);
  assert.doesNotMatch(host.textContent, /Admin|Notfall|Freigabezahl/iu);
  await act(async () => host.querySelector(".bonni-password-recovery form").dispatchEvent(
    new browser.Event("submit", { bubbles: true, cancelable: true }),
  ));
  await flush();
  assert.equal(requestedLogin, "user.name");
  assert.equal(requests, 1);
  assert.match(host.textContent, /Die Passwort-Wiederherstellung wurde angefordert\. Bitte wenden Sie sich an den Support\./u);
  assert.match(host.textContent, /VorgangsnummerPR-ABCDE-23456/u);
  assert.match(host.textContent, /Wird geprüft/u);

  await act(async () => button(host, "Zurueck zum Login").click());
  assert.equal(host.querySelector(".bonni-password-recovery"), null);
  await act(async () => host.querySelector("#reopen").click());
  assert.match(host.textContent, /Wird geprüft/u);
  assert.equal(requests, 1, "reopening a pending flow must not create a second request");
  assert.equal(statusReads, 1, "the neutral pending state may be retained without another request");

  await act(async () => root.unmount());
  host.remove();
});

test("approved capability accepts exact 512 codepoints and purges before the pending request", async () => {
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host);
  let received = null;
  let transmitted = null;
  let resolveComplete;
  const pending = new Promise((resolve) => { resolveComplete = resolve; });
  const api = {
    async getStatus() { return status("APPROVED", false); },
    async request() { throw new Error("unexpected"); },
    async resume() { throw new Error("unexpected"); },
    complete(payload) {
      received = payload;
      transmitted = { ...payload };
      return pending;
    },
  };

  await act(async () => root.render(React.createElement(PasswordRecoveryFlow, {
    active: true,
    loginName: "user.name",
    api,
    onActiveChange() {},
  })));
  await flush();
  assert.match(host.textContent, /Freigegeben/u);
  const inputs = [...host.querySelectorAll('input[type="password"]')];
  assert.equal(inputs.length, 2);
  const exact512 = "😀".repeat(512);
  await act(async () => change(inputs[0], exact512));
  await act(async () => change(inputs[1], exact512));
  await act(async () => {
    host.querySelector("form").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  assert.equal(transmitted.newPassword, exact512);
  assert.equal(transmitted.newPasswordConfirmation, exact512);
  assert.equal(inputs[0].value, "");
  assert.equal(inputs[1].value, "");

  await act(async () => browser.dispatchEvent(new browser.Event("pagehide")));
  assert.equal(received.newPassword, undefined);
  assert.equal(received.newPasswordConfirmation, undefined);
  await act(async () => resolveComplete({ status: "COMPLETED", requiresFreshLogin: true }));
  await act(async () => root.unmount());
  host.remove();
});

test("short passwords never leave the form and successful completion requires fresh login", async () => {
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host);
  let completions = 0;
  const api = {
    async getStatus() { return status("APPROVED", false); },
    async request() { throw new Error("unexpected"); },
    async resume() { throw new Error("unexpected"); },
    async complete() { completions += 1; return { status: "COMPLETED", requiresFreshLogin: true }; },
  };
  await act(async () => root.render(React.createElement(PasswordRecoveryFlow, {
    active: true, loginName: "user.name", api, onActiveChange() {},
  })));
  await flush();
  let inputs = [...host.querySelectorAll('input[type="password"]')];
  await act(async () => change(inputs[0], "x".repeat(11)));
  await act(async () => change(inputs[1], "x".repeat(11)));
  await act(async () => host.querySelector("form").dispatchEvent(
    new browser.Event("submit", { bubbles: true, cancelable: true }),
  ));
  assert.equal(completions, 0);
  assert.match(host.textContent, /mindestens 12 Zeichen/u);
  assert.equal(inputs[0].value, "");
  assert.equal(inputs[1].value, "");

  inputs = [...host.querySelectorAll('input[type="password"]')];
  await act(async () => change(inputs[0], "valid-password"));
  await act(async () => change(inputs[1], "valid-password"));
  await act(async () => host.querySelector("form").dispatchEvent(
    new browser.Event("submit", { bubbles: true, cancelable: true }),
  ));
  await flush();
  assert.equal(completions, 1);
  assert.match(host.textContent, /keine automatische Anmeldung/u);
  assert.match(host.textContent, /normalen Login/u);

  await act(async () => root.unmount());
  host.remove();
});

test("optional handoff code is purged from DOM and detached payload on pagehide", async () => {
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host);
  let received = null;
  let resolveResume;
  const pending = new Promise((resolve) => { resolveResume = resolve; });
  const api = {
    async getStatus() { return status("NONE", true); },
    async request() { throw new Error("unexpected"); },
    resume(payload) { received = payload; return pending; },
    async complete() { throw new Error("unexpected"); },
  };
  await act(async () => root.render(React.createElement(PasswordRecoveryFlow, {
    active: true, loginName: "user.name", api, onActiveChange() {},
  })));
  await flush();
  await act(async () => button(host, "Support-Code verwenden").click());
  const input = host.querySelector('input[type="password"]');
  await act(async () => change(input, "ABCDE-23456-BCDEF-34567"));
  await act(async () => {
    host.querySelector("form").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  assert.equal(received.supportCode, "ABCDE-23456-BCDEF-34567");
  assert.equal(input.value, "");
  await act(async () => browser.dispatchEvent(new browser.Event("pagehide")));
  assert.equal(received.supportCode, undefined);
  await act(async () => resolveResume(status("APPROVED", false)));
  await act(async () => root.unmount());
  host.remove();
});

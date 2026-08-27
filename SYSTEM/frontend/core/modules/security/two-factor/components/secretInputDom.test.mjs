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
let vite;
let React;
let act;
let useState;
let createRoot;
let Simulate;
let ExactSecretInput;
let ProviderProofForm;

function installBrowserGlobals() {
  for (const name of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLInputElement",
    "Event",
    "InputEvent",
    "KeyboardEvent",
    "TextEvent",
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

function paste(element, rawText) {
  const event = new browser.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (type) => type === "text" ? rawText : "" },
  });
  element.dispatchEvent(event);
  return event;
}

function beforeInput(element, rawText) {
  // React 18 maps its onBeforeInput synthetic event to the browser's raw
  // textInput event. This exercises the pre-DOM-mutation path.
  const event = new browser.InputEvent("textInput", {
    bubbles: true,
    cancelable: true,
    data: rawText,
    inputType: "insertText",
  });
  element.dispatchEvent(event);
  return event;
}

function changeInput(element, value) {
  Simulate.change(element, { target: { value } });
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
  ({ default: ExactSecretInput } = await vite.ssrLoadModule(
    "/core/modules/security/two-factor/components/ExactSecretInput.jsx",
  ));
  ({ default: ProviderProofForm } = await vite.ssrLoadModule(
    "/core/modules/security/two-factor/components/ProviderProofForm.jsx",
  ));
});

after(async () => {
  await vite?.close();
  browser.close();
  restoreBrowserGlobals();
});

test("ExactSecretInput blocks raw paste/beforeinput before DOM normalization", async () => {
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host);
  let latest = "abcd";

  function Harness() {
    const [value, setValue] = useState("abcd");
    latest = value;
    return React.createElement(ExactSecretInput, {
      value,
      onChange: setValue,
      label: "Passwort",
    });
  }

  await act(async () => root.render(React.createElement(Harness)));
  const input = host.querySelector("input");
  input.setSelectionRange(2, 2);
  let rawEvent;
  await act(async () => { rawEvent = paste(input, "\r\n"); });
  assert.equal(rawEvent.defaultPrevented, true);
  assert.equal(latest, "");
  assert.equal(input.value, "");

  await act(async () => root.render(React.createElement(Harness)));
  await act(async () => { rawEvent = beforeInput(input, "\0"); });
  assert.equal(rawEvent.defaultPrevented, true);
  assert.equal(latest, "");
  assert.equal(input.value, "");

  await act(async () => root.unmount());
  host.remove();
});

test("ProviderProofForm purges proof synchronously before a pending request", async () => {
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host);
  let received = null;
  let resolveRequest;
  const pendingRequest = new Promise((resolve) => { resolveRequest = resolve; });

  await act(async () => root.render(React.createElement(ProviderProofForm, {
    provider: { id: "local", label: "Bonni Core" },
    proofFields: [{ name: "code", label: "Code", type: "password" }],
    onVerify: (proof) => {
      received = proof;
      return pendingRequest;
    },
  })));
  const input = host.querySelector("input");
  await act(async () => changeInput(input, "123456"));

  await act(async () => {
    host.querySelector("form").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }));
  });
  assert.deepEqual(received, { code: "123456" });
  assert.equal(input.value, "", "proof must be gone while onVerify is still pending");

  await act(async () => resolveRequest());
  assert.equal(received.code, "", "detached proof must be overwritten after the request");
  await act(async () => root.unmount());
  host.remove();
});

test("ProviderProofForm rejects raw controls and an empty provider contract", async () => {
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host);
  let verifies = 0;

  await act(async () => root.render(React.createElement(ProviderProofForm, {
    provider: { id: "adapter", label: "Adapter" },
    proofFields: [{ name: "token", label: "Token", type: "password" }],
    onVerify: () => { verifies += 1; },
  })));
  const input = host.querySelector("input");
  await act(async () => changeInput(input, "safe-token"));
  let rawEvent;
  await act(async () => { rawEvent = paste(input, "bad\r\ntoken"); });
  assert.equal(rawEvent.defaultPrevented, true);
  assert.equal(input.value, "");
  await act(async () => {
    host.querySelector("form").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }));
  });
  assert.equal(verifies, 0);

  await act(async () => root.render(React.createElement(ProviderProofForm, {
    provider: { id: "adapter", label: "Adapter" },
    proofFields: [],
    onVerify: () => { verifies += 1; },
  })));
  assert.equal(host.querySelector('button[type="submit"]').disabled, true);
  await act(async () => {
    host.querySelector("form").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }));
  });
  assert.equal(verifies, 0);

  await act(async () => root.unmount());
  host.remove();
});

test("ProviderProofForm token input counts 128 Unicode codepoints and rejects invalid UTF-8", async () => {
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(ProviderProofForm, {
    provider: { id: "adapter", label: "Adapter" },
    proofFields: [{ name: "token", label: "Token", type: "password" }],
    onVerify() {},
  })));
  const input = host.querySelector("input");
  const exactly128Emoji = "😀".repeat(128);
  await act(async () => changeInput(input, exactly128Emoji));
  assert.equal(input.value, exactly128Emoji);
  for (const invalid of ["😀".repeat(129), "\uD800", "token\r\nvalue", "token\0value"]) {
    await act(async () => changeInput(input, invalid));
    assert.equal(input.value, "");
  }
  await act(async () => root.unmount());
  host.remove();
});

test("ProviderProofForm purges proof on cancel, pagehide and unmount", async () => {
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host);
  let cancelled = 0;
  const props = {
    provider: { id: "adapter", label: "Adapter" },
    proofFields: [{ name: "token", label: "Token", type: "password" }],
    onVerify() {},
    onCancel() { cancelled += 1; },
  };
  await act(async () => root.render(React.createElement(ProviderProofForm, props)));
  let input = host.querySelector("input");
  await act(async () => changeInput(input, "cancel-secret"));
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Abbrechen").click());
  assert.equal(input.value, "");
  assert.equal(cancelled, 1);

  await act(async () => changeInput(input, "page-secret"));
  await act(async () => browser.dispatchEvent(new browser.Event("pagehide")));
  assert.equal(input.value, "");

  await act(async () => changeInput(input, "unmount-secret"));
  await act(async () => root.unmount());
  assert.equal(input.value, "");
  host.remove();
});

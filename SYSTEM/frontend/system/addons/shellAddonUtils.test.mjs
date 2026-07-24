import test from "node:test";
import assert from "node:assert/strict";

import {
  addonFrontend,
  addonKey,
  getShellAddonForSlot,
  isEnabledAddon,
} from "./shellAddonUtils.js";

const matrixAddon = {
  key: "addon.matrixchat",
  kind: "addon",
  name: "MatrixChat",
  enabled: true,
  frontend: {
    integration: "iframe",
    runtimeEntry: "/feature-modules/matrixchat/index.html",
  },
  metadata: {
    shellContribution: { slot: "chat-dock" },
  },
};

test("recognizes an enabled add-on independently from apps", () => {
  assert.equal(isEnabledAddon(matrixAddon), true);
  assert.equal(isEnabledAddon({ ...matrixAddon, kind: "app" }), false);
  assert.equal(isEnabledAddon({ ...matrixAddon, enabled: false }), false);
});

test("selects only an enabled iframe contribution for the requested shell slot", () => {
  const result = getShellAddonForSlot([
    { ...matrixAddon, enabled: false },
    { ...matrixAddon, key: "addon.other", metadata: { shellContribution: { slot: "other" } } },
    matrixAddon,
  ], "chat-dock");

  assert.equal(addonKey(result), "addon.matrixchat");
  assert.equal(addonFrontend(result).runtimeEntry, "/feature-modules/matrixchat/index.html");
});

test("supports manifest-nested module package fields", () => {
  const nested = {
    installation: { enabled: true },
    manifest: {
      key: "addon.matrixchat",
      kind: "addon",
      frontend: matrixAddon.frontend,
      metadata: matrixAddon.metadata,
    },
  };

  assert.equal(getShellAddonForSlot([nested], "chat-dock"), nested);
});

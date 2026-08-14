import test from "node:test";
import assert from "node:assert/strict";

import {
  NETWORK_ADDON_KEY,
  findInstalledNetworkAddon,
  modulePackageEnabled,
  modulePackageFrontend,
  modulePackageInstalled,
} from "./networkAddonNavigation.js";
import {
  buildControlCenterNavigation,
} from "../layout/controlCenterNavigation.js";

const networkAddon = {
  key: NETWORK_ADDON_KEY,
  kind: "addon",
  installed: true,
  enabled: true,
  frontend: {
    integration: "iframe",
    runtimeEntry: "/feature-modules/bonni-network/index.html",
  },
};

test("network navigation only discovers the installed Bonni network add-on", () => {
  assert.equal(findInstalledNetworkAddon([{ ...networkAddon, installed: false, enabled: false }]), null);
  assert.equal(findInstalledNetworkAddon([{ ...networkAddon, key: "addon.other" }]), null);
  assert.equal(findInstalledNetworkAddon([networkAddon]), networkAddon);
});

test("installed and enabled states also work with manifest-nested package data", () => {
  const nested = {
    installation: { installed: true, enabled: false, status: "disabled" },
    manifest: {
      key: NETWORK_ADDON_KEY,
      kind: "addon",
      frontend: networkAddon.frontend,
    },
  };

  assert.equal(modulePackageInstalled(nested), true);
  assert.equal(modulePackageEnabled(nested), false);
  assert.equal(modulePackageFrontend(nested).runtimeEntry, networkAddon.frontend.runtimeEntry);
  assert.equal(findInstalledNetworkAddon([nested]), nested);
});

test("network tab is appended and omitted without the add-on", () => {
  const hidden = buildControlCenterNavigation(false);
  const visible = buildControlCenterNavigation(true);
  assert.equal(hidden.some((item) => item.key === "network"), false);
  assert.equal(visible.at(-1)?.key, "network");
});

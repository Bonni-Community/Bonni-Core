import assert from "node:assert/strict";
import test from "node:test";

import {
  canOpenLaunchTarget,
  getAssignedTargets,
  getLaunchTarget,
  getWorkspaceForLaunchTarget,
} from "./accessPolicy.js";

const shell = {
  identity: {
    type: "PERSON",
    roles: ["access:app:app-example:operator"],
  },
  permissions: {
    moduleAccess: [{
      kind: "app",
      moduleKey: "app.example",
      permissions: ["operator"],
    }],
  },
};

test("derives arbitrary app access from canonical Core grants", () => {
  assert.deepEqual(getAssignedTargets({}, shell), ["app.example"]);
  assert.equal(canOpenLaunchTarget("app.example", {}, shell), true);
  assert.equal(canOpenLaunchTarget("app.other", {}, shell), false);
  assert.equal(getWorkspaceForLaunchTarget("app.example", {}, shell), "OPERATOR");
});

test("personal identities start in Core while a terminal may open its sole app", () => {
  assert.equal(getLaunchTarget({}, shell), "home");
  assert.equal(getLaunchTarget({}, {
    ...shell,
    identity: { ...shell.identity, type: "TERMINAL" },
  }), "app.example");
});

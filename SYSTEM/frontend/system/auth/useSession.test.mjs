import assert from "node:assert/strict";
import test from "node:test";

import { getAssignedWorkspaces } from "./useSession.js";

test("manifest workspace wins over profile permission and canonical role", () => {
  const shell = {
    identity: {
      roles: ["access:app:app-example:operator"],
      moduleAccess: [{
        kind: "app",
        moduleKey: "app.example",
        workspace: "TERMINAL",
        permissions: ["operator"],
      }],
    },
    permissions: {
      roles: ["access:app:app-example:operator"],
    },
  };

  assert.deepEqual(getAssignedWorkspaces({}, shell), ["TERMINAL"]);
});

test("permission and canonical role remain fallbacks without manifest workspace", () => {
  assert.deepEqual(getAssignedWorkspaces({}, {
    permissions: {
      moduleAccess: [{
        kind: "app",
        moduleKey: "app.example",
        permissions: ["operator"],
      }],
    },
  }), ["OPERATOR"]);

  assert.deepEqual(getAssignedWorkspaces({}, {
    identity: {
      roles: ["access:app:app-example:terminal"],
    },
  }), ["TERMINAL"]);
});

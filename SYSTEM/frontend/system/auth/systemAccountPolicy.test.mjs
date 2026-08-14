import assert from "node:assert/strict";
import test from "node:test";

import {
  BOOTSTRAP_ADMIN_LOGIN_NAME,
  isBootstrapAdminLoginName,
  isForbiddenLoginName,
} from "./systemAccountPolicy.js";

test("admin is the fixed bootstrap login name", () => {
  assert.equal(BOOTSTRAP_ADMIN_LOGIN_NAME, "admin");
  assert.equal(isBootstrapAdminLoginName(" ADMIN "), true);
  assert.equal(isBootstrapAdminLoginName("administrator"), false);
});

test("root is forbidden as an application login name", () => {
  assert.equal(isForbiddenLoginName("root"), true);
  assert.equal(isForbiddenLoginName(" ROOT "), true);
  assert.equal(isForbiddenLoginName("member"), false);
});

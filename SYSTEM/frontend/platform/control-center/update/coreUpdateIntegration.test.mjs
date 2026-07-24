import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Control Center sends a confirmed target version to the protected install endpoint", async () => {
  const [api, topbar, popover] = await Promise.all([
    readFile(new URL("../../../system/api/coreUpdateApi.js", import.meta.url), "utf8"),
    readFile(new URL("../layout/ControlCenterTopBar.jsx", import.meta.url), "utf8"),
    readFile(new URL("./CoreUpdatePopover.jsx", import.meta.url), "utf8"),
  ]);

  assert.match(api, /\/install/);
  assert.match(api, /body:\s*\{ targetVersion \}/);
  assert.match(topbar, /installCoreUpdate\(token, updateStatus\?\.targetVersion\)/);
  assert.match(popover, /runnerUnavailable/);
  assert.match(popover, /Update installieren/);
});

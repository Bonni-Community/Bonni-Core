import assert from "node:assert/strict";
import test from "node:test";

import { normalizeBrowserApiUrl } from "./apiClient.js";

test("browser API requests cannot bypass the same-origin proxy", () => {
  assert.equal(
    normalizeBrowserApiUrl(
      "http://127.0.0.1:4001/api/apps/stueberlapp/application-docks/member/analysis",
      "http://localhost:5173",
    ),
    "http://localhost:5173/api/apps/stueberlapp/application-docks/member/analysis",
  );
  assert.equal(
    normalizeBrowserApiUrl(
      "http://localhost:4000/api/auth/shell",
      "http://localhost:5173",
    ),
    "http://localhost:5173/api/auth/shell",
  );
  assert.equal(
    normalizeBrowserApiUrl(
      "https://example.org/public/image.png",
      "http://localhost:5173",
    ),
    "https://example.org/public/image.png",
  );
});

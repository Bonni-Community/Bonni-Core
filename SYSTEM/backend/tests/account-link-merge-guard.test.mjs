import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAccountLinkMemberMergeAllowed,
} from "../dist/system/routes/explorer/account-link.service.js";

test("account links stop every automatic merge of two existing member profiles", () => {
  assert.throws(
    () => assertAccountLinkMemberMergeAllowed(
      { id: "member-target" },
      { id: "member-primary" },
    ),
    (error) => (
      error?.statusCode === 409
      && error?.code === "ACCOUNT_LINK_MEMBER_MERGE_REVIEW_REQUIRED"
      && error?.details?.targetMemberId === "member-target"
      && error?.details?.primaryMemberId === "member-primary"
    ),
  );
});

test("account links without two member profiles remain eligible", () => {
  assert.doesNotThrow(() => assertAccountLinkMemberMergeAllowed(null, null));
  assert.doesNotThrow(() => assertAccountLinkMemberMergeAllowed({ id: "target" }, null));
  assert.doesNotThrow(() => assertAccountLinkMemberMergeAllowed(null, { id: "primary" }));
});

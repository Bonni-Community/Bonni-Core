import assert from "node:assert/strict";
import test from "node:test";

import {
  createStagedModuleTwoFactorProviderRuntime,
  getActiveExternalTwoFactorProvider,
  getExternalTwoFactorProviderAdminStates,
  getRegisteredExternalTwoFactorProviders,
} from "../dist/platform/security/two-factor/two-factor-provider-registry.js";

function provider(id, label, state) {
  return {
    id,
    label,
    async getState() {
      return {
        enabled: state.enabled,
        configured: true,
        policy: { challengeExpiresSeconds: 60, maxAttempts: 8, proofFields: [] },
      };
    },
    async verify() { return { ok: true }; },
    async getAdminConfiguration() { return { values: {}, sections: [] }; },
    async updateAdminConfiguration() { return { values: {}, sections: [] }; },
  };
}

test("multiple two-factor provider plugins can be installed while exactly one is active", async () => {
  const firstState = { enabled: true };
  const secondState = { enabled: false };
  const first = createStagedModuleTwoFactorProviderRuntime("plugin.first-2fa");
  const second = createStagedModuleTwoFactorProviderRuntime("plugin.second-2fa");

  try {
    first.runtime.registerProvider(provider("first", "First provider", firstState));
    second.runtime.registerProvider(provider("second", "Second provider", secondState));
    first.activate();
    second.activate();

    assert.deepEqual(
      getRegisteredExternalTwoFactorProviders().map((entry) => entry.id),
      ["first", "second"],
    );
    assert.deepEqual(
      (await getExternalTwoFactorProviderAdminStates()).map((entry) => entry.id),
      ["first", "second"],
    );
    assert.equal((await getActiveExternalTwoFactorProvider())?.provider.id, "first");

    secondState.enabled = true;
    await assert.rejects(
      getActiveExternalTwoFactorProvider(),
      (error) => error?.code === "TWO_FACTOR_MULTIPLE_ACTIVE_PROVIDERS",
    );
  } finally {
    first.dispose();
    second.dispose();
  }

  assert.equal(getRegisteredExternalTwoFactorProviders().length, 0);
});

test("a two-factor provider id remains unique across plugins", () => {
  const owner = createStagedModuleTwoFactorProviderRuntime("plugin.provider-owner");
  const contender = createStagedModuleTwoFactorProviderRuntime("plugin.provider-contender");
  try {
    owner.runtime.registerProvider(provider("shared", "Shared provider", { enabled: false }));
    contender.runtime.registerProvider(provider("shared", "Duplicate provider", { enabled: false }));
    owner.activate();
    assert.throws(
      () => contender.activate(),
      (error) => error?.code === "TWO_FACTOR_PROVIDER_ID_OCCUPIED",
    );
  } finally {
    owner.dispose();
    contender.dispose();
  }
});

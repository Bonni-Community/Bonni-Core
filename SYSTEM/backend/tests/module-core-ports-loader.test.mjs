import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("module loader injects every new Core port only behind its declared dependency", async () => {
  const loader = await readFile(
    new URL(
      "../dist/platform/module-manager/loader/module-runtime.service.js",
      import.meta.url,
    ),
    "utf8",
  );

  for (const [dependency, service, creator] of [
    ["core.request-identity", "requestIdentity", "createModuleRequestIdentityRuntime"],
    ["core.members", "members", "createModuleMembersRuntime"],
    ["core.archive", "archive", "createModuleArchiveRuntime"],
    ["core.module-settings", "moduleSettings", "createModuleSettingsRuntime"],
    ["core.two-factor", "twoFactor", "createModuleTwoFactorRuntime"],
    ["core.private-data", "privateData", "createModulePrivateDataRuntime"],
    ["core.protected-people", "protectedPeople", "createModuleProtectedPeopleRuntime"],
    ["core.protected-organization", "protectedOrganization", "createModuleProtectedOrganizationRuntime"],
    ["core.instance-identity", "instanceIdentity", "createModuleInstanceIdentityRuntime"],
  ]) {
    assert.match(
      loader,
      new RegExp(
        `declaredDependencies\\.has\\("${dependency.replaceAll(".", "\\.")}"\\)[\\s\\S]*?${service}: ${creator}\\(`,
      ),
    );
  }
  assert.match(
    loader,
    /createModuleMembersRuntime\(\s*module\.key,\s*manifest\?\.metadata\?\.accessProfiles,\s*manifest\?\.metadata\?\.legacyAccessMappings/s,
  );
  assert.match(loader, /declaredDependencies\.has\("core\.two-factor-provider"\)[\s\S]*?twoFactorProvider: twoFactorProviderRuntime\.runtime/);
  assert.match(loader, /createStagedModuleTwoFactorProviderRuntime\(module\.key\)/);
  assert.match(
    loader,
    /const domainMessageRuntime = declaredDependencies\.has\("core\.domain-messages"\)\s*\? createModuleDomainMessageRuntime\(module\.key, corePrisma\)\s*: null/,
  );
  assert.doesNotMatch(
    loader,
    /const domainMessageRuntime = createModuleDomainMessageRuntime\(/,
  );
  assert.match(loader, /function runtimeModuleKeyForApiPath\(/);
  assert.match(loader, /app\.use\(recoverMissingModuleRoute\)/);
  assert.match(loader, /MODULE_RUNTIME_LOAD_FAILED/);
});

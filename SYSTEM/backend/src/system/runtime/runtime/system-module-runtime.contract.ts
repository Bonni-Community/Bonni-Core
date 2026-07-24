export const systemModuleRuntimeContract = {
  key: "system.modules.runtime",
  owner: "system",
  routeBase: "/api/system/runtime/modules",
  uses: [
    "platform.module-manager.registry",
    "platform.module-manager.installation",
    "platform.module-manager.lifecycle",
  ],
  provides: [
    "system.modules.runtime.facade",
    "system.modules.install-plan.facade",
    "system.modules.lifecycle.facade",
  ],
} as const;

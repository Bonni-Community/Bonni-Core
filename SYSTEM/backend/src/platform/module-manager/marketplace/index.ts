import { listModulePackages } from "../install/index.js";

export async function getInstallationSummary() {
  const packages = await listModulePackages();
  return {
    ok: true,
    total: packages.length,
    installed: packages.filter((item: any) => item.installed).length,
    enabled: packages.filter((item: any) => item.enabled).length,
    items: packages,
  };
}

export async function listInstallationStates() {
  return listModulePackages();
}

export async function listMarketplaceItems() {
  return listModulePackages();
}

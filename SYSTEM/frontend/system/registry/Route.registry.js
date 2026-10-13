import UserPage from "../../platform/control-center/benutzer/UserPage.jsx";
import ProviderPage from "../../platform/control-center/provider/ProviderPage.jsx";
import SchnittstellenPage from "../../platform/control-center/schnittstellen/SchnittstellenPage.jsx";
import ServerPage from "../../platform/control-center/server/ServerPage.jsx";
import StorePage from "../../platform/control-center/store/StorePage.jsx";
import BackupPage from "../../platform/control-center/backup/BackupPage.jsx";
import SystemPage from "../../platform/control-center/system/SystemPage.jsx";
import ExplorerPage from "../../platform/control-center/explorer/ExplorerPage.jsx";
import CoreDiagnosticsPage from "../../platform/control-center/diagnostics/CoreDiagnosticsPage.jsx";

export const moduleRoutes = {
  user: UserPage,
  provider: ProviderPage,
  interfaces: SchnittstellenPage,
  server: ServerPage,
  store: StorePage,
  backup: BackupPage,
  system: SystemPage,
  diagnostics: CoreDiagnosticsPage,
  explorer: ExplorerPage,
};

export function getModulePage(moduleKey) {
  return moduleRoutes[moduleKey] || null;
}

export default moduleRoutes;

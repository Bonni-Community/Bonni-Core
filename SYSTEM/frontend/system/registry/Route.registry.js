import UserPage from "../../platform/control-center/benutzer/UserPage.jsx";
import ProviderPage from "../../platform/control-center/provider/ProviderPage.jsx";
import SchnittstellenPage from "../../platform/control-center/schnittstellen/SchnittstellenPage.jsx";
import ServerPage from "../../platform/control-center/server/ServerPage.jsx";
import StorePage from "../../platform/control-center/store/StorePage.jsx";
import BackupPage from "../../platform/control-center/backup/BackupPage.jsx";
import SystemPage from "../../platform/control-center/system/SystemPage.jsx";
import DiagnosePage from "../../platform/control-center/diagnose/DiagnosePage.jsx";
import ExplorerPage from "../../platform/control-center/explorer/ExplorerPage.jsx";
import LizenzPage from "../../platform/control-center/lizenz/LizenzPage.jsx";
import LogsPage from "../../platform/control-center/logs/LogsPage.jsx";

export const moduleRoutes = {
  user: UserPage,
  provider: ProviderPage,
  interfaces: SchnittstellenPage,
  server: ServerPage,
  store: StorePage,
  backup: BackupPage,
  system: SystemPage,
  diagnostics: DiagnosePage,
  explorer: ExplorerPage,
  license: LizenzPage,
  logs: LogsPage,
};

export function getModulePage(moduleKey) {
  return moduleRoutes[moduleKey] || null;
}

export default moduleRoutes;

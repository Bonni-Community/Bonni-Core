export type ModuleKind = "app" | "addon" | "plugin" | "bridge";

export type ModuleInstallStatus =
  | "discovered"
  | "installed"
  | "enabled"
  | "disabled"
  | "update_available"
  | "update_failed"
  | "error"
  | "uninstalled"
  | "deleted";

export type ModuleInstallEventType =
  | "discovered"
  | "installed"
  | "updated"
  | "enabled"
  | "disabled"
  | "uninstalled"
  | "deleted"
  | "failed"
  | "rolled_back";

export type ModuleRuntimeStatus = "not_loaded" | "loading" | "loaded" | "error" | "unloaded";

export type ModuleManifest = {
  key: string;
  kind: ModuleKind;
  name: string;
  version: string;
  description?: string;
  backend?: { entry?: string };
  frontend?: {
    entry?: string;
    runtimeEntry?: string;
    integration?: "module" | "iframe";
    publicRoot?: string;
    mountPath?: string;
    route?: string;
  };
  prisma?: { source?: string; assembled?: string; exclude?: string[] };
  provides?: string[];
  dependsOn?: string[];
  permissions?: string[] | { provides?: string[]; requires?: string[] };
  navigation?: unknown[];
  compatibility?: {
    minimumCoreVersion?: string;
    maximumCoreVersion?: string;
    bonniCore?: {
      minimumVersion?: string;
      maximumVersion?: string;
    };
  };
  installation?: {
    installable?: boolean;
    autoInstall?: boolean;
    snapshotRequired?: boolean;
    rollbackSupported?: boolean;
    healthcheckRequired?: boolean;
  };
  metadata?: Record<string, unknown>;
};

export type ModuleManifestSummary = ModuleManifest & {
  sourcePath?: string;
  manifestPath?: string;
};

export type InstalledModuleSummary = {
  id?: string;
  key: string;
  kind: ModuleKind;
  name: string;
  label: string;
  version: string;
  status: ModuleInstallStatus;
  installed: boolean;
  enabled: boolean;
  sourcePath?: string | null;
  installPath?: string | null;
  backendEntry?: string | null;
  frontendEntry?: string | null;
  prismaSourcePath?: string | null;
  assembledPrismaPath?: string | null;
  manifest?: unknown;
  manifestJson?: unknown;
  lastError?: string | null;
  installedAt?: string | Date | null;
  enabledAt?: string | Date | null;
  disabledAt?: string | Date | null;
  uninstalledAt?: string | Date | null;
  deletedAt?: string | Date | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
};

export type CoreModuleDefinition = {
  key: string;
  label: string;
  description?: string;
  icon?: string;
  route?: string;
  source?: "bonni-core";
  version?: string;
  installed?: boolean;
  enabled?: boolean;
  visible?: boolean;
  sortOrder?: number;
};

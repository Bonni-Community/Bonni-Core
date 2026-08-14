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

export type ModuleFrontendTransport = "opaque-rpc-v1";

export type ModuleAccessProfile = {
  key: string;
  label: string;
  permission: string;
  workspace: string;
  usage: "local" | "technical";
  accountType: "MEMBER" | "ADMIN" | "TERMINAL" | "SERVICE";
};

export type ModuleTechnicalAccountDeclaration = {
  loginName: string;
  profileKey: string;
  label: string;
  legacyRoleKeys: string[];
};

export type ModuleLegacyAccessMappings = {
  roles?: Record<string, string>;
  capabilities?: Record<string, string>;
};

export type ModuleDatabaseDomain =
  | "hocket"
  | "kontor"
  | "meet"
  | "stueberl"
  | "pos";

export type ModuleDatabaseDeclaration =
  | {
      /** The module deliberately receives no direct database capability. */
      mode: "none";
    }
  | {
      mode: "scoped-v1";
      domain: ModuleDatabaseDomain;
      delegates: string[];
      appDelegates?: string[];
      coreDelegates?: string[];
    };

export type ModuleRpcBodyPolicy = {
  type?: "none" | "json" | "form-data" | "blob";
  maxBytes?: number;
  schema?: Record<string, unknown>;
  contentType?: string;
  required?: boolean;
};

export type ModuleRpcRoute = {
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  idempotency?: "required" | "optional" | "forbidden";
  query?: boolean | "any" | "none" | string[];
  body?: "none" | "json" | "form-data" | "blob" | ModuleRpcBodyPolicy;
  headers?: string[];
  responseType?: "json" | "text" | "blob";
};

export type ModuleRpcContract = {
  schemaVersion: "bonni.module-rpc/v1";
  moduleId: string;
  basePath: string;
  maxBodyBytes?: number;
  routes: ModuleRpcRoute[];
};

export type ModuleManifestFrontend = {
  entry?: string;
  runtimeEntry?: string;
  integration?: "module" | "iframe";
  transport?: ModuleFrontendTransport;
  /**
   * Source manifests declare a package-relative JSON path. Manifest discovery
   * replaces it with the validated, immutable contract document and preserves
   * the original value in rpcContractPath.
   */
  rpcContract?: string | ModuleRpcContract;
  rpcContractPath?: string;
  publicRoot?: string;
  mountPath?: string;
  publicEntry?: string;
  memberEntry?: string;
  route?: string;
  sandboxCapabilities?: Array<"downloads" | "forms" | "popups">;
};

export type ModuleLegalPayloadDeclaration = {
  schemaVersion: "bonni.module-legal/v1";
  notices: string;
  payloadRoots: string[];
  treeSha256: string;
  fileCount: number;
};

export type ModuleManifest = {
  key: string;
  kind: ModuleKind;
  name: string;
  version: string;
  description?: string;
  backend?: { entry?: string };
  frontend?: ModuleManifestFrontend;
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
  legal?: ModuleLegalPayloadDeclaration;
  metadata?: Record<string, unknown> & {
    database?: ModuleDatabaseDeclaration;
    accessProfiles?: ModuleAccessProfile[];
    autoAssignMemberAccess?: boolean;
    technicalAccounts?: ModuleTechnicalAccountDeclaration[];
    legacyAccessMappings?: ModuleLegacyAccessMappings;
  };
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

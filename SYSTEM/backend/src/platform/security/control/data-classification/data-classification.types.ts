export type DataClassificationArea =
  | "UNCLASSIFIED"
  | "PUBLIC_DATA"
  | "INTERNAL_DATA"
  | "PERSONAL_DATA"
  | "EMERGENCY_DATA"
  | "MEDICAL_DATA"
  | "DIETARY_DATA"
  | "DSGVO_DATA"
  | "SECURITY_DATA"
  | "FINANCIAL_DATA"
  | "SYSTEM_DATA";

export type DataClassificationStatus = "CLASSIFIED" | "UNCLASSIFIED" | "SUGGESTED" | "IGNORED";

export type DataClassificationSeverity = "OK" | "INFO" | "WARNING" | "ACTION_REQUIRED";

export type DataClassificationReviewStatus =
  | "UNCLASSIFIED"
  | "IN_REVIEW"
  | "NEEDS_REVIEW"
  | "APPROVED"
  | "IGNORED";

export type DataClassificationProfileKey =
  | "PUBLIC_MODULE"
  | "INTERNAL_MODULE"
  | "SYSTEM_MODULE"
  | "SECURITY_SYSTEM_MODULE"
  | "DSGVO_MODULE"
  | "ACCOUNT_SECURITY_MODULE"
  | "PERSONAL_MEMBER_MODULE"
  | "MEMBER_FACHMODULE"
  | "DIETARY_MEMBER_MODULE"
  | "MEDICAL_MEMBER_MODULE"
  | "EMERGENCY_MEMBER_MODULE"
  | "ORDER_FINANCE_MEMBER_MODULE";

export type DataClassificationCapability = {
  usesMemberId: boolean;
  usesAccountId: boolean;
  requiresMasterKey: boolean;
  requires2FA: boolean;
  auditAlways: boolean;
};

export type DataClassificationProfile = DataClassificationCapability & {
  key: DataClassificationProfileKey;
  label: string;
  areas: DataClassificationArea[];
  dsgvoRelevant: boolean;
  description: string;
};

export type DataClassificationOverrides = Partial<DataClassificationCapability> & {
  areas?: DataClassificationArea[];
  dsgvoRelevant?: boolean;
};

export type DataClassificationDeclaration = Partial<DataClassificationCapability> & {
  /**
   * Verweis auf ein zentrales Datenschutzprofil.
   * Module sollten bevorzugt nur dieses Profil setzen und Sonderfälle über overrides abbilden.
   */
  profile?: DataClassificationProfileKey;
  /**
   * Direkte areas sind weiterhin erlaubt, aber für neue Module ist profile bevorzugt.
   */
  areas?: DataClassificationArea[];
  /**
   * Direkte Kennzeichnung ist weiterhin erlaubt, profile ist aber bevorzugt.
   */
  dsgvoRelevant?: boolean;
  /**
   * Sonderfälle gegenüber dem Profil, z. B. requires2FA: true.
   */
  overrides?: DataClassificationOverrides;
  owner?: string;
  note?: string;
  reviewStatus?: DataClassificationReviewStatus;
  reviewedAt?: string;
  reviewedBy?: string;
};

export type ResolvedDataClassificationDeclaration = DataClassificationCapability & {
  profile: DataClassificationProfileKey | null;
  profileLabel: string | null;
  areas: DataClassificationArea[];
  dsgvoRelevant: boolean;
  owner: string | null;
  note: string | null;
  reviewStatus?: DataClassificationReviewStatus;
  reviewedAt: string | null;
  reviewedBy: string | null;
};

export type DataClassificationModuleSummary = {
  moduleId: string;
  label: string;
  kind: string;
  domain: string;
  status: string;
  sourceRoots: string[];
  runtimeRoutes: string[];
  classificationStatus: DataClassificationStatus;
  severity: DataClassificationSeverity;
  profile: DataClassificationProfileKey | null;
  profileLabel: string | null;
  areas: DataClassificationArea[];
  capabilities: DataClassificationCapability;
  dsgvoRelevant: boolean;
  inferred: {
    usesMemberId: boolean;
    usesAccountId: boolean;
    reason: string[];
  };
  criticalOpen: boolean;
  owner: string | null;
  note: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  actions: string[];
};

export type DataClassificationOverview = {
  ok: boolean;
  area: "system/security/data-classification";
  generatedAt: string;
  policy: {
    mode: "OVERVIEW_ONLY";
    defaultClassification: "UNCLASSIFIED";
    activeIdentifiers: ["memberId", "accountId"];
    ignoredIdentifiers: ["userId", "personId"];
    blocking: false;
    preferredDeclarationMode: "PROFILE_REFERENCE";
  };
  profiles: Array<{
    key: DataClassificationProfileKey;
    label: string;
    areas: DataClassificationArea[];
    usesMemberId: boolean;
    usesAccountId: boolean;
    requiresMasterKey: boolean;
    requires2FA: boolean;
    auditAlways: boolean;
    dsgvoRelevant: boolean;
    description: string;
  }>;
  summary: {
    totalModuleCount: number;
    classifiedCount: number;
    suggestedCount: number;
    unclassifiedCount: number;
    ignoredCount: number;
    criticalUnclassifiedCount: number;
    usesMemberIdCount: number;
    usesAccountIdCount: number;
    requiresMasterKeyCount: number;
    requires2FACount: number;
    auditAlwaysCount: number;
    dsgvoRelevantCount: number;
  };
  modules: DataClassificationModuleSummary[];
};

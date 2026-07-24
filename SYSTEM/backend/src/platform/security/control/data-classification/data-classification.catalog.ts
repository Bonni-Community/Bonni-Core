import type { DataClassificationDeclaration } from "./data-classification.types.js";

/**
 * Optional, explicit declarations for modules/domains.
 *
 * New modules should preferably reference a central privacy profile instead of
 * copying the full data classification block into every manifest.
 *
 * Example for a module manifest or catalog entry:
 *
 * dataClassification: {
 *   profile: "DIETARY_MEMBER_MODULE",
 *   reviewStatus: "APPROVED",
 *   note: "Unverträglichkeiten werden verschlüsselt, aber nicht als medizinische Sonderdaten behandelt.",
 * }
 *
 * Modules that are not listed remain UNCLASSIFIED and are shown in the Control
 * Center as items that still need a conscious privacy/security review.
 */
export const systemDataClassificationCatalog: Record<string, DataClassificationDeclaration> = {
  system: {
    profile: "SYSTEM_MODULE",
    reviewStatus: "APPROVED",
    note: "Technical platform runtime. No fachlicher memberId/accountId root.",
  },

  controlsystem: {
    profile: "SECURITY_SYSTEM_MODULE",
    reviewStatus: "APPROVED",
    note: "System and security steering area.",
  },

  "policy-data-protection": {
    profile: "DSGVO_MODULE",
    reviewStatus: "APPROVED",
    note: "DSGVO module area. MemberID is root, AccountIDs are included for linked accounts.",
  },

  /**
   * Beispiele für spätere Fachmodule:
   *
   * kitchen: {
   *   profile: "DIETARY_MEMBER_MODULE",
   *   reviewStatus: "APPROVED",
   *   note: "Unverträglichkeiten sind personenbezogen verschlüsselt, aber nicht medizinisch klassifiziert.",
   * },
   *
   * medical: {
   *   profile: "MEDICAL_MEMBER_MODULE",
   *   reviewStatus: "APPROVED",
   * },
   *
   * emergency: {
   *   profile: "EMERGENCY_MEMBER_MODULE",
   *   reviewStatus: "APPROVED",
   * },
   */
};

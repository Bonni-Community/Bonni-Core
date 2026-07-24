import { z } from "zod";

export const initializeMasterKeyStorageSchema = z.object({
  directoryPath: z.string().min(1),
  fileName: z.string().min(1).optional(),
  overwrite: z.boolean().optional(),
  loadAfterCreate: z.boolean().optional(),
  confirmationPhrase: z.string().min(1),
});

export const loadMasterKeyFromFileSchema = z.object({
  filePath: z.string().min(1),
});

export const bootWithoutKeyDecisionSchema = z.object({
  continueWithoutBootStick: z.boolean(),
  confirmationPhrase: z.string().optional(),
});

export const developerBootModeSchema = z.object({
  enabled: z.boolean(),
  confirmationPhrase: z.string().optional(),
  reason: z.string().max(500).optional(),
});

export type InitializeMasterKeyStorageBody = z.infer<typeof initializeMasterKeyStorageSchema>;
export type LoadMasterKeyFromFileBody = z.infer<typeof loadMasterKeyFromFileSchema>;
export type BootWithoutKeyDecisionBody = z.infer<typeof bootWithoutKeyDecisionSchema>;
export type DeveloperBootModeBody = z.infer<typeof developerBootModeSchema>;

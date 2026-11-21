export class BackupFolderError extends Error {
  code: string;
  statusCode: number;
  constructor(code: string, statusCode: number, message: string);
}
export type BackupLocation = { id: string; directory: string; absolutePath: string };
export function resolveBackupFolder(root: string, relativePath?: unknown, options?: { create?: boolean }): Promise<{
  root: string; absolutePath: string; relativePath: string;
}>;
export function resolveBackupWorkspaceEntry(root: string, relativePath: unknown, options?: { directory?: boolean }): Promise<{
  absolutePath: string; relativePath: string;
}>;
export function listBackupLocations(root: string): Promise<BackupLocation[]>;
export function findBackupLocation(root: string, id: string): Promise<BackupLocation | undefined>;

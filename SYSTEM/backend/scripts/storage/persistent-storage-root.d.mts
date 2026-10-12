export type PersistentStorageRootOptions = {
  environment?: NodeJS.ProcessEnv;
  currentDirectory?: string;
};

export declare function resolvePersistentStorageRoot(
  options?: PersistentStorageRootOptions,
): string;

export declare function resolvePersistentMediaStorageRoot(
  options?: PersistentStorageRootOptions,
): string;


export function createPrivateErrorStream(write: (value: string) => void): {channel(): {write(chunk: string | Buffer): void; end(): void}};

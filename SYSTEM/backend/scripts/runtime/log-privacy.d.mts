export const OMITTED: string;
export function privateCode(value: unknown): string;
export function privateMessage(value: unknown): string;
export function privateStack(value: unknown): string;
export function privateValue(value: unknown, key?: string, seen?: WeakSet<object>, depth?: number): any;
export function privateLine(value: unknown): string;
export function privateText(value: unknown): string;
export function createPrivateLineWriter(write: (value: string) => void): {write(chunk: string | Buffer): void; end(): void};

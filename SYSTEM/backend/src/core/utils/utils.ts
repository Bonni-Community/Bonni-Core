export function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

export function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

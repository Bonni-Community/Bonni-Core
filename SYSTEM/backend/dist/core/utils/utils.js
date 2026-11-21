export function toArray(value) {
    if (value == null) {
        return [];
    }
    return Array.isArray(value) ? value : [value];
}
export function unique(values) {
    return Array.from(new Set(values));
}

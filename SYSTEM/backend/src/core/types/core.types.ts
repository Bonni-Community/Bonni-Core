export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type RuntimeMode = "run" | "demo" | "development";
export type ModuleKind = "app" | "add-on" | "plug-in";

export type ModuleRootKind = "app" | "add-on" | "plug-in";

export type ModuleRootDefinition = {
  kind: ModuleRootKind;
  root: string;
  label: string;
};

export const moduleRootDefinitions: ModuleRootDefinition[] = [];

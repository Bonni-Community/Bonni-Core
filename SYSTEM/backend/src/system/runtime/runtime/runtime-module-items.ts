// Package metadata describes the selected files. Installation records must
// not overwrite it with an older version; live runtime results take precedence.
function itemKey(item: any) {
  return item?.key || item?.id || "";
}

function itemLabel(item: any) {
  return item?.label || item?.name || item?.displayName || itemKey(item) || "Module";
}

function normalizeItem(item: any) {
  const status = String(item?.status || item?.installStatus || "discovered").toLowerCase();
  const installed = Boolean(item?.installed || ["installed", "enabled", "disabled", "update_available", "error"].includes(status));
  const enabled = Boolean(item?.enabled || status === "enabled");

  return {
    ...item,
    key: itemKey(item),
    label: itemLabel(item),
    name: itemLabel(item),
    kind: String(item?.kind || "app").toLowerCase(),
    status,
    installStatus: status,
    installed,
    enabled,
    manageable: true,
    route: `/system/modules?selected=${encodeURIComponent(itemKey(item))}`,
  };
}

export function mergeRuntimeModuleItems(packages: any[], installed: any[], runtime: any[]) {
  const byKey = new Map<string, any>();
  for (const item of [...installed, ...packages, ...runtime]) {
    const key = itemKey(item);
    if (!key) continue;
    byKey.set(key, { ...(byKey.get(key) || {}), ...item });
  }
  return Array.from(byKey.values()).map(normalizeItem).sort((left, right) => (
    String(left.kind).localeCompare(String(right.kind), "de") ||
    String(left.label).localeCompare(String(right.label), "de")
  ));
}

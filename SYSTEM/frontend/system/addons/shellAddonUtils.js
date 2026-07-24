function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function addonKey(addon) {
  return String(addon?.key || addon?.id || addon?.manifest?.key || "").trim();
}

export function addonName(addon) {
  return String(
    addon?.name
    || addon?.label
    || addon?.manifest?.name
    || addon?.manifest?.label
    || addonKey(addon)
    || "Add-on",
  ).trim();
}

export function addonFrontend(addon) {
  return {
    ...object(addon?.manifest?.frontend),
    ...object(addon?.frontend),
  };
}

export function addonMetadata(addon) {
  return {
    ...object(addon?.manifest?.metadata),
    ...object(addon?.metadata),
  };
}

export function isEnabledAddon(addon) {
  const kind = String(addon?.kind || addon?.manifest?.kind || "").trim().toLowerCase();
  const installation = object(addon?.installation);
  return kind === "addon" && Boolean(addon?.enabled || installation.enabled);
}

export function getShellAddonForSlot(packages, slot) {
  return (Array.isArray(packages) ? packages : [])
    .filter(isEnabledAddon)
    .filter((addon) => addonMetadata(addon)?.shellContribution?.slot === slot)
    .filter((addon) => {
      const frontend = addonFrontend(addon);
      return frontend.integration === "iframe" && Boolean(frontend.runtimeEntry || frontend.runtimeUrl);
    })
    .sort((left, right) => addonName(left).localeCompare(addonName(right), "de"))[0] || null;
}

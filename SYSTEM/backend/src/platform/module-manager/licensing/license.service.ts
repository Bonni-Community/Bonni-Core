export async function getLicenseStatus() {
  return {
    active: false,
    valid: true,
    reason: "BONNI_CORE_COMMUNITY",
    checkedAt: new Date().toISOString(),
    license: {
      licenseType: "community",
      customerName: "Bonni Core",
      validUntil: null,
    },
  };
}

export async function getSystemLicensesOverview() {
  return {
    ok: true,
    area: "licenses",
    localAvailable: true,
    note: "Bonni Core läuft ohne Zusatzlizenz. Lizenzmodule können später als Plug-in installiert werden.",
    status: await getLicenseStatus(),
  };
}

export async function validateSystemLicense(licenseKey: string) {
  return {
    valid: Boolean(String(licenseKey || "").trim()),
    reason: String(licenseKey || "").trim() ? "LICENSE_KEY_ACCEPTED_FOR_VALIDATION" : "LICENSE_KEY_REQUIRED",
  };
}

export async function activateSystemLicense(licenseKey: string) {
  const validation = await validateSystemLicense(licenseKey);
  return {
    activated: validation.valid,
    ...validation,
  };
}

import { randomUUID } from "node:crypto";

const CONTRACT_VERSION = "bonni.instance-identity/v1";
const ORGANIZATION_KEY = "system.instance.organizationId";
const TENANT_KEY = "system.instance.tenantId";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;

type SettingRow = { key: string; value: unknown };
type PrismaLike = {
  systemSetting: {
    findMany(args: unknown): Promise<SettingRow[]>;
    upsert(args: unknown): Promise<SettingRow>;
  };
};

function normalizedId(value: unknown) {
  const id = String(value ?? "").trim();
  return ID_PATTERN.test(id) ? id : "";
}

function generatedId(prefix: "org" | "tenant") {
  return `${prefix}:${randomUUID()}`;
}

function bootstrapOrganizationId() {
  return normalizedId(process.env.BONNI_ORGANIZATION_ID)
    || normalizedId(process.env.BONNI_SERIAL)
    || generatedId("org");
}

function bootstrapTenantId(organizationId: string) {
  return normalizedId(process.env.BONNI_TENANT_ID)
    || organizationId
    || generatedId("tenant");
}

/**
 * Liefert einem Modul ausschließlich die unveränderlichen Kennungen seiner
 * Bonni-Installation. Die Kennungen werden einmalig in SystemSetting erzeugt;
 * Feature-Module erhalten weder Schreibzugriff auf SystemSetting noch auf
 * Boot-Secrets.
 */
export function createModuleInstanceIdentityRuntime(prisma: PrismaLike) {
  let identityPromise: Promise<Readonly<{ organizationId: string; tenantId: string }>> | null = null;

  async function loadIdentity() {
    const rows = await prisma.systemSetting.findMany({
      where: { key: { in: [ORGANIZATION_KEY, TENANT_KEY] } },
    });
    const values = new Map(rows.map((entry) => [entry.key, entry.value]));
    const organizationId = normalizedId(values.get(ORGANIZATION_KEY)) || bootstrapOrganizationId();
    const tenantId = normalizedId(values.get(TENANT_KEY)) || bootstrapTenantId(organizationId);

    // Kein Array-$transaction: Bonni Cores Datenbankrouter gibt absichtlich
    // normale Promises zurück. Beide Upserts sind einzeln idempotent; falls
    // der zweite Schritt scheitert, ergänzt der nächste Aufruf ihn sicher.
    const organization = await prisma.systemSetting.upsert({
      where: { key: ORGANIZATION_KEY },
      update: {},
      create: { key: ORGANIZATION_KEY, value: organizationId },
    });
    const tenant = await prisma.systemSetting.upsert({
      where: { key: TENANT_KEY },
      update: {},
      create: { key: TENANT_KEY, value: tenantId },
    });

    const storedOrganizationId = normalizedId(organization?.value);
    const storedTenantId = normalizedId(tenant?.value);
    if (!storedOrganizationId || !storedTenantId) {
      throw new Error("INSTANCE_IDENTITY_STORAGE_INVALID");
    }
    return Object.freeze({
      organizationId: storedOrganizationId,
      tenantId: storedTenantId,
    });
  }

  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    get() {
      identityPromise ||= loadIdentity().catch((error) => {
        identityPromise = null;
        throw error;
      });
      return identityPromise;
    },
  });
}

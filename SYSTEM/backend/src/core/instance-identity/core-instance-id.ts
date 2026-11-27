import { randomUUID } from "node:crypto";
type IdentityDatabase = { systemSetting: { upsert(input: any): Promise<{ value: unknown }> } };
/** Core-owned durable identity. Never substitute an organisation/account ID or a transient process ID. */
export async function getCoreInstanceId(database: IdentityDatabase): Promise<string> {
  const row = await database.systemSetting.upsert({ where: { key: "bonni.core.instance-id.v1" }, create: { key: "bonni.core.instance-id.v1", value: randomUUID() }, update: {} });
  if (typeof row?.value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.value)) throw new Error("CORE_INSTANCE_IDENTITY_INVALID");
  return row.value;
}

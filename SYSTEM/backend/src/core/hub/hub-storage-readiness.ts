type ReadinessDatabase = { systemSetting: { upsert(input: any): Promise<unknown> } };
type Context = Readonly<{ sourceInstanceId: string; sourceModule: string; actorAccountId: string }>;
/** Core receipt for the verified consumer handshake. The app owns its transfer progress. */
export async function confirmHubProductStorage(database: ReadinessDatabase, context: Context): Promise<void> {
  if (!/^app\.[a-z][a-z0-9.-]*$/.test(context.sourceModule)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(context.sourceInstanceId)
      || !context.actorAccountId) throw new Error("HUB_STORAGE_CONFIRMATION_CONTEXT_INVALID");
  const key = `bonni.hub.product-storage.v1.${context.sourceModule}`;
  const value = { contractVersion: "hub.products/v2", moduleKey: context.sourceModule, sourceInstanceId: context.sourceInstanceId,
    actorAccountId: context.actorAccountId, confirmedAt: new Date().toISOString() };
  await database.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

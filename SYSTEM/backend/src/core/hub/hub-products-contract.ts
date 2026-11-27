// Generated from SYSTEM/addons/hub/contracts/products-v2.ts. Do not edit this snapshot.
/** Authoritative Hub contract. Product composition and physical containment are separate. */
export const HUB_PRODUCTS_VERSION = "hub.products/v2" as const;
export const HUB_PRODUCT_CHANGE_VERSION = "hub.products.changed/v2" as const;
export const HUB_PRODUCT_OPERATIONS = ["get", "list", "create", "update", "archive", "restore", "history", "listComponents", "setComponent", "removeComponent", "getStockItem", "listStockItems", "createStockItem", "moveStockItem", "archiveStockItem", "stockItemHistory"] as const;
export type ProductOperation = typeof HUB_PRODUCT_OPERATIONS[number];
export const HUB_PRODUCT_CLIENT_OPERATIONS = [...HUB_PRODUCT_OPERATIONS, "subscribe"] as const;
export type ProductClientOperation = typeof HUB_PRODUCT_CLIENT_OPERATIONS[number];
export const HUB_PRODUCT_PERMISSIONS = Object.freeze({ read: "hub.products.read", write: "hub.products.write", stockRead: "hub.stock.read", stockWrite: "hub.stock.write" } as const);
export const HUB_PRODUCT_OPERATION_PERMISSIONS = Object.freeze({
  get: "hub.products.read", list: "hub.products.read", history: "hub.products.read", listComponents: "hub.products.read",
  create: "hub.products.write", update: "hub.products.write", archive: "hub.products.write", restore: "hub.products.write", setComponent: "hub.products.write", removeComponent: "hub.products.write",
  getStockItem: "hub.stock.read", listStockItems: "hub.stock.read", stockItemHistory: "hub.stock.read",
  createStockItem: "hub.stock.write", moveStockItem: "hub.stock.write", archiveStockItem: "hub.stock.write",
  subscribe: "hub.products.read",
} as const);
export const HUB_PRODUCT_KINDS = ["FOOD", "DRINK", "DEVICE", "CONSUMABLE", "MATERIAL", "OTHER"] as const;
export const HUB_PRODUCT_FIELDS = ["sku", "name", "kind", "baseUnitKey", "description", "barcode", "imageMediaId"] as const;
export type ProductKind = typeof HUB_PRODUCT_KINDS[number];
export type ProductFields = {
  sku: string; name: string; kind: ProductKind; baseUnitKey: string;
  description?: string | null; barcode?: string | null; imageMediaId?: string | null;
};
export type Product = Required<ProductFields> & { id: string; active: boolean; revision: number; createdAt: string; updatedAt: string };
/** Positive decimal string, at most 12 integral and 6 fractional digits; never a JS float. */
export type Quantity = string;
export type ProductComponent = { parentProductId: string; componentProductId: string; quantity: Quantity };
export type StockItemFields = { productId: string; quantity: Quantity; parentStockItemId?: string | null; serialNumber?: string | null };
export type StockItem = Required<StockItemFields> & { id: string; active: boolean; revision: number; createdAt: string; updatedAt: string };
export type MutationAction = "create" | "update" | "archive" | "restore" | "setComponent" | "removeComponent" | "move";
/** Stable address. Module/model identify ownership; the action's source is recorded separately. */
export type RecordReference = Readonly<{ instanceId: string; moduleId: string; model: string; id: string }>;
export const HUB_AUDIT_VERSION = "hub.audit/v1" as const;
export type AuditChange = { record: RecordReference; before: Record<string, unknown> | null; after: Record<string, unknown> | null };
export type MutationHistory = {
  id: string; operationId: string; sourceModule: string; actorAccountId: string; kind: MutationAction; revision: number; createdAt: string;
  sourceInstanceId: string | null; record: RecordReference | null; transactionRef: RecordReference | null;
  auditVersion: typeof HUB_AUDIT_VERSION | null; auditState: "COMPLETE" | "LEGACY"; outcome: "COMMITTED"; changes: AuditChange[] | null;
};
/** A reference correlates existing business transactions; it never authorizes them or executes a sale/reservation. */
type AuditInput = { transactionRef?: RecordReference };
export type HubProductsDeclaration = { contractVersion: typeof HUB_PRODUCTS_VERSION; operations: ProductClientOperation[] };
export type ProductChange = Readonly<{
  contractVersion: typeof HUB_PRODUCT_CHANGE_VERSION; type: "changed"; eventId: string;
  entity: "Product" | "StockItem"; entityId: string; productId: string;
  revision: number; action: MutationAction; changedAt: string;
}>;
/** Invalidations, not a durable event log. A StockItem move invalidates derived paths of its whole branch. */
export type ProductNotification = ProductChange | Readonly<{ contractVersion: typeof HUB_PRODUCT_CHANGE_VERSION; type: "resync" | "unavailable" }>;
export type ProductListener = (event: ProductNotification) => void | Promise<void>;
type MutationInput = AuditInput & { operationId: string; id: string; expectedRevision: number };
type HistoryInput = { id: string; afterRevision?: number; limit?: number };
type HistoryPage = { items: MutationHistory[]; nextRevision: number | null };
export type HubProductsClient = {
  readonly contractVersion: typeof HUB_PRODUCTS_VERSION;
  get(input: { id: string }): Promise<Product>;
  list(input?: { q?: string; kind?: ProductKind; active?: boolean; limit?: number; cursor?: string }): Promise<{ items: Product[]; nextCursor: string | null }>;
  create(input: AuditInput & { operationId: string; product: ProductFields }): Promise<Product>;
  update(input: MutationInput & { patch: Partial<ProductFields> }): Promise<Product>;
  archive(input: MutationInput & { patch?: Partial<ProductFields> }): Promise<Product>;
  /** Reactivate the same Product; optional field changes commit atomically with restoration. */
  restore(input: MutationInput & { patch?: Partial<ProductFields> }): Promise<Product>;
  history(input: HistoryInput): Promise<HistoryPage>;
  listComponents(input: { parentProductId: string; limit?: number; cursor?: string }): Promise<{ items: ProductComponent[]; productRevision: number; nextCursor: string | null }>;
  /** Component edits increment the parent's Product revision and return its confirmed record. */
  setComponent(input: AuditInput & { operationId: string; parentProductId: string; componentProductId: string; quantity: Quantity; expectedRevision: number }): Promise<Product>;
  removeComponent(input: AuditInput & { operationId: string; parentProductId: string; componentProductId: string; expectedRevision: number }): Promise<Product>;
  getStockItem(input: { id: string }): Promise<StockItem>;
  /** parentStockItemId:null selects roots; omitted selects all. Each page reads current confirmed data. */
  listStockItems(input?: { productId?: string; parentStockItemId?: string | null; active?: boolean; limit?: number; cursor?: string }): Promise<{ items: StockItem[]; nextCursor: string | null }>;
  createStockItem(input: AuditInput & { operationId: string; stockItem: StockItemFields }): Promise<StockItem>;
  moveStockItem(input: MutationInput & { parentStockItemId: string | null }): Promise<StockItem>;
  /** Only empty nodes may be archived. No automatic consumption, cascading archive or quantity correction. */
  archiveStockItem(input: MutationInput): Promise<StockItem>;
  stockItemHistory(input: HistoryInput): Promise<HistoryPage>;
  /** Module-level metadata feed. Reads require verified user rights independently. */
  subscribe(listener: ProductListener): () => void;
};
export type ProductCallContext = Readonly<{ sourceInstanceId: string; sourceModule: string; actorAccountId: string; assertActive(): void }>;
export type HubProductsProvider = { contractVersion: typeof HUB_PRODUCTS_VERSION; invoke(operation: ProductOperation, input: unknown, context: ProductCallContext): Promise<unknown> };
export type HubProductsProviderRuntime = { readonly contractVersion: typeof HUB_PRODUCTS_VERSION; register(provider: HubProductsProvider): void; publishChange(event: ProductChange): void; publishInvalidation(): void };

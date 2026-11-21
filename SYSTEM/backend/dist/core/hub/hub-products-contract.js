// Generated from SYSTEM/addons/hub/contracts/products-v2.ts. Do not edit this snapshot.
/** Authoritative Hub contract. Product composition and physical containment are separate. */
export const HUB_PRODUCTS_VERSION = "hub.products/v2";
export const HUB_PRODUCT_CHANGE_VERSION = "hub.products.changed/v2";
export const HUB_PRODUCT_OPERATIONS = ["get", "list", "create", "update", "archive", "restore", "history", "listComponents", "setComponent", "removeComponent", "getStockItem", "listStockItems", "createStockItem", "moveStockItem", "archiveStockItem", "stockItemHistory"];
export const HUB_PRODUCT_CLIENT_OPERATIONS = [...HUB_PRODUCT_OPERATIONS, "subscribe"];
export const HUB_PRODUCT_PERMISSIONS = Object.freeze({ read: "hub.products.read", write: "hub.products.write", stockRead: "hub.stock.read", stockWrite: "hub.stock.write" });
export const HUB_PRODUCT_OPERATION_PERMISSIONS = Object.freeze({
    get: "hub.products.read", list: "hub.products.read", history: "hub.products.read", listComponents: "hub.products.read",
    create: "hub.products.write", update: "hub.products.write", archive: "hub.products.write", restore: "hub.products.write", setComponent: "hub.products.write", removeComponent: "hub.products.write",
    getStockItem: "hub.stock.read", listStockItems: "hub.stock.read", stockItemHistory: "hub.stock.read",
    createStockItem: "hub.stock.write", moveStockItem: "hub.stock.write", archiveStockItem: "hub.stock.write",
    subscribe: "hub.products.read",
});
export const HUB_PRODUCT_KINDS = ["FOOD", "DRINK", "DEVICE", "CONSUMABLE", "MATERIAL", "OTHER"];
export const HUB_PRODUCT_FIELDS = ["sku", "name", "kind", "baseUnitKey", "description", "barcode", "imageMediaId"];
export const HUB_AUDIT_VERSION = "hub.audit/v1";

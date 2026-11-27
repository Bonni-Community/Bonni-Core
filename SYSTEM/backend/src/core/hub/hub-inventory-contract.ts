// Generated from SYSTEM/addons/hub/contracts/inventory-v1.ts. Do not edit this snapshot.
/** Hub owns shared quantities, reservations and durable stock intents. */
export const HUB_INVENTORY_VERSION = 'hub.inventory/v1' as const;
export const HUB_INVENTORY_OPERATIONS = ['snapshot','prepare','finish','adopt','adoptClaims','history','manage'] as const;
export type InventoryOperation = typeof HUB_INVENTORY_OPERATIONS[number];
export type InventoryClaim = { key:string; productId:string; quantity:string; startsAt:string; endsAt:string|null; state:'RESERVED'|'HELD'|'QUARANTINED'; stockItemId?:string; purpose?:'RENTAL'|'SERVICE'|'BUFFER'; inUse?:true };
export type InventoryChange = { productId:string; delta:string; expectedRevision?:number };
export type InventorySnapshot = {contractVersion:typeof HUB_INVENTORY_VERSION;revision:number;ledgerSequence:number;products:Array<{productId:string;name:string;sku:string;kind:string;unit:string;quantity:string;reserved:string;pending:string;available:string;externalAvailable:string;revision:number}>;claims:Array<InventoryClaim & {sourceModule:string}>;pending:number;adoptions:Array<{sourceId:string;productId:string;quantity:string;unit:string;resolution:'EMPTY_ONLY'|'USE_HUB'|'ADD_CONFIRMED'}>;asOf:string};
export type InventoryPrepare = {operationId:string;changes:InventoryChange[];claimScope?:string;claims?:InventoryClaim[];reference?:{model:string;id:string};note?:string};
export type InventoryIntent = {operationId:string;state:'PREPARED'|'COMMITTED'|'ABORTED';sourceModule:string;actorAccountId:string;snapshot:InventorySnapshot};
export type InventoryAdoption = {operationId:string;sourceId:string;productId:string;quantity:string;unit:string;expectedRevision:number;resolution:'EMPTY_ONLY'|'USE_HUB'|'ADD_CONFIRMED';note:string};
export type HubInventoryClient = {contractVersion:typeof HUB_INVENTORY_VERSION;mode():Promise<{mode:'LOCAL'|'HUB';required:boolean;installed:boolean;enabled:boolean;appKeys:string[];pendingApps:string[];everShared:boolean;preference:'AUTO'|'LOCAL'|'HUB'}>;configure(input:{mode:'LOCAL'|'HUB'}):Promise<unknown>;snapshot(input?:{startsAt?:string;endsAt?:string;productIds?:string[]}):Promise<InventorySnapshot>;prepare(input:InventoryPrepare):Promise<InventoryIntent>;finish(input:{operationId:string;decision:'COMMIT'|'ABORT'}):Promise<InventoryIntent>;adopt(input:InventoryAdoption):Promise<InventorySnapshot>;confirmReady():Promise<unknown>;adoptClaims(input:{operationId:string;scope:string;claims:InventoryClaim[];expectedRevision:number;note:string}):Promise<InventorySnapshot>;history(input?:{after?:number;limit?:number}):Promise<unknown>;manage(input:InventoryManagementCommand):Promise<InventoryManagementReceipt>;subscribe(listener:()=>void):()=>void};
export type InventoryContext = Readonly<{sourceModule:string;sourceInstanceId:string;actorAccountId:string;recovery?:boolean;reservationOnly?:boolean;assertActive():void}>;
export type HubInventoryProvider = {contractVersion:typeof HUB_INVENTORY_VERSION;invoke(operation:InventoryOperation,input:unknown,context:InventoryContext):Promise<unknown>};

/** Authenticated, explicit physical stock administration; never available to recovery. */
export type InventoryManagementCommand = {operationId:string;expectedRevision:number;note:string} & (
 {action:"RECEIVE";productId:string;quantity:string;serialNumber:string|null;parentId:string|null;expectedTreeRevision:number} |
 {action:"ISSUE"|"RETURN";stockItemId:string;quantity:string;expectedStockRevision:number} |
 {action:"MOVE";stockItemId:string;quantity:string;expectedStockRevision:number;parentId:string|null;expectedTreeRevision:number} |
 {action:"COUNT";items:Array<{stockItemId:string;quantity:string;expectedStockRevision:number}>}
);
export type InventoryManagementReceipt={operationId:string;action:InventoryManagementCommand["action"];revision:number;sequence:number;stockItemIds:string[]};

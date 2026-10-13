// Outbox v1: the trusted Core frame owns durable storage. An opaque app never
// receives a credential or access to another account's/module's entries.
import { handleOrderDiagnostics } from './moduleOrderDiagnostics.js';
export const MODULE_OUTBOX_REQUEST = "bonni:module-outbox-request";
export const MODULE_OUTBOX_CAPABILITY = Object.freeze({ version: 1, diagnosticsVersion: 1 });
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const allowedOperations = new Set(["list", "enqueue", "sent", "failed", "retry", "remove", "diagnostics-record", "diagnostics-list"]);
const orderOperations = new Set(["BAR_ORDER_CREATE", "MEMBER_ORDER_CREATE"]);
const failure = (code, message) => Object.assign(new Error(message), { code });

function openDatabase(factory) {
  return new Promise((resolve, reject) => {
    if (!factory) return reject(failure("OUTBOX_UNAVAILABLE", "Die lokale Bestellablage ist nicht verfügbar."));
    const request = factory.open("bonni-module-outbox-v1", 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("orders", { keyPath: "key" });
      store.createIndex("scope", "scope");
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(failure("OUTBOX_BLOCKED", "Bitte die anderen Bonni-Fenster schließen und erneut versuchen."));
    request.onsuccess = () => resolve(request.result);
  });
}

export async function handleModuleOutbox(data, context, factory = globalThis.indexedDB) {
  const accountId = String(context?.user?.accountId || context?.user?.id || "");
  if (context?.moduleId !== "app.stueberlapp" || !context?.token || !accountId) {
    throw failure("OUTBOX_ACCESS_DENIED", "Für die Bestellablage ist eine Anmeldung erforderlich.");
  }
  if (!ID.test(String(data?.requestId || "")) || !allowedOperations.has(data?.operation)) {
    throw failure("OUTBOX_REQUEST_INVALID", "Ungültige Anfrage an die Bestellablage.");
  }
  // The account in the request must still be the authenticated host account.
  // This also prevents an old frame finishing work after an account switch.
  if (data.accountId !== accountId) throw failure("OUTBOX_ACCOUNT_CHANGED", "Das angemeldete Konto hat sich geändert.");
  const orderOperation = data.orderOperation || "BAR_ORDER_CREATE";
  if (!orderOperations.has(orderOperation)) throw failure("OUTBOX_OPERATION_INVALID", "Unbekannte Bestellart.");
  if (data.operation.startsWith('diagnostics-')) return handleOrderDiagnostics(data, context, factory);
  const scope = JSON.stringify([context.moduleId, accountId]);
  const id = String(data.id || "");
  if (data.operation !== "list" && !ID.test(id)) throw failure("OUTBOX_ID_INVALID", "Ungültige Auftrags-ID.");
  if (data.operation === "enqueue" && (!data.payload || data.payload.idempotencyKey !== id ||
      JSON.stringify(data.payload).length > 32768 || !Array.isArray(data.payload.items) || !data.payload.items.length)) {
    throw failure("OUTBOX_PAYLOAD_INVALID", "Die Bestellung kann nicht lokal gespeichert werden.");
  }
  const db = await openDatabase(factory);
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction("orders", "readwrite", { durability: "strict" });
      const store = transaction.objectStore("orders");
      let result;
      let problem;
      const abort = (error) => { problem = error; transaction.abort(); };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(problem || transaction.error || failure("OUTBOX_WRITE_FAILED", "Die Bestellung konnte nicht lokal gesichert werden."));
      transaction.onerror = () => {};
      if (data.operation === "list") {
        const request = store.index("scope").getAll(scope);
        request.onsuccess = () => { result = request.result.filter(entry => entry.operation === orderOperation)
          .map(({ key, scope, ...entry }) => entry); };
        return;
      }
      const key = JSON.stringify([scope, id]);
      const request = store.get(key);
      request.onsuccess = () => {
        const current = request.result;
        if (current && current.operation !== orderOperation) {
          return abort(failure("OUTBOX_OPERATION_CONFLICT", "Diese Auftrags-ID gehört zu einer anderen Bestellart."));
        }
        const now = new Date().toISOString();
        if (data.operation === "enqueue") {
          if (current) {
            if (JSON.stringify(current.payload) !== JSON.stringify(data.payload)) {
              abort(failure("OUTBOX_ID_CONFLICT", "Diese Auftrags-ID gehört bereits zu einer anderen Bestellung."));
            } else result = current;
            return;
          }
          const count = store.index("scope").count(scope);
          count.onsuccess = () => {
            if (count.result >= 1000) return abort(failure("OUTBOX_FULL", "Bitte zuerst die offenen Bestellungen synchronisieren."));
            result = { key, scope, id, idempotencyKey: id, payload: data.payload, operation: orderOperation,
              status: "PENDING", attempts: 0, createdAt: now, updatedAt: now, lastError: null };
            store.add(result);
          };
        } else if (!current) {
          result = null; // A late failure cannot resurrect an acknowledged order.
        } else if (data.operation === "sent" || data.operation === "remove") {
          store.delete(key);
          result = null;
        } else {
          result = { ...current, updatedAt: now,
            status: data.operation === "failed" ? "FAILED" : "PENDING",
            lastError: data.operation === "failed" ? String(data.error || "Übertragung fehlgeschlagen").slice(0, 1000) : null,
            attempts: current.attempts + (data.operation === "failed" ? 1 : 0) };
          store.put(result);
        }
      };
    });
  } finally { db.close(); }
}

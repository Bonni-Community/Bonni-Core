// Separate from the financial outbox: diagnostic storage cannot abort an order
// commit or remove an order. Access is verified from the trusted host context.
export const ORDER_DIAGNOSTICS_VERSION = 1;
const RETENTION_DAYS = 30;
const MAX_EVENTS = 50000;
const EVENTS = new Set(['INTAKE_STARTED', 'INTAKE_STORED', 'INTAKE_FAILED', 'STORAGE_UNCERTAIN',
  'SEND_STARTED', 'SEND_SUCCEEDED', 'SEND_FAILED', 'SEND_ABORTED', 'LOCAL_ACK_FAILED',
  'COMPLETED', 'ORDER_REVIEW', 'RETRY_REQUESTED', 'ORDER_REMOVED']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const CODE = /^[A-Z][A-Z0-9_]{1,79}$/;
const failure = (code) => Object.assign(new Error(code), { code });
const strings = value => Array.isArray(value) ? value.filter(v => typeof v === 'string').map(v => v.trim().toLowerCase()) : [];
export function canReadDeviceOrderDiagnostics({ user, shell }) {
  const values = new Set([
    ...strings(user?.roles), ...strings(user?.permissions), ...strings(user?.permissionKeys),
    ...strings(user?.permissions?.roles), ...strings(user?.permissions?.permissions), ...strings(user?.permissions?.grants),
    ...strings(shell?.identity?.roles), ...strings(shell?.identity?.permissions),
    ...strings(shell?.permissions?.roles), ...strings(shell?.permissions?.permissions), ...strings(shell?.permissions?.grants),
  ]);
  return values.has('access:app:app-stueberlapp:manager') || values.has('module.app-stueberlapp.manager');
}
function openDatabase(factory) {
  return new Promise((resolve, reject) => {
    if (!factory) return reject(failure('ORDER_DIAGNOSTICS_UNAVAILABLE'));
    const request = factory.open('bonni-module-order-diagnostics-v1', 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('events', { keyPath: 'sequence', autoIncrement: true });
      store.createIndex('eventKey', 'eventKey', { unique: true });
      store.createIndex('recordedAt', 'recordedAt');
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(failure('ORDER_DIAGNOSTICS_BLOCKED'));
    request.onsuccess = () => resolve(request.result);
  });
}
function duration(value) {
  return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? Math.round(value) : null;
}
function normalizedEvent(data, context) {
  const event = data.event;
  if (!event || !ID.test(event.eventId || '') || !ID.test(data.id || '') || !EVENTS.has(event.type)) {
    throw failure('ORDER_DIAGNOSTICS_EVENT_INVALID');
  }
  return {
    eventKey: JSON.stringify([context.moduleId, data.accountId, event.eventId]),
    moduleId: context.moduleId, accountId: data.accountId, orderId: data.id,
    orderOperation: data.orderOperation || 'BAR_ORDER_CREATE',
    eventId: event.eventId, type: event.type,
    occurredAt: Number.isFinite(Date.parse(event.occurredAt)) ? new Date(event.occurredAt).toISOString() : new Date().toISOString(),
    recordedAt: new Date().toISOString(),
    durationMs: duration(event.durationMs), totalElapsedMs: duration(event.totalElapsedMs),
    queueAgeMs: duration(event.queueAgeMs),
    errorCode: CODE.test(event.errorCode || '') ? event.errorCode : null,
    httpStatus: Number.isInteger(event.httpStatus) && event.httpStatus >= 100 && event.httpStatus <= 599 ? event.httpStatus : null,
    replayed: event.replayed === true,
    droppedEventsBefore: Number.isSafeInteger(event.droppedEventsBefore) && event.droppedEventsBefore > 0 ? event.droppedEventsBefore : 0,
    // Deliberately no request body, member name, NFC tag, credentials or raw error message.
  };
}

export async function handleOrderDiagnostics(data, context, factory) {
  const deviceScope = data.scope === 'device';
  if (deviceScope && !canReadDeviceOrderDiagnostics(context)) throw failure('ORDER_DIAGNOSTICS_ACCESS_DENIED');
  if (data.operation === 'diagnostics-record' && deviceScope) throw failure('ORDER_DIAGNOSTICS_ACCESS_DENIED');
  const event = data.operation === 'diagnostics-record' ? normalizedEvent(data, context) : null;
  const after = Number.isSafeInteger(data.after) && data.after >= 0 ? data.after : 0;
  const requestedSnapshot = Number.isSafeInteger(data.snapshot) && data.snapshot >= 0 ? data.snapshot : null;
  const limit = Math.max(1, Math.min(500, Number.isSafeInteger(data.limit) ? data.limit : 500));
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  const db = await openDatabase(factory);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('events', event ? 'readwrite' : 'readonly', { durability: 'strict' });
      const store = tx.objectStore('events');
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || failure('ORDER_DIAGNOSTICS_WRITE_FAILED'));
      tx.onerror = () => {};
      if (event) {
        const existing = store.index('eventKey').get(event.eventKey);
        existing.onsuccess = () => {
          if (existing.result) { result = { stored: true, sequence: existing.result.sequence }; return; }
          const add = store.add(event);
          add.onsuccess = () => { result = { stored: true, sequence: add.result }; };
          // Prune oldest entries in this independent database, never the orders.
          const count = store.count();
          count.onsuccess = () => {
            let excess = Math.max(0, count.result - MAX_EVENTS);
            const cursor = store.index('recordedAt').openCursor();
            cursor.onsuccess = () => {
              const row = cursor.result;
              if (!row || (!excess && Date.parse(row.value.recordedAt) >= cutoff)) return;
              row.delete(); if (excess) excess--; row.continue();
            };
          };
        };
        return;
      }
      const newest = store.openCursor(null, 'prev');
      newest.onsuccess = () => {
        const snapshot = requestedSnapshot ?? newest.result?.primaryKey ?? 0;
        result = { events: [], nextCursor: null, snapshot, retentionDays: RETENTION_DAYS, maxEvents: MAX_EVENTS };
        const request = store.openCursor();
        request.onsuccess = () => {
          const row = request.result;
          if (!row || row.primaryKey > snapshot) return;
          if (row.primaryKey <= after) { row.continue(after + 1); return; }
          const entry = row.value;
          if (row.primaryKey > after && entry.moduleId === context.moduleId &&
              (deviceScope || entry.accountId === data.accountId) && Date.parse(entry.recordedAt) >= cutoff) {
            if (result.events.length >= limit) { result.nextCursor = result.events.at(-1).sequence; return; }
            const { eventKey, ...safe } = entry; result.events.push(safe);
          }
          row.continue();
        };
      };
    });
  } finally { db.close(); }
}

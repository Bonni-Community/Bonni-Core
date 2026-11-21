import { apiRequest } from "../../../system/api/apiClient.js";
import { parseTerminalObject } from "./terminalAdministration.js";

const productPath = "/api/apps/stueberlapp/application-docks/manager/products";
const productId = /^[a-z0-9][a-z0-9._:-]{0,159}$/iu;
const skuFormat = /^[a-z0-9][a-z0-9._-]{0,63}$/iu;
const productFields = ["sku", "categoryId", "type", "isSellable", "isStockTracked", "active"];
const versionFields = ["name", "description", "barcode", "price", "minimumStock"];
const pendingWrites = new Map();

function productPayload(body, creating) {
  const keys = Object.keys(body);
  if (!keys.length || keys.some(key => !productFields.includes(key) && !versionFields.includes(key))) {
    throw new Error("Erlaubte Produktfelder sind " + [...productFields, ...versionFields].join(", ") + ".");
  }
  if (creating || Object.hasOwn(body, "sku")) {
    if (typeof body.sku !== "string" || !skuFormat.test(body.sku)) throw new Error("Gib eine eindeutige Artikelnummer (SKU) ohne Leerzeichen ein.");
  }
  if (creating || Object.hasOwn(body, "name")) {
    if (typeof body.name !== "string" || !body.name.trim()) throw new Error("Gib einen Produktnamen ein.");
  }
  if (creating || Object.hasOwn(body, "price")) {
    const price = typeof body.price === "string" && /^\d+(?:[,.]\d{1,2})?$/u.test(body.price)
      ? Number(body.price.replace(",", "."))
      : body.price;
    if (!Number.isFinite(price) || price < 0) throw new Error("Gib einen gültigen Preis in Euro ein.");
    body = { ...body, price };
  }
  if (!creating && keys.some(key => productFields.includes(key)) && keys.some(key => versionFields.includes(key))) {
    throw new Error("Gib Änderungen an Produkt und Verkaufsversion in zwei Zeilen ein, damit jede Änderung einzeln bestätigt wird.");
  }
  return body;
}

export function parseProductCommand(action, rest) {
  if (["list", "liste"].includes(action)) return { kind: "product-list", query: rest };
  if (["import", "importieren"].includes(action) && !rest) return { kind: "product-import" };
  if (["create", "anlegen"].includes(action)) return { kind: "product-create", body: productPayload(parseTerminalObject(rest), true) };
  const [, target, argument] = /^(\S+)(?:\s+(.+))?$/u.exec(rest) || [];
  if (!target || !productId.test(target)) throw new Error("Suche die Produkt-ID mit product list.");
  if (["update", "ändern", "aendern"].includes(action)) {
    return { kind: "product-update", target, body: productPayload(parseTerminalObject(argument), false) };
  }
  if (["archive", "archivieren", "deaktivieren"].includes(action) && argument === "--confirm") {
    return { kind: "product-archive", target };
  }
  throw new Error("Verwende product archive <Produkt-ID> --confirm zum Archivieren oder help für alle Produktbefehle.");
}

export function parseProductImport(text) {
  const items = [];
  const skus = new Set();
  for (const [index, raw] of text.replace(/^\uFEFF/u, "").split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (items.length === 20) throw new Error("Eine Textdatei darf bis zu 20 Produkte enthalten.");
    try {
      const parts = line.split("|").map(value => value.trim());
      if (parts.length !== 3 || line.includes("\uFFFD")) throw new Error("Erwartet wird SKU | Name | Preis in Euro (UTF-8).");
      const [sku, name, price] = parts;
      const body = productPayload({ sku, name, price }, true);
      if (skus.has(sku.toUpperCase())) throw new Error(`Artikelnummer ${sku} steht bereits in der Datei.`);
      skus.add(sku.toUpperCase());
      items.push({ body, line: index + 1 });
    } catch (error) {
      throw new Error(`Zeile ${index + 1} · ${error.message}`);
    }
  }
  if (!items.length) throw new Error("Die Datei enthält keine Produktzeilen.");
  return items;
}

function operationId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function currentVersion(product) {
  return product.currentVersion || product.versions?.find(version => version.id === product.currentVersionId);
}

async function productRequest(path, options) {
  try {
    const result = await apiRequest(path, { ...options, cache: "no-store", allowFailover: false });
    if (result?.ok === false) throw Object.assign(new Error(result.message || result.error || "Produktvorgang fehlgeschlagen."), { status: 400 });
    return result;
  } catch (error) {
    if (error.status === 403) error.message = "Für Produkte brauchst du die Verwaltungsberechtigung der StüberlApp.";
    if (error.status === 404) error.message = "Produkt oder StüberlApp-Schnittstelle nicht gefunden. Prüfe Paketstatus und Produkt-ID.";
    throw error;
  }
}

async function writeProduct(command, { token, signal }) {
  const { kind, target, body = {} } = command;
  const key = `${kind}:${target || body.sku}`;
  const fingerprint = JSON.stringify(body);
  let attempt = pendingWrites.get(key);
  if (attempt && attempt.fingerprint !== fingerprint) {
    throw new Error("Für dieses Produkt ist noch eine Rückmeldung offen. Führe denselben Befehl erneut aus.");
  }
  if (!attempt) {
    const creating = kind === "product-create";
    let path = creating ? productPath : `${productPath}/${encodeURIComponent(target)}`;
    let product;
    if (!creating) {
      product = (await productRequest(path, { token, signal })).item;
      if (product?.id !== target) throw new Error("Die StüberlApp konnte das Produkt nicht eindeutig zuordnen.");
      if (Object.keys(body).some(field => versionFields.includes(field))) {
        const version = currentVersion(product);
        if (!version?.id) throw new Error("Das Produkt hat keine aktuelle Verkaufsversion.");
        path = `${productPath}/versions/${encodeURIComponent(version.id)}`;
      }
    }
    const method = creating ? "POST" : kind === "product-archive" ? "DELETE" : "PATCH";
    const payload = creating
      ? { ...body, version: Object.fromEntries(Object.entries(body).filter(([field]) => versionFields.includes(field))) }
      : body;
    attempt = { path, method, fingerprint, body: { ...payload, storageOperationId: operationId(), expectedHubRevision: product?.hubRevision } };
    pendingWrites.set(key, attempt);
  }
  try {
    const result = await productRequest(attempt.path, { token, signal, method: attempt.method, body: attempt.body });
    if (!result?.item?.id) throw new Error("Die StüberlApp hat die Produktänderung nicht bestätigt.");
    pendingWrites.delete(key);
    return result.item;
  } catch (error) {
    if (error.status >= 400 && error.status < 500) pendingWrites.delete(key);
    throw error;
  }
}

export function clearPendingProductWrites() {
  pendingWrites.clear();
}

export async function executeProductCommand(command, { token, signal }) {
  if (command.kind === "product-import") {
    return { message: "Produktimport geöffnet. Wähle eine Textdatei für die Vorschau.", panel: { kind: "import" } };
  }
  if (command.kind === "product-list") {
    const result = await productRequest(`${productPath}?take=500`, { token, signal });
    if (!Array.isArray(result?.items)) throw new Error("Die StüberlApp hat keine Produktliste geliefert.");
    const query = command.query.toLowerCase();
    return result.items.map(item => (
      `${item.id} · ${item.sku} · ${currentVersion(item)?.name || item.name || "Produkt"} · ${item.active === false ? "Archiviert" : "Aktiv"}`
    )).filter(row => row.toLowerCase().includes(query)).slice(0, 60).join("\n") || "Keine passenden Produkte gefunden.";
  }
  const item = await writeProduct(command, { token, signal });
  if (command.kind === "product-create") return `Produkt ${command.body.name} angelegt · ${item.id}`;
  if (command.kind === "product-archive") return `Produkt ${command.target} archiviert.`;
  return `Produkt ${command.target} geändert.`;
}

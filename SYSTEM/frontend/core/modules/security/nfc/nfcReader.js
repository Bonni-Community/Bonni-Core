const readerError = code => Object.assign(new Error(code), { code });

function readerCode(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  for (const field of ["serialNumber", "uid", "code"]) {
    if (typeof value[field] === "string" && value[field].trim()) return value[field].trim();
  }
  return "";
}

export function isNfcReaderAvailable() {
  const scope = typeof globalThis === "undefined" ? null : globalThis;
  return Boolean(
    typeof scope?.NDEFReader === "function"
    || typeof scope?.BonniNfcReader?.readTag === "function",
  );
}

/**
 * Reads one tag for the Core enrollment action. A native tablet wrapper may
 * provide BonniNfcReader; supported Chromium devices may provide Web NFC.
 * The result is transient and is immediately handed to the Core registration
 * endpoint by the caller.
 */
export async function readNfcTag({ signal } = {}) {
  if (signal?.aborted) throw readerError("NFC_READER_CANCELLED");
  const scope = typeof globalThis === "undefined" ? null : globalThis;
  const bridge = scope?.BonniNfcReader;

  if (typeof bridge?.readTag === "function") {
    const value = await bridge.readTag({ signal });
    const code = readerCode(value);
    if (!code) throw readerError("NFC_READER_NO_CODE");
    return code;
  }

  const Reader = scope?.NDEFReader;
  if (typeof Reader !== "function") throw readerError("NFC_READER_UNAVAILABLE");

  const reader = new Reader();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, readerError("NFC_READER_CANCELLED"));

    reader.onreadingerror = () => finish(reject, readerError("NFC_READER_FAILED"));
    reader.onreading = event => {
      const code = readerCode(event?.serialNumber);
      if (!code) finish(reject, readerError("NFC_READER_NO_CODE"));
      else finish(resolve, code);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    Promise.resolve(signal ? reader.scan({ signal }) : reader.scan()).catch(error => {
      finish(reject, error?.code ? error : readerError("NFC_READER_FAILED"));
    });
  });
}

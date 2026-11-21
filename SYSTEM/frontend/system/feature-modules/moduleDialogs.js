export const MODULE_DIALOG_REQUEST = "bonni:module-dialog-request";
export const MODULE_DIALOG_CAPABILITY = Object.freeze({ version: 1 });

// Called only after the frame, opaque origin and session have been verified.
// Keep native dialogs in Core: opaque sandbox frames cannot reliably show them.
export function createModuleDialogHandler({ moduleId, getContext, host = globalThis.window }) {
  const handled = new Set();
  return (data) => {
    const invalid = (code, message) => ({ ok: false, status: 400, payload: { code, message } });
    if (moduleId !== "app.stueberlapp" || !getContext()?.token) {
      return invalid("MODULE_DIALOG_UNAVAILABLE", "Der Dialog ist ohne aktive Stüberl-Sitzung nicht verfügbar.");
    }
    const dialog = data?.dialog;
    if (data?.type !== MODULE_DIALOG_REQUEST
      || typeof data.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(data.requestId)
      || !dialog || typeof dialog !== "object" || Array.isArray(dialog)
      || Object.keys(dialog).some(key => !["kind", "message", "defaultValue"].includes(key))
      || !["alert", "confirm", "prompt"].includes(dialog.kind)
      || typeof dialog.message !== "string" || dialog.message.length > 2000
      || (dialog.defaultValue !== undefined && (typeof dialog.defaultValue !== "string" || dialog.defaultValue.length > 2000))) {
      return invalid("MODULE_DIALOG_INVALID", "Die Dialog-Anfrage ist ungültig.");
    }
    if (handled.has(data.requestId)) return invalid("MODULE_DIALOG_DUPLICATE", "Diese Dialog-Anfrage wurde bereits beantwortet.");
    handled.add(data.requestId);
    if (handled.size > 128) handled.delete(handled.values().next().value);
    try {
      const message = `StüberlApp\n\n${dialog.message}`;
      let value = null;
      if (dialog.kind === "alert") host.alert(message);
      if (dialog.kind === "confirm") value = host.confirm(message) === true;
      if (dialog.kind === "prompt") value = host.prompt(message, dialog.defaultValue ?? "");
      return { ok: true, status: 200, payload: { value } };
    } catch {
      return invalid("MODULE_DIALOG_FAILED", "Der Browser konnte den Dialog nicht öffnen.");
    }
  };
}

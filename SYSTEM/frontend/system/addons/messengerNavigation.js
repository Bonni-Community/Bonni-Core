const SECTIONS = new Set(["info", "stueberl", "konto", "verein"]);

// This contract carries navigation only. App APIs remain behind their own RPC contract.
export function messengerTarget(moduleId, rpcSessionId, payload) {
  if (moduleId !== "app.stueberlapp" || typeof rpcSessionId !== "string"
      || payload?.presentation !== "messenger" || payload?.navigation?.version !== 1) return null;
  return {
    moduleId,
    rpcSessionId,
    sections: [...new Set((Array.isArray(payload.navigation.sections) ? payload.navigation.sections : [])
      .filter((section) => SECTIONS.has(section)))],
    openPanel: ["contacts", "spaces"].includes(payload.openPanel) ? payload.openPanel : "chat",
  };
}

export function messengerSectionAllowed(target, section) {
  return Boolean(target && SECTIONS.has(section) && target.sections.includes(section));
}

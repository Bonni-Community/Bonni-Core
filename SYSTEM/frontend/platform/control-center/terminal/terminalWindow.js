export const BONNI_TERMINAL_PATH = "/control-center/terminal";
export const BONNI_LIVE_TERMINAL_PATH = "/control-center/live-terminal";
export const BONNI_SYSTEM_MONITOR_PATH = "/control-center/system-monitor";

function openControlWindow(path, size = "width=980,height=710") {
  const popup = window.open("", "_blank", `popup,${size}`);
  if (!popup) return false;
  try {
    popup.opener = null;
    popup.location.replace(path);
    return true;
  } catch {
    popup.close();
    return false;
  }
}

export function openBonniTerminalWindow() {
  return openControlWindow(BONNI_TERMINAL_PATH, "width=820,height=480");
}

export function openBonniLiveTerminalWindow() {
  return openControlWindow(BONNI_LIVE_TERMINAL_PATH);
}

export function openBonniSystemMonitorWindow() {
  return openControlWindow(BONNI_SYSTEM_MONITOR_PATH);
}

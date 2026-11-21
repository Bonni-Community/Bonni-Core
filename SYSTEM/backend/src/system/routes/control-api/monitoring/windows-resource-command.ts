import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);

export async function runWindowsResourceCommand(command: string) {
  const powershell = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await runFile(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
    windowsHide: true,
    timeout: 3_000,
    maxBuffer: 64 * 1024,
  });
  return stdout;
}

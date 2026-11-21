import { readFileSync } from "node:fs";
import { readFile, stat, statfs } from "node:fs/promises";
import os from "node:os";
import { getNetworkTraffic } from "./network-traffic.service.js";
import { runWindowsResourceCommand } from "./windows-resource-command.js";

const CPU_SAMPLE_INTERVAL_MS = 1_000;
const STORAGE_CACHE_MS = 15_000;
const HISTORY_INTERVAL_MS = 5_000;
const HISTORY_DURATION_MS = 15 * 60 * 1_000;
const MAX_HISTORY_POINTS = HISTORY_DURATION_MS / HISTORY_INTERVAL_MS + 1;

export function resourcePercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

export function capacityUsage(totalBytes: number, availableBytes: number) {
  const freeBytes = Math.max(0, Math.min(totalBytes, availableBytes));
  const usedBytes = totalBytes - freeBytes;
  return { totalBytes, freeBytes, usedBytes, percent: totalBytes > 0 ? resourcePercent(100 * usedBytes / totalBytes) : 0 };
}

type CpuTimes = { idle: number; total: number; source: "proc-stat" | "cpu-times" };
type CpuMeasurement = { cores: number; model: string; percent: number | null; source: CpuTimes["source"] | null };
let lastCpuSample: (CpuTimes & { cores: number }) | null = null;
let lastCpuReading: { at: number; value: CpuMeasurement } | undefined;

function linuxCpuTimes(): CpuTimes | null {
  try {
    const cpuLine = readFileSync("/proc/stat", "utf8").split("\n", 1)[0];
    if (!cpuLine.startsWith("cpu ")) return null;
    // Guest time is already included in user and nice time.
    const values = cpuLine.trim().split(/\s+/u).slice(1, 9).map(Number);
    if (values.length < 4 || values.some(value => !Number.isFinite(value) || value < 0)) return null;
    return {
      idle: values[3] + (values[4] || 0),
      total: values.reduce((sum, value) => sum + value, 0),
      source: "proc-stat",
    };
  } catch {
    return null;
  }
}

export function getCpuMeasurement() {
  const now = performance.now();
  if (lastCpuReading && now - lastCpuReading.at < CPU_SAMPLE_INTERVAL_MS) return lastCpuReading.value;

  const cpus = os.cpus();
  const cores = cpus.length;
  let sample = process.platform === "linux" ? linuxCpuTimes() : null;
  if (!sample && cores) {
    let idle = 0;
    let total = 0;
    for (const { times } of cpus) {
      idle += times.idle;
      total += times.user + times.nice + times.sys + times.idle + times.irq;
    }
    sample = { idle, total, source: "cpu-times" };
  }

  let percent = null;
  if (sample && lastCpuSample?.source === sample.source && lastCpuSample.cores === cores) {
    const elapsed = sample.total - lastCpuSample.total;
    const idle = sample.idle - lastCpuSample.idle;
    if (elapsed > 0 && idle >= 0 && idle <= elapsed) percent = resourcePercent(100 * (elapsed - idle) / elapsed);
  }
  lastCpuSample = sample ? { ...sample, cores } : null;
  const value = { cores, model: cpus[0]?.model?.trim() || "CPU", percent, source: sample?.source ?? null };
  lastCpuReading = { at: now, value };
  return value;
}

export function getMemoryStatus() {
  const totalBytes = os.totalmem();
  let availableBytes = os.freemem();
  if (process.platform === "linux") {
    try {
      const meminfo = readFileSync("/proc/meminfo", "utf8");
      const available = /^MemAvailable:\s+(\d+)\s+kB$/mu.exec(meminfo);
      if (available) availableBytes = Number(available[1]) * 1024;
    } catch { /* os.freemem remains available without procfs. */ }
  }
  return capacityUsage(totalBytes, availableBytes);
}

type ResourceHistoryPoint = { at: number; cpuPercent: number | null; memoryPercent: number | null };
const resourceHistory: ResourceHistoryPoint[] = [];
let historyTimer: ReturnType<typeof setInterval> | undefined;

function trimResourceHistory(now: number) {
  if (resourceHistory.length && resourceHistory[resourceHistory.length - 1].at > now) resourceHistory.length = 0;
  while (resourceHistory.length && resourceHistory[0].at < now - HISTORY_DURATION_MS) resourceHistory.shift();
}

function collectResourceHistory() {
  const at = Date.now();
  trimResourceHistory(at);
  const previous = resourceHistory[resourceHistory.length - 1];
  if (previous && at - previous.at < HISTORY_INTERVAL_MS / 2) return;
  const cpu = getCpuMeasurement();
  const memory = getMemoryStatus();
  resourceHistory.push({ at, cpuPercent: cpu.percent, memoryPercent: memory.totalBytes > 0 ? memory.percent : null });
  if (resourceHistory.length > MAX_HISTORY_POINTS) resourceHistory.shift();
}

export function startSystemResourceHistory() {
  if (historyTimer) return;
  collectResourceHistory();
  historyTimer = setInterval(collectResourceHistory, HISTORY_INTERVAL_MS);
  historyTimer.unref();
}

export function stopSystemResourceHistory() {
  clearInterval(historyTimer);
  historyTimer = undefined;
}

type DiskUsage = ReturnType<typeof capacityUsage> & { mount: string };
type LinuxMount = { device: string; mount: string };
const linuxStorageTypes = new Set(["zfs", "btrfs", "shfs", "fuse.shfs"]);
const volatileFilesystems = new Set(["tmpfs", "ramfs", "rootfs", "devtmpfs"]);

export function parseLinuxVolumeMounts(text: string) {
  const mounts: LinuxMount[] = [];
  for (const line of text.split("\n")) {
    const [location, filesystem] = line.split(" - ", 2);
    if (!filesystem) continue;
    const [, , device, , encodedMount] = location.split(" ");
    const [type, source] = filesystem.split(" ");
    if (!encodedMount?.startsWith("/") || !/^\d+:\d+$/u.test(device) || volatileFilesystems.has(type)) continue;
    if (encodedMount !== "/" && !linuxStorageTypes.has(type) && !/^\/dev\/(?!loop|ram)/u.test(source || "")) continue;
    const mount = encodedMount.replace(/\\([0-7]{3})/gu, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    if (/[\u0000-\u001f\u007f]/u.test(mount)) continue;
    mounts.push({ device, mount });
  }
  return mounts.sort((a, b) => a.mount.length - b.mount.length || a.mount.localeCompare(b.mount));
}

async function measureDisk(mount: string): Promise<DiskUsage | null> {
  try {
    if (!(await stat(mount)).isDirectory()) return null;
    const { blocks, bavail, bsize } = await statfs(mount);
    const totalBytes = blocks * bsize;
    if (totalBytes > 0) return { mount, ...capacityUsage(totalBytes, bavail * bsize) };
  } catch { /* A mount can disappear between discovery and measurement. */ }
  return null;
}

async function readLinuxVolumes() {
  const mounts = parseLinuxVolumeMounts(await readFile("/proc/self/mountinfo", "utf8"));
  const measurements = await Promise.all(mounts.map(async ({ device, mount }) => ({ device, disk: await measureDisk(mount) })));
  const seen = new Set<string>();
  const disks: DiskUsage[] = [];
  for (const { device, disk } of measurements) {
    if (!disk || seen.has(device)) continue;
    seen.add(device);
    disks.push(disk);
  }
  return disks;
}

const windowsVolumeCommand = [
  "$drives = @(",
  "foreach ($drive in [System.IO.DriveInfo]::GetDrives()) {",
  "  try {",
  "    if ($drive.DriveType -in @('Fixed','Removable') -and $drive.IsReady) {",
  "      [pscustomobject]@{ mount = $drive.Name; totalBytes = $drive.TotalSize; freeBytes = $drive.AvailableFreeSpace }",
  "    }",
  "  } catch {}",
  "})",
  "ConvertTo-Json -InputObject $drives -Compress",
].join("\n");

export function parseWindowsVolumes(text: string): DiskUsage[] {
  const entries: unknown = JSON.parse(text.trim());
  if (!Array.isArray(entries)) return [];
  return entries.flatMap(entry => (
    typeof entry?.mount === "string" && /^[a-z]:\\$/iu.test(entry.mount)
    && Number.isSafeInteger(entry.totalBytes) && entry.totalBytes > 0
    && Number.isSafeInteger(entry.freeBytes) && entry.freeBytes >= 0
      ? [{ mount: entry.mount, ...capacityUsage(entry.totalBytes, entry.freeBytes) }]
      : []
  ));
}

async function readWindowsVolumes() {
  return parseWindowsVolumes(await runWindowsResourceCommand(windowsVolumeCommand));
}

async function readStorageVolumes() {
  try {
    const disks = process.platform === "win32" ? await readWindowsVolumes()
      : process.platform === "linux" ? await readLinuxVolumes() : [];
    if (disks.length) return disks;
  } catch { /* The Core volume is still useful when volume discovery is unavailable. */ }
  const disk = await measureDisk(process.cwd());
  return disk ? [disk] : [];
}

let diskCache: { at: number; disks: DiskUsage[] } | undefined;
let pendingDisks: Promise<DiskUsage[]> | undefined;

function getStorageVolumes() {
  if (diskCache && performance.now() - diskCache.at < STORAGE_CACHE_MS) return Promise.resolve(diskCache.disks);
  pendingDisks ??= readStorageVolumes().then(disks => {
    diskCache = { at: performance.now(), disks };
    return disks;
  }).finally(() => { pendingDisks = undefined; });
  return pendingDisks;
}

export async function getSystemResources() {
  const cpu = getCpuMeasurement();
  const memory = getMemoryStatus();
  const [disks, network] = await Promise.all([getStorageVolumes(), getNetworkTraffic()]);
  const now = Date.now();
  trimResourceHistory(now);
  return {
    checkedAt: new Date(now).toISOString(),
    hostname: os.hostname(),
    cpu,
    memory,
    disks,
    network,
    history: { intervalMs: HISTORY_INTERVAL_MS, durationMs: HISTORY_DURATION_MS, points: [...resourceHistory] },
  };
}

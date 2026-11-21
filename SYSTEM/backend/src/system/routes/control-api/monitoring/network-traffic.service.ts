import { readFile } from "node:fs/promises";
import os from "node:os";
import { runWindowsResourceCommand } from "./windows-resource-command.js";

type NetworkCounter = { id: string; name: string; received: bigint; sent: bigint };
type NetworkRate = { id: string; name: string; downloadBytesPerSecond: number | null; uploadBytesPerSecond: number | null };
const counterText = /^\d{1,20}$/u;
const NETWORK_INTERVAL_MS = process.platform === "win32" ? 5_000 : 1_000;
const NETWORK_MAX_GAP_MS = 20_000;

export function parseLinuxNetworkCounters(text: string): NetworkCounter[] {
  const counters: NetworkCounter[] = [];
  for (const line of text.split("\n")) {
    const delimiter = line.lastIndexOf(":");
    if (delimiter < 1) continue;
    const name = line.slice(0, delimiter).trim();
    const columns = line.slice(delimiter + 1).trim().split(/\s+/u);
    const received = columns[0];
    const sent = columns[8];
    if (!name || name === "lo" || columns.length < 16 || !counterText.test(received) || !counterText.test(sent)) continue;
    counters.push({ id: name, name, received: BigInt(received), sent: BigInt(sent) });
  }
  return counters;
}

const windowsNetworkCommand = [
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "$network = @(",
  "foreach ($adapter in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {",
  "  if ($adapter.OperationalStatus -ne 'Up' -or $adapter.NetworkInterfaceType -eq 'Loopback') { continue }",
  "  try {",
  "    $stats = $adapter.GetIPStatistics()",
  "    [pscustomobject]@{ id = $adapter.Id; name = $adapter.Name; received = $stats.BytesReceived.ToString([Globalization.CultureInfo]::InvariantCulture); sent = $stats.BytesSent.ToString([Globalization.CultureInfo]::InvariantCulture) }",
  "  } catch {}",
  "})",
  "ConvertTo-Json -InputObject $network -Compress",
].join("\n");

export function parseWindowsNetworkCounters(text: string): NetworkCounter[] {
  const entries: unknown = JSON.parse(text.trim());
  if (!Array.isArray(entries)) return [];
  return entries.flatMap(entry => {
    if (typeof entry?.id !== "string" || !entry.id || typeof entry.name !== "string" || !entry.name
      || typeof entry.received !== "string" || !counterText.test(entry.received)
      || typeof entry.sent !== "string" || !counterText.test(entry.sent)) return [];
    return [{ id: entry.id, name: entry.name, received: BigInt(entry.received), sent: BigInt(entry.sent) }];
  });
}

async function readNetworkCounters() {
  if (process.platform === "win32") return parseWindowsNetworkCounters(await runWindowsResourceCommand(windowsNetworkCommand));
  if (process.platform !== "linux") return [];
  const interfaces = Object.entries(os.networkInterfaces())
    .filter(([, addresses]) => addresses?.some(address => !address.internal))
    .map(([name]) => name);
  const active = new Set(interfaces);
  return parseLinuxNetworkCounters(await readFile("/proc/net/dev", "utf8")).filter(entry => active.has(entry.id));
}

function rate(current: bigint, previous: bigint | undefined, elapsedMs: number) {
  if (previous === undefined || current < previous || elapsedMs <= 0) return null;
  return Math.round(Number(current - previous) * 1_000 / elapsedMs);
}

export function calculateNetworkRates(current: NetworkCounter[], previous: NetworkCounter[], elapsedMs: number): NetworkRate[] {
  const before = new Map(elapsedMs <= NETWORK_MAX_GAP_MS ? previous.map(entry => [entry.id, entry]) : []);
  return current.map(entry => {
    const old = before.get(entry.id);
    return {
      id: entry.id,
      name: entry.name,
      downloadBytesPerSecond: rate(entry.received, old?.received, elapsedMs),
      uploadBytesPerSecond: rate(entry.sent, old?.sent, elapsedMs),
    };
  });
}

let lastSample: { at: number; counters: NetworkCounter[]; rates: NetworkRate[] } | undefined;
let pending: Promise<NetworkRate[]> | undefined;

export function getNetworkTraffic() {
  if (lastSample && performance.now() - lastSample.at < NETWORK_INTERVAL_MS) return Promise.resolve(lastSample.rates);
  pending ??= readNetworkCounters().catch(() => []).then(counters => {
    const now = performance.now();
    const rates = calculateNetworkRates(counters, lastSample?.counters ?? [], now - (lastSample?.at ?? now));
    lastSample = { at: now, counters, rates };
    return rates;
  }).finally(() => { pending = undefined; });
  return pending;
}

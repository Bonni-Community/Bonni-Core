import { createReadStream, createWriteStream } from "node:fs";
import { access, chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { configuration, fail, newer, version } from "./protocol.mjs";

export async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await rename(temporary, file);
}
async function readJson(file, fallback) { try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return fallback; throw fail("STATE_INVALID", 500); } }
async function digest(file) {
  const hash = createHash("sha256"); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest("hex");
}
export async function runProcess(command, args, { cwd, outputFile, inputFile, env, discardOutput = false, timeoutMs = 120_000 } = {}) {
  const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: [inputFile ? "pipe" : "ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", size = 0;
  const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
  const hardTimeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs + 5000);
  child.stderr.on("data", (chunk) => { if (stderr.length < 16_384) stderr += chunk.toString(); });
  if (!outputFile) child.stdout.on("data", (chunk) => { if (discardOutput) return; size += chunk.length; if (size > 1_048_576) child.kill("SIGTERM"); else stdout += chunk.toString(); });
  const output = outputFile ? pipeline(child.stdout, createWriteStream(outputFile, { flags: "wx", mode: 0o600 })) : Promise.resolve();
  const input = inputFile ? pipeline(createReadStream(inputFile), child.stdin) : Promise.resolve();
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => code === 0 && size <= 1_048_576 ? resolve() : reject(fail("COMMAND_FAILED", 502))); });
  try { await Promise.all([exited, output, input]); return stdout; }
  catch (error) { child.kill("SIGKILL"); await Promise.allSettled([exited]); throw error; }
  finally { clearTimeout(timeout); clearTimeout(hardTimeout); }
}
export async function latestRelease(fetcher = fetch) {
  const response = await fetcher("https://api.github.com/repos/element-hq/synapse/releases/latest", {
    redirect: "error", signal: AbortSignal.timeout(15_000), headers: { Accept: "application/vnd.github+json", "User-Agent": "Bonni-Matrix-Manager/0.1" },
  });
  if (!response.ok) throw fail("UPDATE_SOURCE_UNREACHABLE", 502);
  const reader = response.body.getReader(); let text = "", bytes = 0;
  try { while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength;
    if (bytes > 1_048_576) { await reader.cancel(); throw fail("UPDATE_SOURCE_INVALID", 502); } text += new TextDecoder().decode(next.value, { stream: true }); } }
  finally { reader.releaseLock(); }
  const release = JSON.parse(text);
  if (release.prerelease || release.draft) throw fail("UPDATE_SOURCE_INVALID", 502);
  const selected = version(String(release.tag_name || "").replace(/^v/, ""));
  return { version: selected, releaseUrl: `https://github.com/element-hq/synapse/releases/tag/v${selected}`, checkedAt: new Date().toISOString() };
}

export class MatrixManager {
  constructor(root, { run = runProcess, release = latestRelease, health } = {}) {
    this.root = path.resolve(root); this.run = run; this.release = release; this.healthOverride = health;
    this.busy = false; this.catalog = null; this.job = null;
  }
  async initialize() {
    this.installation = await readJson(path.join(this.root, "installation.json"));
    if (!this.installation || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,40}$/.test(this.installation.installationId)) throw fail("INSTALLATION_INVALID", 500);
    version(this.installation.version);
    this.job = await readJson(path.join(this.root, "job.json"), null);
    // A killed manager must not guess that a partly applied schema is safe.
    if (this.job?.state === "running") { this.job = { ...this.job, state: "recovery-required", stage: "interrupted" }; await this.saveJob(); }
    return this;
  }
  compose(args, options = {}) {
    return this.run("docker", ["compose", "--project-name", this.installation.installationId, "--env-file", path.join(this.root, "runtime.env"),
      "--file", path.join(this.root, "compose.yaml"), ...args], { cwd: this.root, ...options,
        env: { ...process.env, SYNAPSE_VERSION: options.imageVersion || this.installation.version } });
  }
  async settings() { return configuration(await readJson(path.join(this.root, "settings.json")), this.installation.serverName); }
  async status() {
    let services = [], connected = true;
    try {
      const output = await this.compose(["ps", "--all", "--format", "json"]);
      if (output.trim().startsWith("[")) services = JSON.parse(output);
      else services = output.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch { connected = false; }
    return { installationId: this.installation.installationId, connected, serverName: this.installation.serverName,
      publicBaseUrl: (await this.settings()).publicBaseUrl, version: this.installation.version, installed: await this.installed(),
      services: ["synapse", "db"].map((service) => { const value = services.find((item) => item.Service === service);
        return { service, state: value?.State || "not-created", health: value?.Health || "" }; }),
      job: this.job, availableUpdate: this.catalog && newer(this.catalog.version, this.installation.version) ? this.catalog : null,
      independent: true };
  }
  async installed() { if (!this.installation.installed) return false; try { await access(path.join(this.root, "data/homeserver.yaml"), constants.R_OK); return true; } catch { return false; } }
  async saveJob() { await atomicJson(path.join(this.root, "job.json"), this.job); }
  async stage(value) { this.job.stage = value; await this.saveJob(); }
  async health() {
    if (this.healthOverride) return this.healthOverride();
    const started = Date.now();
    while (Date.now() - started < 300_000) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.installation.clientPort}/_matrix/client/versions`, { signal: AbortSignal.timeout(3000), redirect: "error" });
        if (response.ok && Array.isArray((await response.json()).versions)) {
          const policy = await fetch(`http://127.0.0.1:${this.installation.clientPort}/_synapse/client/bonni/policy`, { signal: AbortSignal.timeout(3000), redirect: "error" });
          if (policy.status === 401 && (await policy.json()).errcode === "M_MISSING_TOKEN") return;
          if (policy.status === 404) throw fail("SERVER_EXTENSION_MISSING", 502);
        }
      } catch (error) { if (error.message === "SERVER_EXTENSION_MISSING") throw error; /* Initialization or database migration is still running. */ }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw fail("HEALTH_CHECK_FAILED", 502);
  }
  async backup() {
    await this.stage("backup");
    const before = await this.status();
    if (before.services.find((service) => service.service === "db")?.state !== "running") throw fail("DATABASE_NOT_RUNNING", 409);
    const wasRunning = before.services.find((service) => service.service === "synapse")?.state === "running";
    const id = `${new Date().toISOString().replace(/[^0-9TZ]/g, "")}-${randomUUID()}`;
    const folder = path.join(this.root, "backups", id); await mkdir(folder, { recursive: true, mode: 0o700 });
    await this.compose(["stop", "--timeout", "30", "synapse"]);
    try {
      await this.compose(["exec", "-T", "db", "pg_dump", "--format=custom", "--username=matrix", "matrix"], { outputFile: path.join(folder, "database.dump"), timeoutMs: 600_000 });
      if ((await stat(path.join(folder, "database.dump"))).size < 1) throw fail("BACKUP_EMPTY", 500);
      await this.compose(["exec", "-T", "db", "pg_restore", "--list"], { inputFile: path.join(folder, "database.dump"), discardOutput: true, timeoutMs: 600_000 });
      await this.run("tar", ["-czf", path.join(folder, "data.tar.gz"), "-C", path.join(this.root, "data"), "."], { cwd: this.root, timeoutMs: 600_000 });
      await chmod(path.join(folder, "data.tar.gz"), 0o600);
      await this.run("tar", ["-tzf", path.join(folder, "data.tar.gz")], { cwd: this.root, discardOutput: true, timeoutMs: 600_000 });
      const backup = { id, wasRunning, installation: this.installation, settings: await this.settings(),
        databaseSha256: await digest(path.join(folder, "database.dump")), dataSha256: await digest(path.join(folder, "data.tar.gz")) };
      await atomicJson(path.join(folder, "backup.json"), backup);
      this.job.backupId = id; await this.saveJob(); return backup;
    } catch (error) { if (wasRunning) await this.compose(["up", "-d", "--no-deps", "synapse"]); throw error; }
  }
  async writeVersion(selected) {
    version(selected);
    const env = (await readFile(path.join(this.root, "runtime.env"), "utf8")).replace(/^SYNAPSE_VERSION=.*$/m, `SYNAPSE_VERSION=${selected}`);
    const temp = path.join(this.root, `runtime-${randomUUID()}.tmp`); await writeFile(temp, env, { mode: 0o600, flag: "wx" });
    await rename(temp, path.join(this.root, "runtime.env"));
    this.installation = { ...this.installation, version: selected };
    await atomicJson(path.join(this.root, "installation.json"), this.installation);
  }
  async restore(backup) {
    await this.stage("restoring");
    const folder = path.join(this.root, "backups", backup.id);
    if (!/^[0-9TZ]+-[0-9a-f-]{36}$/.test(backup.id) || backup.installation.installationId !== this.installation.installationId
      || backup.installation.serverName !== this.installation.serverName) throw fail("BACKUP_IDENTITY_MISMATCH", 500);
    if (await digest(path.join(folder, "database.dump")) !== backup.databaseSha256 || await digest(path.join(folder, "data.tar.gz")) !== backup.dataSha256) throw fail("BACKUP_INTEGRITY_FAILED", 500);
    await this.compose(["stop", "--timeout", "30", "synapse"]);
    await this.compose(["exec", "-T", "db", "dropdb", "--force", "--if-exists", "--username=matrix", "matrix"]);
    await this.compose(["exec", "-T", "db", "createdb", "--username=matrix", "--owner=matrix", "--template=template0", "--encoding=UTF8", "--lc-collate=C", "--lc-ctype=C", "matrix"]);
    await this.compose(["exec", "-T", "db", "pg_restore", "--no-owner", "--username=matrix", "--dbname=matrix"], { inputFile: path.join(folder, "database.dump"), timeoutMs: 600_000 });
    await rename(path.join(this.root, "data"), path.join(this.root, `failed-data-${randomUUID()}`));
    await mkdir(path.join(this.root, "data"), { mode: 0o700 });
    await this.run("tar", ["-xzf", path.join(folder, "data.tar.gz"), "-C", path.join(this.root, "data")], { cwd: this.root, timeoutMs: 600_000 });
    await atomicJson(path.join(this.root, "settings.json"), backup.settings);
    await this.writeVersion(backup.installation.version);
    if (backup.wasRunning) { await this.compose(["up", "-d", "--no-deps", "synapse"]); await this.health(); }
  }
  async perform(action, payload) {
    if (action === "start") { await this.compose(["up", "-d", "db", "synapse"]); await this.health(); return; }
    if (action === "stop") { await this.compose(["stop", "--timeout", "30", "synapse"]); return; }
    if (action === "restart") { await this.compose(["restart", "--timeout", "30", "synapse"]); await this.health(); return; }
    let target, nextSettings;
    if (action === "update") {
      if (!this.catalog || payload.version !== this.catalog.version || !newer(payload.version, this.installation.version)) throw fail("UPDATE_SELECTION_EXPIRED", 409);
      target = version(payload.version);
      await this.stage("preparing-image");
      await this.compose(["build", "--pull", "--build-arg", `SYNAPSE_BASE_IMAGE=ghcr.io/element-hq/synapse:v${target}`, "synapse"], { imageVersion: target, discardOutput: true, timeoutMs: 900_000 });
    } else {
      nextSettings = configuration(payload, this.installation.serverName);
      if (nextSettings.revision !== (await this.settings()).revision) throw fail("CONFIGURATION_CHANGED", 409);
      nextSettings.revision++;
    }
    const backup = await this.backup();
    try {
      if (target) await this.writeVersion(target);
      if (nextSettings) {
        await atomicJson(path.join(this.root, "settings.json"), nextSettings);
        await this.compose(["run", "--rm", "--no-deps", "--entrypoint", "python", "synapse", "/opt/bonni/configure.py"]);
      }
      await this.stage("starting");
      if (backup.wasRunning) { await this.compose(["up", "-d", "--no-deps", "synapse"]); await this.health(); }
      else await this.compose(["create", "--no-deps", "synapse"]);
    } catch (error) {
      try { await this.restore(backup); this.job.state = "restored"; }
      catch { this.job.state = "recovery-required"; }
      throw error;
    }
  }
  async command(action, payload = {}, requestId) {
    if (!this.busy) {
      const refreshed = await readJson(path.join(this.root, "installation.json"));
      if (refreshed.installationId !== this.installation.installationId || refreshed.serverName !== this.installation.serverName) throw fail("INSTALLATION_IDENTITY_CHANGED", 409);
      this.installation = refreshed;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw fail("INPUT_INVALID");
    if (action !== "configure" && Object.keys(payload).some((key) => action !== "update" || key !== "version")) throw fail("INPUT_INVALID");
    if (action === "status") return this.status();
    if (action === "configuration") return this.settings();
    if (this.job?.requestId === requestId && requestId) return { job: this.job };
    if (this.busy || this.job?.state === "recovery-required") throw fail("BUSY", 409);
    if (action === "check-update") {
      this.busy = true;
      try { this.catalog = await this.release(); return { ...this.catalog, available: newer(this.catalog.version, this.installation.version) }; }
      finally { this.busy = false; }
    }
    if (!await this.installed()) throw fail("NOT_INSTALLED", 409);
    if (!["start", "stop", "restart", "configure", "update"].includes(action)) throw fail("ACTION_INVALID");
    // Validate before accepting the background operation.
    if (action === "configure") configuration(payload, this.installation.serverName);
    if (action === "update" && (!this.catalog || payload.version !== this.catalog.version)) throw fail("UPDATE_SELECTION_EXPIRED", 409);
    this.busy = true;
    this.job = { id: randomUUID(), requestId, action, state: "running", stage: "queued", startedAt: new Date().toISOString(), backupId: null, error: null };
    try { await this.saveJob(); } catch (error) { this.busy = false; throw error; }
    this.finished = this.perform(action, payload).then(() => { this.job.state = "succeeded"; this.job.stage = "done"; },
      (error) => { if (this.job.state === "running") this.job.state = "failed"; this.job.error = /^[A-Z_]{2,80}$/.test(error.message) ? error.message : "OPERATION_FAILED"; })
      .finally(async () => { this.job.finishedAt = new Date().toISOString(); this.busy = false; await this.saveJob(); });
    this.finished.catch(() => { this.job.state = "recovery-required"; this.job.error = "STATE_WRITE_FAILED"; this.busy = false; });
    return { job: { ...this.job } };
  }
}

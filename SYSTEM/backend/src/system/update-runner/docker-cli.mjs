import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { inspectDockerArchiveTags } from "./archive-tags.mjs";

const MAX_OUTPUT_BYTES = 1024 * 1024;

export function spawnCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const append = (current, chunk) => `${current}${String(chunk)}`.slice(-MAX_OUTPUT_BYTES);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const timeoutMs = Number(options.timeoutMs ?? 10 * 60_000);
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    timer.unref();
    child.once("error", (error) => {
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = { code: code ?? -1, signal, stdout: stdout.trim(), stderr: stderr.trim() };
      if (code === 0) resolve(result);
      else {
        const error = new Error(result.stderr || result.stdout || `${command} wurde mit Status ${code} beendet.`);
        error.result = result;
        reject(error);
      }
    });
  });
}

const HEALTH_SCRIPT = [
  "const u=process.argv[1];",
  "fetch(u,{signal:AbortSignal.timeout(5000)})",
  ".then(async r=>{const t=await r.text();if(!r.ok)throw new Error('HTTP '+r.status);JSON.parse(t);process.stdout.write(t)})",
  ".catch(e=>{console.error(e.message);process.exit(1)})",
].join("");

export class DockerCli {
  constructor(config = {}) {
    this.binary = config.binary || "docker";
    this.composeFile = config.composeFile;
    this.project = config.project;
    this.baseEnvironmentFile = config.baseEnvironmentFile;
    this.activeEnvironmentFile = config.activeEnvironmentFile;
    this.cwd = config.cwd;
    this.baseEnv = { ...process.env, ...(config.env || {}) };
    this.execute = config.execute || spawnCommand;
    this.commandTimeoutMs = Number(config.commandTimeoutMs ?? 30 * 60_000);
    this.tarBinary = config.tarBinary || "/bin/tar";
  }

  run(args, options = {}) {
    return this.execute(this.binary, args, {
      cwd: this.cwd,
      env: { ...this.baseEnv, ...(options.env || {}) },
      timeoutMs: options.timeoutMs ?? this.commandTimeoutMs,
    });
  }

  compose(args, options = {}) {
    if (!this.baseEnvironmentFile || !existsSync(this.baseEnvironmentFile)) {
      throw new Error("Feste Bonni-Runtime-Umgebungsdatei fehlt.");
    }
    const environmentFiles = [
      "--env-file", this.baseEnvironmentFile,
    ];
    if (this.activeEnvironmentFile && existsSync(this.activeEnvironmentFile)) {
      environmentFiles.push("--env-file", this.activeEnvironmentFile);
    }
    return this.run(["compose", "-p", this.project, ...environmentFiles, "-f", this.composeFile, ...args], options);
  }

  async serviceContainer(service) {
    // Boot recovery deliberately stops Active before inspecting its immutable
    // image ID, so include stopped Compose containers in the lookup.
    const result = await this.compose(["ps", "--all", "-q", service], { timeoutMs: 30_000 });
    const id = result.stdout.split(/\s+/).filter(Boolean)[0];
    if (!id || !/^[a-zA-Z0-9_.-]{3,128}$/.test(id)) throw new Error(`Container für ${service} wurde nicht gefunden.`);
    return id;
  }

  async containerImageId(container) {
    const result = await this.run(["inspect", "--format", "{{.Image}}", container], { timeoutMs: 30_000 });
    if (!/^sha256:[a-f0-9]{64}$/.test(result.stdout)) throw new Error("Docker lieferte keine gültige Image-ID.");
    return result.stdout;
  }

  async imageId(reference) {
    const result = await this.run(["image", "inspect", "--format", "{{.Id}}", reference], { timeoutMs: 30_000 });
    if (!/^sha256:[a-f0-9]{64}$/.test(result.stdout)) throw new Error("Docker lieferte keine gültige Image-ID.");
    return result.stdout;
  }

  async imageIdentity(reference) {
    const result = await this.run(["image", "inspect", "--format", "{{json .}}", reference], { timeoutMs: 30_000 });
    let inspected;
    try { inspected = JSON.parse(result.stdout); } catch { throw new Error("Docker lieferte keine gültige Image-Identität."); }
    if (!/^sha256:[a-f0-9]{64}$/.test(inspected?.Id || "")) throw new Error("Geladenes Image besitzt keine gültige Image-ID.");
    return {
      id: inspected.Id,
      repoDigests: Array.isArray(inspected.RepoDigests) ? inspected.RepoDigests : [],
      os: inspected.Os,
      architecture: inspected.Architecture,
      variant: inspected.Variant || undefined,
    };
  }

  loadImage(archive) {
    return this.run(["image", "load", "--input", archive]);
  }

  archiveImageTags(archive) {
    return inspectDockerArchiveTags(archive, { tarBinary: this.tarBinary });
  }

  tagImage(imageId, target) {
    return this.run(["image", "tag", imageId, target], { timeoutMs: 30_000 });
  }

  async health(service, url = "http://127.0.0.1:4000/api/health/ready") {
    const result = await this.compose(["exec", "-T", service, "node", "-e", HEALTH_SCRIPT, url], { timeoutMs: 15_000 });
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error(`${service} lieferte keinen gültigen JSON-Systemstatus.`);
    }
  }

  async proxyHealth(fromService, role = "active") {
    const endpoint = role === "candidate" ? "update-probe" : "ready";
    return this.health(fromService, `http://runtime-proxy/api/health/${endpoint}`);
  }

  async connectNetwork(network, container, alias) {
    try {
      return await this.run(["network", "connect", "--alias", alias, network, container], { timeoutMs: 30_000 });
    } catch (error) {
      if (/already exists|already connected|endpoint with name .* exists/i.test(String(error?.message || ""))) return null;
      throw error;
    }
  }

  async disconnectNetwork(network, container) {
    try {
      return await this.run(["network", "disconnect", network, container], { timeoutMs: 30_000 });
    } catch (error) {
      if (/not connected|no such container|no such endpoint|not found/i.test(String(error?.message || ""))) return null;
      throw error;
    }
  }

  async runningServiceContainers(services) {
    if (!Array.isArray(services) || services.length === 0
      || services.some((service) => !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(String(service)))) {
      throw new Error("Ungültige Service-Liste für die Schreibzaunprüfung.");
    }
    const result = await this.compose([
      "--profile", "update", "ps", "--all", "--status", "running", "-q", ...services,
    ], { timeoutMs: 30_000 });
    const containers = result.stdout.split(/\s+/).filter(Boolean);
    if (containers.some((container) => !/^[a-zA-Z0-9_.-]{3,128}$/.test(container))) {
      throw new Error("Docker lieferte ungültige Container-IDs für die Schreibzaunprüfung.");
    }
    return containers;
  }

  async stopRunningServiceContainers(services) {
    const containers = await this.runningServiceContainers(services);
    for (const container of containers) {
      await this.run(["container", "stop", "--time", "30", container], { timeoutMs: 60_000 });
    }
    const remaining = await this.runningServiceContainers(services);
    if (remaining.length) throw new Error(`Produktionsschreiber liefen nach Docker-Stop weiter: ${remaining.join(",")}`);
    return containers;
  }

  async removeDisposableVolume(volume, expectedProject, expectedLogicalName) {
    let result;
    try {
      result = await this.run(["volume", "inspect", "--format", "{{json .Labels}}", volume], { timeoutMs: 30_000 });
    } catch (error) {
      if (/no such volume|not found/i.test(String(error?.message || ""))) return false;
      throw error;
    }
    let labels;
    try { labels = JSON.parse(result.stdout); } catch { throw new Error(`Volume ${volume} besitzt keine prüfbaren Labels.`); }
    if (labels?.["org.bonni.runtime.disposable"] !== "true"
      || labels?.["com.docker.compose.project"] !== expectedProject
      || labels?.["com.docker.compose.volume"] !== expectedLogicalName) {
      throw new Error(`Löschen des nicht eindeutig disponiblen Volumes ${volume} wurde verweigert.`);
    }
    await this.run(["volume", "rm", volume], { timeoutMs: 60_000 });
    return true;
  }
}

export async function discoverComposeProject({ docker, hostname, configuredProject }) {
  if (!hostname || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(hostname)) {
    throw new Error("HOSTNAME ist für die Compose-Projektprüfung ungültig.");
  }
  const result = await docker.run([
    "inspect", "--format", "{{ index .Config.Labels \"com.docker.compose.project\" }}", hostname,
  ], { timeoutMs: 30_000 });
  const project = result.stdout;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(project)) {
    throw new Error("Compose-Projekt konnte nicht aus dem Runner-Container ermittelt werden.");
  }
  if (configuredProject && project !== configuredProject) {
    throw new Error("COMPOSE_PROJECT_NAME stimmt nicht mit dem eigenen Runner-Containerlabel überein.");
  }
  return project;
}

import { mkdir, readFile, writeFile, copyFile, access, readdir, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { MatrixManager, atomicJson } from "./manager.mjs";
import { createManagerServer } from "./server.mjs";
import { publicUrl, serverName, version, fail } from "./protocol.mjs";

const args = process.argv.slice(2), command = args.shift();
const option = (name, fallback) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : fallback; };
const root = path.resolve(option("directory", "./bonni-matrix"));
async function main() {
  if (command === "init") {
    const installationId = option("id", "bonni-matrix");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,40}$/.test(installationId)) throw fail("INSTALLATION_ID_INVALID");
    const own = serverName(option("server-name", "")), url = publicUrl(option("public-url", ""));
    const selected = version(option("version", "1.165.0"));
    const port = Number(option("client-port", "18008"));
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw fail("PORT_INVALID");
    try { await mkdir(root, { mode: 0o700 }); } catch (error) {
      if (error.code !== "EEXIST" || (await readdir(root)).length) throw fail("INSTALLATION_DIRECTORY_NOT_EMPTY");
      await chmod(root, 0o700);
    }
    for (const folder of ["data", "postgres", "secrets", "backups"]) await mkdir(path.join(root, folder), { mode: 0o700 });
    const source = path.dirname(fileURLToPath(import.meta.url));
    for (const file of ["compose.yaml", "Dockerfile", ".dockerignore", "bonni_policy.py", "configure.py"]) await copyFile(path.join(source, file), path.join(root, file));
    await atomicJson(path.join(root, "installation.json"), { installationId, serverName: own, version: selected, clientPort: port, installed: false });
    await atomicJson(path.join(root, "settings.json"), { serverName: own, publicBaseUrl: url, allowedServers: [], maxUploadMiB: 50, revision: 0 });
    await writeFile(path.join(root, "control.key"), randomBytes(32).toString("base64url") + "\n", { flag: "wx", mode: 0o600 });
    await writeFile(path.join(root, "secrets/postgres_password"), randomBytes(48).toString("base64url"), { flag: "wx", mode: 0o600 });
    await writeFile(path.join(root, "runtime.env"), `MATRIX_INSTALLATION_ID=${installationId}\nMATRIX_SERVER_NAME=${own}\nSYNAPSE_VERSION=${selected}\nMATRIX_CLIENT_PORT=${port}\nMATRIX_UID=${process.getuid?.() || 1000}\nMATRIX_GID=${process.getgid?.() || 1000}\n`, { mode: 0o600, flag: "wx" });
    console.log("Vorbereitet. Der Steuerungsschlüssel liegt ausschließlich in control.key. Es wurden noch keine Container gestartet.");
    return;
  }
  const manager = await new MatrixManager(root).initialize();
  if (command === "install") {
    if (await manager.installed()) throw fail("ALREADY_INSTALLED", 409);
    await manager.compose(["build", "--pull", "synapse"], { timeoutMs: 900_000 });
    let generated = false; try { await access(path.join(root, "data/homeserver.yaml")); generated = true; } catch {}
    if (!generated) await manager.compose(["run", "--rm", "--no-deps", "synapse", "generate"]);
    await manager.compose(["run", "--rm", "--no-deps", "--entrypoint", "python", "synapse", "/opt/bonni/configure.py"]);
    await manager.compose(["up", "-d", "db", "synapse"]);
    await manager.health(); manager.installation.installed = true; await atomicJson(path.join(root, "installation.json"), manager.installation);
    console.log("Matrix / Synapse ist eingerichtet und läuft unabhängig von Bonni Core."); return;
  }
  if (command === "recover") {
    const backupId = option("backup-id", "");
    if (!/^[0-9TZ]+-[0-9a-f-]{36}$/.test(backupId)) throw fail("BACKUP_ID_INVALID");
    manager.job = { id: randomUUID(), state: "running", action: "recover", stage: "restoring" };
    const backup = JSON.parse(await readFile(path.join(root, "backups", backupId, "backup.json"), "utf8"));
    await manager.restore(backup); manager.job.state = "succeeded"; manager.job.stage = "done"; await manager.saveJob();
    console.log("Vorheriger Matrix-Stand wurde wiederhergestellt."); return;
  }
  if (command !== "serve") throw fail("USE_INIT_INSTALL_SERVE_OR_RECOVER");
  const port = Number(option("port", "18090")), bind = option("bind", "127.0.0.1");
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || !["127.0.0.1", "0.0.0.0", "::1"].includes(bind)) throw fail("LISTENER_INVALID");
  const { server } = await createManagerServer(root, { manager });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, bind, resolve); });
  console.log(`Matrix-Verwaltung läuft auf ${bind}:${port}.`);
  const stop = async () => { server.close(); await manager.finished?.catch(() => {}); process.exit(0); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}
main().catch((error) => { console.error(/^[A-Z_]{2,80}$/.test(error.message) ? error.message : "MATRIX_MANAGER_SETUP_FAILED"); process.exitCode = 1; });

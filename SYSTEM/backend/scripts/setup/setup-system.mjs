import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPrebuiltFrontendMarker,
  resolveFrontendSetupMode,
  verifyPrebuiltFrontend,
} from "./prebuilt-frontend.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDirectory, "../..");
const systemRoot = path.resolve(backendRoot, "..");
const frontendRoot = path.join(systemRoot, "frontend");
const frontendBuildRoot = path.join(frontendRoot, "dist");
const publishedFrontendRoot = path.join(backendRoot, "public", "system");

function npmInvocation(args) {
  const npmCli = String(process.env.npm_execpath || "").trim();
  if (npmCli) {
    return {
      command: process.execPath,
      args: [npmCli, ...args],
    };
  }

  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args,
  };
}

function runStage(label, cwd, args) {
  const invocation = npmInvocation(args);
  console.log(`\n[bonni-setup] ${label}`);

  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });

    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `SETUP_STAGE_FAILED:${label}:${signal ? `signal-${signal}` : `exit-${code}`}`,
      ));
    });
  });
}

async function publishFrontend() {
  const sourceIndex = path.join(frontendBuildRoot, "index.html");
  const sourceIndexState = await fs.stat(sourceIndex).catch(() => null);
  if (!sourceIndexState?.isFile()) {
    throw new Error("SETUP_FRONTEND_BUILD_MISSING");
  }

  console.log("\n[bonni-setup] Gebautes Frontend für den gemeinsamen Systemstart bereitstellen");
  await fs.rm(publishedFrontendRoot, { recursive: true, force: true });
  await fs.mkdir(path.dirname(publishedFrontendRoot), { recursive: true });
  await fs.cp(frontendBuildRoot, publishedFrontendRoot, {
    recursive: true,
    force: true,
  });
  await createPrebuiltFrontendMarker(publishedFrontendRoot);
  await verifyPrebuiltFrontend(publishedFrontendRoot);
}

const baseStages = [
  ["Backend-Abhängigkeiten installieren/aktualisieren", backendRoot, [
    "ci",
    "--include=dev",
    "--no-audit",
    "--no-fund",
  ]],
  ["Alte technische Dateien bereinigen", backendRoot, ["run", "maintenance:cleanup"]],
  ["Systemschlüssel sicherstellen", backendRoot, ["run", "auth:ensure-jwt"]],
  ["Datenbanken, Schemas, Rollen und Rechte aktualisieren", backendRoot, [
    "run",
    "database:bootstrap",
  ]],
  ["Prisma Client aktualisieren", backendRoot, ["run", "prisma:generate"]],
  ["Technische Systemdaten und Administrator anlegen/reparieren", backendRoot, [
    "run",
    "seed",
  ]],
  ["Backend erzeugen und prüfen", backendRoot, ["run", "build:code"]],
  ["Core-gesteuerte App-Laufzeitpakete erzeugen", backendRoot, ["run", "modules:build"]],
  ["Core-gesteuerte App-Laufzeitpakete prüfen", backendRoot, ["run", "modules:verify"]],
  ["Modul-Lizenzpayloads zentral und unveränderlich ablegen", backendRoot, ["run", "modules:sync-legal-payloads"]],
  ["KontorApp zentral registrieren, aktivieren und Fachrouten prüfen", backendRoot, ["run", "modules:repair:kontorapp"]],
];

try {
  const frontendMode = await resolveFrontendSetupMode({ frontendRoot, publishedFrontendRoot });
  const frontendStages = frontendMode === "source"
    ? [
        ["Frontend-Abhängigkeiten installieren/aktualisieren", frontendRoot, [
          "ci", "--include=dev", "--no-audit", "--no-fund",
        ]],
        ["Frontend erzeugen", frontendRoot, ["run", "build"]],
      ]
    : [];
  const stages = [baseStages[0], ...frontendStages.slice(0, 1), ...baseStages.slice(1, -2), ...frontendStages.slice(1), ...baseStages.slice(-2)];
  for (const [label, cwd, args] of stages) {
    await runStage(label, cwd, args);
  }
  if (frontendMode === "source") await publishFrontend();
  else {
    await verifyPrebuiltFrontend(publishedFrontendRoot);
    console.log("\n[bonni-setup] Versions- und hashgebundenes Prebuilt-Core-Frontend unverändert beibehalten.");
  }
  console.log("\n[bonni-setup] Einrichtung/Aktualisierung vollständig abgeschlossen.");
  console.log("[bonni-setup] App-Laufzeitmodule wurden zentral durch Bonni Core bereitgestellt und geprüft.");
  console.log("[bonni-setup] Prisma-Fragmente wurden zentral und ausschließlich aus den Manifesten zusammengesetzt.");
  console.log("[bonni-setup] Standardzugang einer neuen Installation: admin / hamster");
  console.log("[bonni-setup] Systemstart: npm start");
} catch (error) {
  console.error("\n[bonni-setup] Einrichtung/Aktualisierung abgebrochen.");
  console.error(error);
  process.exitCode = 1;
}

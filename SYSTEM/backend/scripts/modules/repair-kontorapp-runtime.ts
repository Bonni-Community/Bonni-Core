import {
  activateModulePackage,
  installModulePackage,
} from "../../src/platform/module-manager/install/module-install.service.js";
import express from "express";
import { findInstalledModule } from "../../src/platform/module-manager/registry/installed-module.repository.js";
import {
  getRuntimeModuleSummaryByManifestId,
  registerModules,
} from "../../src/platform/module-manager/loader/module-runtime.service.js";

const MODULE_KEY = "app.kontorapp";

function fail(message: string, details?: unknown): never {
  console.error(`[kontorapp-repair] ${message}`);
  if (details) console.error(JSON.stringify(details, null, 2));
  process.exit(1);
}

async function verifyKontorHttpRoute() {
  const app = express();
  await registerModules(app);
  const runtime = await getRuntimeModuleSummaryByManifestId(MODULE_KEY);
  if (runtime?.status !== "loaded") {
    throw new Error(
      `KONTORAPP_RUNTIME_NOT_LOADED:${runtime?.status || "missing"}:${runtime?.error || "Kein Laufzeitfehler vorhanden"}`,
    );
  }
  app.use((_request, response) => {
    response.status(404).json({ ok: false, error: "KONTORAPP_ROUTE_SMOKE_TEST_NOT_FOUND" });
  });

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.once("error", reject);
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("KONTORAPP_ROUTE_SMOKE_TEST_ADDRESS_UNAVAILABLE");
    }
    const routes = [
      "/api/apps/kontorapp/health",
      "/api/apps/kontorapp/members",
      "/api/apps/kontorapp/settings/member-fields",
      "/api/apps/kontorapp/accounting/tax-rates",
      "/api/apps/kontorapp/accounting/financial-accounts",
      "/api/apps/kontorapp/accounting/incoming-invoices",
      "/api/apps/kontorapp/accounting/closings",
      "/api/apps/kontorapp/procurement/rules",
      "/api/apps/kontorapp/procurement/cases?limit=1",
      // Phase 9: read-only registration smokes. The synthetic detail identifiers
      // deliberately cannot address real data; without a private grant the guards
      // normally answer 401/403 before any repository lookup.
      "/api/apps/kontorapp/accounting/contributions",
      "/api/apps/kontorapp/accounting/contribution-runs/__core_repair_smoke__?limit=1",
      "/api/apps/kontorapp/accounting/collection-exports?limit=1",
      "/api/apps/kontorapp/accounting/collection-exports/__core_repair_smoke__?itemLimit=1&historyLimit=1",
      "/api/apps/kontorapp/accounting/member-accounts?limit=1",
      "/api/apps/kontorapp/accounting/member-accounts/__core_repair_smoke__/transactions?limit=1",
      // Phase 10: These GET requests remain read-only. Missing private access is
      // an acceptable 401/403 response; a 404 would prove that the new runtime
      // routes were not registered by Bonni Core.
      "/api/apps/kontorapp/accounting/datev/settings",
      "/api/apps/kontorapp/accounting/year-end/2026/workspace",
    ];
    for (const route of routes) {
      const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
        redirect: "manual",
      });
      const body = await response.text();
      if (response.status === 404 || response.status >= 500) {
        throw new Error(
          `KONTORAPP_HTTP_ROUTE_TEST_FAILED:${route}:${response.status}:${body.slice(0, 500)}`,
        );
      }
      console.log(`[kontorapp-repair] Fachroute vorhanden: GET ${route} -> ${response.status}.`);
    }
    console.log(`[kontorapp-repair] HTTP-Routentest erfolgreich: ${routes.length} KontorApp-Routen geprueft.`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function main() {
  console.log("[kontorapp-repair] KontorApp-Installation und Laufzeitstatus pruefen");

  let installed = await findInstalledModule(MODULE_KEY);
  console.log(
    installed
      ? "[kontorapp-repair] Vorhandene Registrierung wird mit Manifest, Prisma-Domain und Backend-Einstieg neu synchronisiert."
      : "[kontorapp-repair] Paket ist noch nicht registriert und wird installiert.",
  );
  const installation = await installModulePackage(MODULE_KEY);
  if (!installation.ok) {
    fail("KontorApp konnte nicht installiert beziehungsweise synchronisiert werden.", installation);
  }
  installed = installation.module;

  console.log(
    `[kontorapp-repair] Gefunden: ${installed.version} (${installed.status}). `
      + "Die Backend-Routen werden jetzt in einem echten Laufzeittest registriert.",
  );

  const activation = await activateModulePackage(MODULE_KEY);
  if (!activation.ok) {
    fail(
      activation.message || "KontorApp konnte nicht aktiviert werden.",
      {
        error: activation.error,
        compatibility: activation.compatibility,
        runtime: activation.runtime,
        prismaAssembly: activation.prismaAssembly,
      },
    );
  }

  const runtimeStatus = activation.runtime?.status || "unknown";
  await verifyKontorHttpRoute();
  console.log(`[kontorapp-repair] Erfolgreich: KontorApp ist aktiviert (Laufzeit: ${runtimeStatus}).`);
  console.log("[kontorapp-repair] Bonni Core jetzt neu starten und den Browser mit Strg+F5 laden.");
}

main().catch((error) => fail(error instanceof Error ? error.stack || error.message : String(error)));

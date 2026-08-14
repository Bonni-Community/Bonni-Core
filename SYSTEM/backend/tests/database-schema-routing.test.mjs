import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  normalizePrismaConnectionString,
  prismaPgOptionsForDomain,
} from "../dist/core/database/prisma.js";
import { isDatabaseAuthorizationFailure } from "../dist/core/database/database-routing.js";

test("Prisma schema URLs become PostgreSQL session search paths", () => {
  const normalized = new URL(normalizePrismaConnectionString(
    "postgresql://core_user:secret@localhost:5432/bonni?schema=core&sslmode=prefer",
  ));

  assert.equal(normalized.searchParams.get("schema"), null);
  assert.equal(normalized.searchParams.get("options"), "-c search_path=core");
  assert.equal(normalized.searchParams.get("sslmode"), "disable");
});

test("the Prisma pg adapter receives the owning domain schema explicitly", () => {
  assert.deepEqual(prismaPgOptionsForDomain("core"), { schema: "core" });
  assert.deepEqual(prismaPgOptionsForDomain("kontor"), { schema: "kontor" });
  assert.deepEqual(prismaPgOptionsForDomain("stueberl"), { schema: "stueberl" });
  assert.deepEqual(prismaPgOptionsForDomain("pos"), { schema: "pos" });
});

test("existing PostgreSQL startup options are preserved", () => {
  const normalized = new URL(normalizePrismaConnectionString(
    "postgresql://core_user:secret@localhost:5432/bonni?schema=core&options=-c%20statement_timeout%3D5000",
  ));

  assert.equal(
    normalized.searchParams.get("options"),
    "-c statement_timeout=5000 -c search_path=core",
  );
});

test("unknown runtime schemas are rejected", () => {
  assert.throws(
    () => normalizePrismaConnectionString(
      "postgresql://core_user:secret@localhost:5432/bonni?schema=public",
    ),
    /DATABASE_SCHEMA_INVALID:public/,
  );
});

test("PostgreSQL schema permission failures are not classified as outages", () => {
  const error = Object.assign(
    new Error('PostgresError { code: "42501", message: "keine Berechtigung für Schema public" }'),
    { code: "P2010" },
  );

  assert.equal(isDatabaseAuthorizationFailure(error), true);
});

test("database setup repairs and verifies least-privilege domain grants", async () => {
  const bootstrap = await readFile(
    new URL("../scripts/database/bootstrap-isolated-databases.ts", import.meta.url),
    "utf8",
  );

  assert.match(bootstrap, /REVOKE ALL ON SCHEMA public FROM PUBLIC/);
  assert.match(bootstrap, /DATABASE_DOMAIN_GRANTS_INCOMPLETE/);
  assert.match(bootstrap, /DATABASE_DOMAIN_CROSS_ACCESS_DETECTED/);
  assert.match(bootstrap, /verifyDomainIsolation\(adminUrl, databases\.main\.normal/);
  assert.match(bootstrap, /verifyDomainIsolation\(adminUrl, databases\.pos\.normal/);
});

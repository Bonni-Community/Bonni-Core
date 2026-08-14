import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectRoot = await mkdtemp(path.join(os.tmpdir(), "bonni-prisma-assembly-"));
process.env.BONNI_PROJECT_ROOT = projectRoot;
await mkdir(path.join(projectRoot, "backend", "prisma", "domains", "assembled"), { recursive: true });
await mkdir(path.join(projectRoot, "app", "example", "prisma", "nested"), { recursive: true });

const { assembleModulePrisma } = await import(
  "../dist/platform/module-manager/install/prisma-assembly.service.js"
);

const manifest = {
  key: "app.example",
  kind: "app",
  name: "Example",
  version: "1.0.0",
  sourcePath: "app/example",
  prisma: { source: "prisma" },
};

test.after(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

test("Prisma assembly copies real package-contained sources", async () => {
  await writeFile(
    path.join(projectRoot, "app", "example", "prisma", "nested", "model.prisma"),
    "model Example { id String @id }\n",
  );
  const result = await assembleModulePrisma(manifest);
  assert.equal(result.files, 1);
  assert.match(
    await readFile(
      path.join(projectRoot, "backend", "prisma", "domains", "assembled", "app", "example", "nested", "model.prisma"),
      "utf8",
    ),
    /model Example/,
  );
});

test("Prisma assembly rejects a recursively discovered symlink before replacing the target", async () => {
  const outside = path.join(projectRoot, "outside.prisma");
  const link = path.join(projectRoot, "app", "example", "prisma", "nested", "outside.prisma");
  await writeFile(outside, "model Outside { id String @id }\n");
  await symlink(outside, link);

  await assert.rejects(
    assembleModulePrisma(manifest),
    /MODULE_PRISMA_SOURCE_SYMLINK_DENIED/,
  );
  await access(
    path.join(projectRoot, "backend", "prisma", "domains", "assembled", "app", "example", "nested", "model.prisma"),
  );
});

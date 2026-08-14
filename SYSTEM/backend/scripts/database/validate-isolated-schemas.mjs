import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildDomainPrismaSchema,
  dataDomains,
  listActiveDataDomains,
} from "./domain-prisma-schema.mjs";

const projectRoot = process.cwd();
const prismaCli = path.resolve(projectRoot, "node_modules", "prisma", "build", "index.js");
const validationUrl = "postgresql://schema_validation:schema_validation@127.0.0.1:5432/schema_validation";

function validateSchema(schemaFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [prismaCli, "validate", "--schema", schemaFile], {
      cwd: projectRoot,
      env: { ...process.env, DATABASE_URL: validationUrl },
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ISOLATED_SCHEMA_VALIDATION_FAILED:${path.basename(schemaFile)}:${code}`));
    });
  });
}

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-schema-validation-"));

try {
  const activeDomains = await listActiveDataDomains(projectRoot);
  const skippedDomains = dataDomains.filter((domain) => !activeDomains.includes(domain));
  for (const domain of skippedDomains) {
    console.info(`[schema-validation] ${domain}: nicht installiertes optionales Modul`);
  }
  for (const domain of activeDomains) {
    const schemaFile = path.join(temporaryRoot, `${domain}.prisma`);
    const schema = await buildDomainPrismaSchema(projectRoot, domain);
    await fs.writeFile(schemaFile, schema, "utf8");
    await validateSchema(schemaFile);
    console.info(`[schema-validation] ${domain}: OK`);
  }
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

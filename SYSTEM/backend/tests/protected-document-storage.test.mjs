import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("geschützte Dokumente werden verschlüsselt, gebunden und löschbar gespeichert", async () => {
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-protected-documents-"));
  const previousRoot = process.env.RUN_SYSTEM_ARCHIV_ROOT;
  const previousMasterKey = process.env.PERSONAL_DATA_MASTER_KEY;
  process.env.RUN_SYSTEM_ARCHIV_ROOT = archiveRoot;
  process.env.PERSONAL_DATA_MASTER_KEY = "bonni-protected-documents-test-master-key-2026";

  try {
    const storage = await import("../dist/core/protected-documents/protected-document-storage.js");
    const clearText = Buffer.from("vertrauliches-mitgliederdokument", "utf8");
    const stored = await storage.storeProtectedDocument({
      domain: "people",
      subjectId: "person-test-1",
      bytes: clearText,
    });

    assert.match(stored.objectKey, /^pd_[A-Za-z0-9_-]{32}\.arc$/u);
    assert.equal(stored.sizeInBytes, clearText.length);

    const entries = await fs.readdir(archiveRoot, { recursive: true, withFileTypes: true });
    const archiveEntry = entries.find((entry) => entry.isFile() && entry.name === stored.objectKey);
    assert.ok(archiveEntry, "Die verschlüsselte Archivdatei fehlt.");
    const archivePath = path.join(archiveEntry.parentPath, archiveEntry.name);
    const encryptedAtRest = await fs.readFile(archivePath, "utf8");
    assert.equal(encryptedAtRest.includes(clearText.toString("utf8")), false);
    assert.equal(archivePath.includes("person-test-1"), false);

    const restored = await storage.readProtectedDocument({
      domain: "people",
      subjectId: "person-test-1",
      objectKey: stored.objectKey,
    });
    assert.deepEqual(restored, clearText);

    await assert.rejects(
      storage.readProtectedDocument({
        domain: "people",
        subjectId: "person-test-2",
        objectKey: stored.objectKey,
      }),
      (error) => error?.code === "PROTECTED_DOCUMENT_CONTENT_NOT_FOUND",
    );

    await storage.deleteProtectedDocument({
      domain: "people",
      subjectId: "person-test-1",
      objectKey: stored.objectKey,
    });
    await assert.rejects(
      storage.readProtectedDocument({
        domain: "people",
        subjectId: "person-test-1",
        objectKey: stored.objectKey,
      }),
      (error) => error?.code === "PROTECTED_DOCUMENT_CONTENT_NOT_FOUND",
    );
  } finally {
    if (previousRoot === undefined) delete process.env.RUN_SYSTEM_ARCHIV_ROOT;
    else process.env.RUN_SYSTEM_ARCHIV_ROOT = previousRoot;
    if (previousMasterKey === undefined) delete process.env.PERSONAL_DATA_MASTER_KEY;
    else process.env.PERSONAL_DATA_MASTER_KEY = previousMasterKey;
    await fs.rm(archiveRoot, { recursive: true, force: true });
  }
});

test("geschützte Organisationsdokumente liegen zentral und nicht im Modulbaum", async () => {
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-protected-organization-documents-"));
  const previousRoot = process.env.RUN_SYSTEM_ARCHIV_ROOT;
  const previousMasterKey = process.env.PERSONAL_DATA_MASTER_KEY;
  process.env.RUN_SYSTEM_ARCHIV_ROOT = archiveRoot;
  process.env.PERSONAL_DATA_MASTER_KEY = "bonni-protected-organization-test-master-key-2026";

  try {
    const storage = await import("../dist/core/protected-documents/protected-document-storage.js");
    const clearText = Buffer.from("central-year-file", "utf8");
    const stored = await storage.storeProtectedDocument({
      domain: "organization",
      subjectId: "organization-test-1",
      bytes: clearText,
    });
    const entries = await fs.readdir(archiveRoot, { recursive: true, withFileTypes: true });
    const archiveEntry = entries.find((entry) => entry.isFile() && entry.name === stored.objectKey);
    assert.ok(archiveEntry);
    const archivePath = path.join(archiveEntry.parentPath, archiveEntry.name);
    assert.equal(archivePath.includes("organization-test-1"), false);
    assert.equal(archivePath.includes(`${path.sep}app${path.sep}kontorapp${path.sep}`), false);
    assert.equal((await fs.readFile(archivePath, "utf8")).includes(clearText.toString("utf8")), false);
    assert.deepEqual(await storage.readProtectedDocument({
      domain: "organization",
      subjectId: "organization-test-1",
      objectKey: stored.objectKey,
    }), clearText);
  } finally {
    if (previousRoot === undefined) delete process.env.RUN_SYSTEM_ARCHIV_ROOT;
    else process.env.RUN_SYSTEM_ARCHIV_ROOT = previousRoot;
    if (previousMasterKey === undefined) delete process.env.PERSONAL_DATA_MASTER_KEY;
    else process.env.PERSONAL_DATA_MASTER_KEY = previousMasterKey;
    await fs.rm(archiveRoot, { recursive: true, force: true });
  }
});

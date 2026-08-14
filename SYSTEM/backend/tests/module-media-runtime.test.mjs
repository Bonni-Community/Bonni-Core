import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

import {
  createModuleMediaRuntime,
  createModuleMediaStore,
  MODULE_MEDIA_CONTRACT_VERSION,
} from "../dist/core/media/module-media-runtime.js";
import { createMediaFilesRouter } from "../dist/core/media/media.routes.js";

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("bonni-media-test", "utf8"),
]);
const PDF_BYTES = Buffer.from("%PDF-1.7\n% Bonni media test\n", "utf8");

async function temporaryStore(t, options = {}) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-module-media-"));
  t.after(() => fs.rm(storageRoot, { recursive: true, force: true }));
  return {
    storageRoot,
    store: createModuleMediaStore({
      storageRoot,
      publicBasePath: "/api/media/files",
      maxUploadBytes: 1024,
      ...options,
    }),
  };
}

function imageInput(overrides = {}) {
  return {
    kind: "image",
    fileName: "Getränkefoto.png",
    mimeType: "image/png",
    dataBase64: PNG_BYTES.toString("base64"),
    scope: "catalog-products",
    metadata: {
      targetId: "product-1",
      nested: { source: "module-test" },
    },
    ...overrides,
  };
}

function auditRecorder() {
  const calls = [];
  return {
    calls,
    client: {
      auditLog: {
        async create(arguments_) {
          calls.push(arguments_);
          return { id: "audit-1" };
        },
      },
    },
  };
}

async function withServer(app, callback) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("module-bound media runtime stores an immutable object and writes a Core audit record", async (t) => {
  const { storageRoot, store } = await temporaryStore(t);
  const audit = auditRecorder();
  const mediaRuntime = createModuleMediaRuntime("app.example", audit.client, store);

  const created = await mediaRuntime.createMedia(imageInput({
    metadata: {
      moduleKey: "app.spoofed",
      targetId: "product-1",
    },
  }));

  assert.equal(MODULE_MEDIA_CONTRACT_VERSION, "bonni.media/v1");
  assert.equal(mediaRuntime.contractVersion, MODULE_MEDIA_CONTRACT_VERSION);
  assert.equal(mediaRuntime.moduleKey, "app.example");
  assert.match(created.id, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{32}$/);
  assert.equal(created.moduleKey, "app.example");
  assert.equal(created.url, `/api/media/files/${created.id}`);
  assert.equal(created.originalFileName, "Getränkefoto.png");
  assert.equal(created.mimeType, "image/png");
  assert.equal(created.sizeBytes, PNG_BYTES.length);
  assert.match(created.sha256, /^[a-f0-9]{64}$/);
  assert.equal("relativePath" in created, false, "module results must not expose Core storage paths");
  assert.equal("storedFileName" in created, false, "module results must not expose Core filenames");

  const stored = await store.read(created.id);
  assert.deepEqual(stored.bytes, PNG_BYTES);
  assert.deepEqual(stored.metadata, {
    moduleKey: "app.spoofed",
    targetId: "product-1",
  });
  assert.equal(stored.moduleKey, "app.example", "caller metadata cannot change ownership");

  assert.equal(audit.calls.length, 1);
  assert.deepEqual(audit.calls[0].data, {
    category: "DATA",
    event: "MODULE_MEDIA_CREATED",
    result: "SUCCESS",
    targetType: "ModuleMedia",
    targetId: created.id,
    severity: "INFO",
    metadataJson: {
      moduleKey: "app.example",
      kind: "image",
      scope: "catalog-products",
      mimeType: "image/png",
      sizeBytes: PNG_BYTES.length,
      sha256: created.sha256,
    },
  });

  if (process.platform !== "win32") {
    const [encodedModuleKey, objectToken] = created.id.split(".");
    const contentPath = path.join(
      storageRoot,
      "modules",
      encodedModuleKey,
      "objects",
      objectToken,
      "content.png",
    );
    const objectDirectory = path.dirname(contentPath);
    assert.equal((await fs.stat(contentPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(objectDirectory)).mode & 0o777, 0o700);
  }
});

test("media validation rejects traversal, malformed data, active image content and oversized uploads", async (t) => {
  const { store } = await temporaryStore(t, { maxUploadBytes: 8 });
  const runtime = createModuleMediaRuntime("app.example", auditRecorder().client, store);

  await assert.rejects(
    runtime.createMedia(imageInput({ fileName: "../outside.png" })),
    (error) => error?.code === "CORE_MEDIA_FILE_NAME_INVALID" && error?.statusCode === 400,
  );
  await assert.rejects(
    runtime.createMedia(imageInput({ dataBase64: "not base64" })),
    (error) => error?.code === "CORE_MEDIA_BASE64_INVALID" && error?.statusCode === 400,
  );
  await assert.rejects(
    runtime.createMedia(imageInput({
      mimeType: "image/png",
      dataBase64: Buffer.from("not a png").toString("base64"),
    })),
    (error) => error?.code === "CORE_MEDIA_TOO_LARGE" && error?.statusCode === 413,
  );
  await assert.rejects(
    runtime.createMedia(imageInput({
      mimeType: "image/svg+xml",
      dataBase64: Buffer.from("<svg/>").toString("base64"),
    })),
    (error) => error?.code === "CORE_MEDIA_ACTIVE_CONTENT_NOT_ALLOWED" && error?.statusCode === 415,
  );
  await assert.rejects(
    runtime.createMedia({
      kind: "binary",
      fileName: "payload.bin",
      mimeType: "application/octet-stream",
      dataBase64: Buffer.alloc(9, 1).toString("base64"),
    }),
    (error) => error?.code === "CORE_MEDIA_TOO_LARGE" && error?.statusCode === 413,
  );

  const cyclic = {};
  cyclic.self = cyclic;
  await assert.rejects(
    runtime.createMedia(imageInput({ metadata: cyclic })),
    (error) => error?.code === "CORE_MEDIA_METADATA_INVALID" && error?.statusCode === 400,
  );
});

test("MIME signature mismatch is rejected independently from the upload limit", async (t) => {
  const { store } = await temporaryStore(t);
  const runtime = createModuleMediaRuntime("app.example", auditRecorder().client, store);

  await assert.rejects(
    runtime.createMedia(imageInput({
      dataBase64: Buffer.from("this is not a png").toString("base64"),
    })),
    (error) => error?.code === "CORE_MEDIA_CONTENT_TYPE_MISMATCH" && error?.statusCode === 415,
  );
});

test("failed Core audit rolls the newly written media object back", async (t) => {
  const { storageRoot, store } = await temporaryStore(t);
  const runtime = createModuleMediaRuntime("app.example", {
    auditLog: {
      async create() {
        throw new Error("database audit unavailable");
      },
    },
  }, store);

  await assert.rejects(
    runtime.createMedia(imageInput()),
    (error) => error?.code === "CORE_MEDIA_AUDIT_FAILED" && error?.statusCode === 503,
  );

  const encodedModuleKey = Buffer.from("app.example", "utf8").toString("base64url");
  const objectsDirectory = path.join(storageRoot, "modules", encodedModuleKey, "objects");
  assert.deepEqual(await fs.readdir(objectsDirectory), []);
});

test("only the bound owner module may remove an object", async (t) => {
  const { store } = await temporaryStore(t);
  const created = await createModuleMediaRuntime(
    "app.example",
    auditRecorder().client,
    store,
  ).createMedia(imageInput());

  await assert.rejects(
    store.remove(created.id, "app.other"),
    (error) => error?.code === "CORE_MEDIA_MODULE_OWNERSHIP_MISMATCH"
      && error?.statusCode === 403,
  );
  assert.deepEqual((await store.read(created.id)).bytes, PNG_BYTES);
});

test("Core media route serves verified bytes with immutable safety headers", async (t) => {
  const { store } = await temporaryStore(t);
  const created = await createModuleMediaRuntime(
    "app.example",
    auditRecorder().client,
    store,
  ).createMedia(imageInput());

  const app = express();
  app.use("/api/media/files", createMediaFilesRouter(store));
  app.use((error, _request, response, _next) => {
    response.status(error?.statusCode || 500).json({ error: error?.code || "INTERNAL" });
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}${created.url}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.match(response.headers.get("content-disposition") || "", /^inline;/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "cross-origin");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG_BYTES);

    const etag = response.headers.get("etag");
    assert.ok(etag);
    const cached = await fetch(`${baseUrl}${created.url}`, {
      headers: { "If-None-Match": etag },
    });
    assert.equal(cached.status, 304);

    const unknown = await fetch(`${baseUrl}/api/media/files/not-a-media-id`);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: "CORE_MEDIA_NOT_FOUND" });
  });
});

test("protected media requires a verified identity with owner-module access or Core ADMIN", async (t) => {
  const { store } = await temporaryStore(t);
  const created = await createModuleMediaRuntime(
    "app.example",
    auditRecorder().client,
    store,
  ).createMedia({
    kind: "document",
    fileName: "abrechnung.pdf",
    mimeType: "application/pdf",
    dataBase64: PDF_BYTES.toString("base64"),
  });

  const app = express();
  app.use((request, _response, next) => {
    if (request.headers.authorization === "Bearer same-module-token") {
      request.bonniIdentityVerified = true;
      request.user = {
        accountId: "account-same",
        type: "MEMBER",
        allowedApps: ["app.example"],
      };
    } else if (request.headers.authorization === "Bearer foreign-module-token") {
      request.bonniIdentityVerified = true;
      request.user = {
        accountId: "account-foreign",
        type: "MEMBER",
        allowedApps: ["app.other"],
      };
    } else if (request.headers.authorization === "Bearer admin-token") {
      request.bonniIdentityVerified = true;
      request.user = {
        accountId: "account-admin",
        type: "ADMIN",
        allowedApps: [],
      };
    } else if (request.headers.authorization === "Bearer spoofed-test-token") {
      request.user = {
        accountId: "account-spoofed",
        type: "ADMIN",
        allowedApps: ["app.example"],
      };
    }
    next();
  });
  app.use("/api/media/files", createMediaFilesRouter(store));
  app.use((error, _request, response, _next) => {
    response.status(error?.statusCode || 500).json({ error: error?.code || "INTERNAL" });
  });

  await withServer(app, async (baseUrl) => {
    const anonymous = await fetch(`${baseUrl}${created.url}`);
    assert.equal(anonymous.status, 401);
    assert.deepEqual(await anonymous.json(), { error: "CORE_MEDIA_AUTH_REQUIRED" });

    const spoofed = await fetch(`${baseUrl}${created.url}`, {
      headers: { Authorization: "Bearer spoofed-test-token" },
    });
    assert.equal(spoofed.status, 401, "an unverified request.user is not sufficient");
    assert.deepEqual(await spoofed.json(), { error: "CORE_MEDIA_AUTH_REQUIRED" });

    const foreign = await fetch(`${baseUrl}${created.url}`, {
      headers: { Authorization: "Bearer foreign-module-token" },
    });
    assert.equal(foreign.status, 403);
    assert.deepEqual(await foreign.json(), { error: "CORE_MEDIA_MODULE_ACCESS_FORBIDDEN" });

    for (const token of ["same-module-token", "admin-token"]) {
      const authorized = await fetch(`${baseUrl}${created.url}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(authorized.status, 200);
      assert.equal(authorized.headers.get("content-type"), "application/pdf");
      assert.match(authorized.headers.get("content-disposition") || "", /^attachment;/);
      assert.deepEqual(Buffer.from(await authorized.arrayBuffer()), PDF_BYTES);
    }
  });
});

test("module runtime exposes media only to manifests declaring core.media", async () => {
  const loader = await fs.readFile(
    new URL("../dist/platform/module-manager/loader/module-runtime.service.js", import.meta.url),
    "utf8",
  );

  assert.match(loader, /declaredDependencies\.has\("core\.media"\)/);
  assert.match(loader, /\{\s*media:\s*createModuleMediaRuntime\(module\.key,\s*corePrisma\)\s*\}/);
});

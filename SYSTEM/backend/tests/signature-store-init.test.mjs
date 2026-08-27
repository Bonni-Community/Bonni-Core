import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { initializeSignatureStore } from "../scripts/signature-release/initialize-signature-store.mjs";

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-signature-init-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("initialisiert getrennte Ed25519-Schluessel fuer Root, Core und Apps", async (t) => {
  const root = await temporaryRoot(t);
  const signatureRoot = path.join(root, "SIGNATUR");
  const result = await initializeSignatureStore({
    signatureRoot,
    targets: ["root", "core", "kontor", "stueberl", "hocket"],
  });
  assert.equal(result.created.length, 5);
  assert.equal(new Set(result.created.map((entry) => entry.keyId)).size, 5);
  assert.equal(new Set(result.created.map((entry) => entry.keyScope)).size, 5);

  for (const entry of result.created) {
    const directory = entry.target === "root" || entry.target === "core"
      ? entry.target
      : `apps/${entry.target}`;
    const privatePem = await fs.readFile(path.join(signatureRoot, directory, "keys/release-private.pem"), "utf8");
    const publicPem = await fs.readFile(path.join(signatureRoot, directory, "keys/release-public.pem"), "utf8");
    const privateKey = crypto.createPrivateKey(privatePem);
    const publicKey = crypto.createPublicKey(publicPem);
    assert.equal(privateKey.asymmetricKeyType, "ed25519");
    assert.equal(publicKey.asymmetricKeyType, "ed25519");
    assert.equal(
      crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" }),
      publicKey.export({ type: "spki", format: "pem" }),
    );
  }
});

test("ueberschreibt niemals einen vorhandenen Schluesselbereich", async (t) => {
  const root = await temporaryRoot(t);
  const signatureRoot = path.join(root, "SIGNATUR");
  await initializeSignatureStore({ signatureRoot, targets: ["core"] });
  await assert.rejects(
    initializeSignatureStore({ signatureRoot, targets: ["core"] }),
    /SIGNATURE_SCOPE_ALREADY_EXISTS:core/u,
  );
});

test("weist einen verlinkten Scope vor dem Schreiben ab", { skip: process.platform === "win32" }, async (t) => {
  const root = await temporaryRoot(t);
  const signatureRoot = path.join(root, "SIGNATUR");
  const outside = path.join(root, "outside");
  await fs.mkdir(signatureRoot, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.symlink(outside, path.join(signatureRoot, "core"));
  await assert.rejects(
    initializeSignatureStore({ signatureRoot, targets: ["core"] }),
    /SIGNATURE_SCOPE_LINK_FORBIDDEN/u,
  );
  assert.deepEqual(await fs.readdir(outside), []);
});


import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { MatrixManager, atomicJson } from "./manager.mjs";
import { PROTOCOL, responseSignature, verifyCommand, fail } from "./protocol.mjs";

export async function createManagerServer(root, { manager, now = Date.now } = {}) {
  const instance = manager || await new MatrixManager(root).initialize();
  const nonceFile = path.join(root, "nonces.json");
  let nonces;
  try { nonces = new Map(JSON.parse(await readFile(nonceFile, "utf8"))); } catch (error) { if (error.code !== "ENOENT") throw error; nonces = new Map(); }
  let authorization = Promise.resolve();
  const server = http.createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store"); response.setHeader("Content-Type", "application/json");
    if (request.method !== "POST" || request.url !== "/v1/command") { response.writeHead(404); response.end('{"error":"NOT_FOUND"}'); return; }
    let raw = "", secret = "", command, requestId = "";
    try {
      if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] || "") || request.headers["content-encoding"]
        || Number(request.headers["content-length"] || 0) > 32_768) throw fail("INPUT_INVALID");
      let size = 0; const chunks = [];
      for await (const chunk of request) { size += chunk.length; if (size > 32_768) throw fail("REQUEST_TOO_LARGE", 413); chunks.push(chunk); }
      raw = Buffer.concat(chunks).toString("utf8");
      secret = (await readFile(path.join(root, "control.key"), "utf8")).trim();
      if (!/^[A-Za-z0-9_-]{43,128}$/.test(secret)) throw fail("SECRET_INVALID", 503);
      const checked = authorization.then(async () => {
        const result = verifyCommand(raw, request.headers["x-bonni-signature"], secret, instance.installation.installationId, nonces, now());
        // Persist replay protection before accepting an operation, including
        // across an independent manager restart.
        await atomicJson(nonceFile, [...nonces]); return result;
      });
      authorization = checked.catch(() => {});
      command = await checked; requestId = command.requestId;
      const result = await instance.command(command.action, command.payload, requestId);
      const body = JSON.stringify({ protocol: PROTOCOL, installationId: instance.installation.installationId, requestId, result });
      response.setHeader("X-Bonni-Signature", responseSignature(secret, requestId, 200, body)); response.writeHead(200); response.end(body);
    } catch (error) {
      const status = Number(error.statusCode) || 500;
      const body = JSON.stringify({ protocol: PROTOCOL, installationId: instance.installation.installationId, requestId,
        error: /^[A-Z_]{2,80}$/.test(error.message) ? error.message : "OPERATION_FAILED" });
      if (secret && requestId) response.setHeader("X-Bonni-Signature", responseSignature(secret, requestId, status, body));
      response.writeHead(status); response.end(body);
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 8000;
  server.maxConnections = 32;
  return { server, manager: instance };
}

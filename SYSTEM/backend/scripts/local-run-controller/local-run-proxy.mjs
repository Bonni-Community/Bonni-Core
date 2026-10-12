import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";

import {
  LocalRunControllerError,
  commitActiveTarget,
  recoverActiveTarget,
} from "./controller-state.mjs";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function jsonResponse(response, statusCode, value, headers = {}) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    ...headers,
  });
  response.end(body);
}

const LOCAL_START_PROOF_PATH = "/__bonni/local-start-proof";
const LOCAL_START_PROOF_SCHEMA = "bonni.local-start-proof/v1";
const LOCAL_START_PROOF_TOKEN = /^[A-Za-z0-9_-]{32,128}$/u;
const LOCAL_START_PROOF_NONCE = /^[a-f0-9]{64}$/u;

function validProcessId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function localStartProofMessage({
  nonce,
  ownerPid,
  childPid,
  backendPid,
  backendStartedAt,
  supervisorInstanceId,
  publicPort,
  generation,
  targetSlotId,
  targetHost,
  targetPort,
  targetReceiptSha256,
}) {
  return [
    LOCAL_START_PROOF_SCHEMA,
    nonce,
    String(ownerPid),
    String(childPid),
    String(backendPid),
    String(backendStartedAt),
    String(supervisorInstanceId),
    String(publicPort),
    String(generation),
    String(targetSlotId),
    String(targetHost),
    String(targetPort),
    String(targetReceiptSha256),
  ].join("\n");
}

function removeHopByHopHeaders(headers) {
  const result = { ...headers };
  for (const name of [
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
  ]) delete result[name];
  return result;
}

function validatedPublicHost(request, publicHost, publicPort) {
  const raw = String(request.headers.host || `${publicHost}:${publicPort}`).trim();
  if (!raw || /[\u0000-\u0020\\/@?#]/u.test(raw)) {
    throw new LocalRunControllerError("LOCAL_RUN_CONTROLLER_PUBLIC_HOST_INVALID");
  }
  let parsed;
  try {
    parsed = new URL(`http://${raw}`);
  } catch {
    throw new LocalRunControllerError("LOCAL_RUN_CONTROLLER_PUBLIC_HOST_INVALID");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  const allowedHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  const parsedPort = Number(parsed.port || 80);
  if (!allowedHosts.has(hostname) || parsedPort !== Number(publicPort)
      || parsed.pathname !== "/" || parsed.username || parsed.password) {
    throw new LocalRunControllerError("LOCAL_RUN_CONTROLLER_PUBLIC_HOST_MISMATCH", raw);
  }
  return raw;
}

function forwardedHeaders(request, publicAuthority) {
  const headers = { ...request.headers };
  headers.host = publicAuthority;
  headers["x-forwarded-host"] = publicAuthority;
  headers["x-forwarded-proto"] = "http";
  headers["x-forwarded-for"] = String(request.socket?.remoteAddress || "127.0.0.1");
  headers["x-forwarded-port"] = publicAuthority.startsWith("[")
    ? publicAuthority.slice(publicAuthority.lastIndexOf(":") + 1)
    : publicAuthority.split(":").at(-1);
  return headers;
}

function upgradeHead(request, publicAuthority) {
  const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
  for (const [name, rawValue] of Object.entries(forwardedHeaders(request, publicAuthority))) {
    if (rawValue === undefined) continue;
    for (const value of Array.isArray(rawValue) ? rawValue : [rawValue]) {
      lines.push(`${name}: ${value}`);
    }
  }
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1");
}

export class LocalRunProxyController {
  constructor(options = {}) {
    this.stateRoot = options.stateRoot;
    this.publicHost = String(options.publicHost || "127.0.0.1");
    this.publicPort = Number(options.publicPort || 4000);
    this.bootstrapTarget = options.bootstrapTarget || {
      host: "127.0.0.1",
      port: Number(options.activeInternalPort || 4100),
      slotRole: "active",
      slotId: "bootstrap-active",
      receiptSha256: null,
    };
    this.localStartProofToken = String(options.localStartProofToken || "");
    this.localStartProofOwnerPid = Number(options.localStartProofOwnerPid || 0);
    this.localStartProofRuntime = options.localStartProofRuntime;
    const proofPartiallyConfigured = Boolean(this.localStartProofToken)
      || this.localStartProofOwnerPid !== 0;
    if (proofPartiallyConfigured
      && (!LOCAL_START_PROOF_TOKEN.test(this.localStartProofToken)
        || !validProcessId(this.localStartProofOwnerPid)
        || typeof this.localStartProofRuntime !== "function")) {
      throw new LocalRunControllerError("LOCAL_RUN_CONTROLLER_START_PROOF_INVALID");
    }
    this.mode = "starting";
    this.phase = null;
    this.retryAfterSeconds = 3;
    this.targetReceipt = null;
    this.server = null;
    this.agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
    this.inflight = new Set();
    this.tunnels = new Set();
  }

  status() {
    return {
      schemaVersion: 1,
      service: "bonni-local-run-controller",
      mode: this.mode,
      phase: this.phase,
      generation: this.targetReceipt?.generation || null,
      targetSlotId: this.targetReceipt?.target?.slotId || null,
      inflightRequests: this.inflight.size,
      websocketTunnels: this.tunnels.size,
    };
  }

  async start() {
    if (this.server) throw new LocalRunControllerError("LOCAL_RUN_CONTROLLER_ALREADY_STARTED");
    const recovered = await recoverActiveTarget({
      stateRoot: this.stateRoot,
      bootstrapTarget: this.bootstrapTarget,
      publicHost: this.publicHost,
      publicPort: this.publicPort,
    });
    this.targetReceipt = recovered.receipt;
    this.publicHost = recovered.receipt.public.host;
    this.publicPort = recovered.receipt.public.port;
    this.server = http.createServer((request, response) => this.#handleRequest(request, response));
    this.server.on("upgrade", (request, socket, head) => this.#handleUpgrade(request, socket, head));
    this.server.on("clientError", (_error, socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(this.publicPort, this.publicHost, () => {
        this.server.off("error", onError);
        resolve();
      });
    });
    const address = this.server.address();
    if (address && typeof address === "object") this.publicPort = address.port;
    this.mode = "active";
    return { ...this.status(), recoveredFrom: recovered.source, publicHost: this.publicHost, publicPort: this.publicPort };
  }

  #handleRequest(request, response) {
    if (request.url === "/__bonni/local-run-controller/status") {
      jsonResponse(response, this.mode === "active" ? 200 : 503, this.status(),
        this.mode === "active" ? {} : { "retry-after": String(this.retryAfterSeconds) });
      return;
    }
    if (String(request.url || "").startsWith(LOCAL_START_PROOF_PATH)) {
      this.#handleLocalStartProof(request, response);
      return;
    }
    if (this.mode !== "active") {
      jsonResponse(response, 503, {
        code: "BONNI_CORE_UPDATE_CUTOVER",
        message: "Bonni Core wechselt sicher auf die vorbereitete Version.",
        phase: this.phase,
      }, { "retry-after": String(this.retryAfterSeconds) });
      return;
    }

    const receipt = this.targetReceipt;
    const target = receipt.target;
    let publicAuthority;
    try {
      publicAuthority = validatedPublicHost(request, this.publicHost, this.publicPort);
    } catch (error) {
      jsonResponse(response, 400, { code: error.code || "LOCAL_RUN_CONTROLLER_PUBLIC_HOST_INVALID" });
      return;
    }
    const proxyHeaders = removeHopByHopHeaders(forwardedHeaders(request, publicAuthority));
    proxyHeaders["x-bonni-proxy-generation"] = String(receipt.generation);
    const upstream = http.request({
      host: target.host,
      port: target.port,
      method: request.method,
      path: request.url,
      headers: proxyHeaders,
      agent: this.agent,
    });
    this.inflight.add(upstream);
    const finish = () => this.inflight.delete(upstream);
    upstream.once("close", finish);
    upstream.once("error", (error) => {
      finish();
      if (!response.headersSent) {
        jsonResponse(response, 502, { code: "BONNI_ACTIVE_BACKEND_UNREACHABLE", detail: error.code || "proxy-error" });
      } else response.destroy(error);
    });
    upstream.once("response", (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, removeHopByHopHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(response);
    });
    request.once("aborted", () => upstream.destroy());
    request.pipe(upstream);
  }

  #handleLocalStartProof(request, response) {
    if (!this.localStartProofToken) {
      jsonResponse(response, 404, { code: "BONNI_LOCAL_START_PROOF_UNAVAILABLE" });
      return;
    }
    if (request.method !== "GET") {
      jsonResponse(response, 405, { code: "BONNI_LOCAL_START_PROOF_METHOD_INVALID" }, { allow: "GET" });
      return;
    }
    if (this.mode !== "active") {
      jsonResponse(response, 503, { code: "BONNI_LOCAL_START_PROOF_NOT_ACTIVE" }, {
        "retry-after": String(this.retryAfterSeconds),
      });
      return;
    }
    try {
      validatedPublicHost(request, this.publicHost, this.publicPort);
    } catch (error) {
      jsonResponse(response, 400, { code: error.code || "LOCAL_RUN_CONTROLLER_PUBLIC_HOST_INVALID" });
      return;
    }
    let parsed;
    try {
      if (String(request.url || "").length > 256) throw new Error("url-too-long");
      parsed = new URL(String(request.url || ""), `http://127.0.0.1:${this.publicPort}`);
    } catch {
      jsonResponse(response, 400, { code: "BONNI_LOCAL_START_PROOF_REQUEST_INVALID" });
      return;
    }
    const parameters = [...parsed.searchParams.keys()];
    const nonce = parsed.searchParams.get("nonce") || "";
    if (parsed.pathname !== LOCAL_START_PROOF_PATH
      || parameters.length !== 1 || parameters[0] !== "nonce"
      || !LOCAL_START_PROOF_NONCE.test(nonce)) {
      jsonResponse(response, 400, { code: "BONNI_LOCAL_START_PROOF_REQUEST_INVALID" });
      return;
    }
    const receipt = this.targetReceipt;
    const runtime = this.localStartProofRuntime();
    if (!runtime || !validProcessId(runtime.backendPid)
      || typeof runtime.backendStartedAt !== "string"
      || !Number.isFinite(Date.parse(runtime.backendStartedAt))
      || typeof runtime.supervisorInstanceId !== "string"
      || runtime.supervisorInstanceId.length < 1 || runtime.supervisorInstanceId.length > 256
      || /[\u0000-\u001f\u007f]/u.test(runtime.supervisorInstanceId)) {
      jsonResponse(response, 503, { code: "BONNI_LOCAL_START_PROOF_BACKEND_NOT_READY" }, {
        "retry-after": String(this.retryAfterSeconds),
      });
      return;
    }
    const proofPayload = {
      schemaVersion: LOCAL_START_PROOF_SCHEMA,
      service: "bonni-local-run-controller",
      nonce,
      ownerPid: this.localStartProofOwnerPid,
      childPid: process.pid,
      backendPid: runtime.backendPid,
      backendStartedAt: runtime.backendStartedAt,
      supervisorInstanceId: runtime.supervisorInstanceId,
      publicPort: this.publicPort,
      generation: receipt.generation,
      targetSlotId: receipt.target.slotId,
      targetHost: receipt.target.host,
      targetPort: receipt.target.port,
      targetReceiptSha256: receipt.target.receiptSha256,
    };
    const proof = crypto.createHmac("sha256", this.localStartProofToken)
      .update(localStartProofMessage(proofPayload))
      .digest("base64url");
    jsonResponse(response, 200, { ...proofPayload, proof });
  }

  #handleUpgrade(request, socket, head) {
    if (this.mode !== "active") {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 3\r\n\r\n");
      return;
    }
    const target = this.targetReceipt.target;
    let publicAuthority;
    try {
      publicAuthority = validatedPublicHost(request, this.publicHost, this.publicPort);
    } catch {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = net.connect({ host: target.host, port: target.port });
    const tunnel = { downstream: socket, upstream };
    this.tunnels.add(tunnel);
    const finish = () => this.tunnels.delete(tunnel);
    socket.once("close", finish);
    upstream.once("close", finish);
    upstream.once("error", () => socket.destroy());
    socket.once("error", () => upstream.destroy());
    upstream.once("connect", () => {
      upstream.write(upgradeHead(request, publicAuthority));
      if (head?.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
  }

  fence({ phase = "cutover", retryAfterSeconds = 3 } = {}) {
    if (this.mode !== "active") throw new LocalRunControllerError("LOCAL_RUN_CONTROLLER_NOT_ACTIVE");
    this.mode = "maintenance";
    this.phase = String(phase || "cutover").slice(0, 120);
    this.retryAfterSeconds = Math.max(1, Math.min(60, Number(retryAfterSeconds) || 3));
    return this.status();
  }

  async drain({
    timeoutMs = 15_000,
    force = false,
    forceTunnels = force,
    forceRequests = false,
  } = {}) {
    if (this.mode !== "maintenance") throw new LocalRunControllerError("LOCAL_RUN_CONTROLLER_NOT_FENCED");
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    while (this.inflight.size || this.tunnels.size) {
      if (Date.now() >= deadline) {
        const pendingBefore = { requests: this.inflight.size, tunnels: this.tunnels.size };
        if (forceTunnels) {
          for (const tunnel of this.tunnels) {
            tunnel.downstream.destroy();
            tunnel.upstream.destroy();
          }
          this.tunnels.clear();
        }
        // force=true is deliberately only a legacy alias for forceTunnels.
        // Accepted HTTP requests are destroyed solely by the separate,
        // explicit forceRequests option; Cutover/Rollback never needs it.
        if (forceRequests) {
          for (const request of this.inflight) request.destroy();
          this.inflight.clear();
        }
        const pending = { requests: this.inflight.size, tunnels: this.tunnels.size };
        return {
          drained: pending.requests === 0 && pending.tunnels === 0,
          timedOut: true,
          forced: forceTunnels || forceRequests,
          forcedTunnels: Boolean(forceTunnels && pendingBefore.tunnels),
          forcedRequests: Boolean(forceRequests && pendingBefore.requests),
          pending,
        };
      }
      await delay(25);
    }
    return {
      drained: true,
      timedOut: false,
      forced: false,
      forcedTunnels: false,
      forcedRequests: false,
      pending: { requests: 0, tunnels: 0 },
    };
  }

  async commitActiveTarget(target) {
    if (this.mode !== "maintenance") throw new LocalRunControllerError("LOCAL_RUN_CONTROLLER_NOT_FENCED");
    const receipt = await commitActiveTarget({
      stateRoot: this.stateRoot,
      publicHost: this.publicHost,
      publicPort: this.publicPort,
      expectedGeneration: this.targetReceipt.generation,
      target,
    });
    this.targetReceipt = receipt;
    this.agent.destroy();
    this.agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
    return receipt;
  }

  resume() {
    if (this.mode !== "maintenance") throw new LocalRunControllerError("LOCAL_RUN_CONTROLLER_NOT_FENCED");
    this.phase = null;
    this.mode = "active";
    return this.status();
  }

  async close() {
    if (!this.server) return;
    this.mode = "stopping";
    this.agent.destroy();
    for (const tunnel of this.tunnels) {
      tunnel.downstream.destroy();
      tunnel.upstream.destroy();
    }
    this.tunnels.clear();
    const server = this.server;
    this.server = null;
    const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeIdleConnections?.();
    if (typeof server.closeAllConnections !== "function") {
      throw new LocalRunControllerError("LOCAL_RUN_CONTROLLER_FORCE_CLOSE_UNAVAILABLE");
    }
    server.closeAllConnections();
    await closed;
    this.mode = "stopped";
  }
}

export async function startLocalRunProxy(options = {}) {
  const controller = new LocalRunProxyController(options);
  await controller.start();
  return controller;
}

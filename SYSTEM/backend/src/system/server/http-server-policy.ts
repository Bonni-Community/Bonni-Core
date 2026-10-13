import type { Server } from "node:http";

export function applyHttpServerPolicy(server: Server): Server {
  server.headersTimeout = 15_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.maxRequestsPerSocket = 1000;
  return server;
}

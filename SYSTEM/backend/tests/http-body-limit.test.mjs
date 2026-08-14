import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import express from "express";

process.env.MASTER_KEY ||= "bonni-http-limit-test-master-key-1234567890";
process.env.DATABASE_URL ||= "postgresql://postgres:test@127.0.0.1:5432/bonni_http_limit_test";

const {
  resolveExpressJsonLimit,
  resolveExpressTrustProxyHops,
} = await import("../dist/system/routes/create-system-app.js");

test("JSON body limit is explicit, bounded and rejects invalid values", () => {
  assert.equal(resolveExpressJsonLimit(undefined), "50mb");
  assert.equal(resolveExpressJsonLimit("512KB"), "512kb");
  assert.equal(resolveExpressJsonLimit("1048576"), "1048576b");
  assert.throws(() => resolveExpressJsonLimit("unlimited"), /EXPRESS_JSON_LIMIT_INVALID/);
  assert.throws(() => resolveExpressJsonLimit("0"), /EXPRESS_JSON_LIMIT_INVALID/);
  assert.throws(() => resolveExpressJsonLimit("51mb"), /EXPRESS_JSON_LIMIT_INVALID/);
});

function requestIp(trustedProxyHops, forwardedFor) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.set("trust proxy", trustedProxyHops === 0 ? false : trustedProxyHops);
    app.get("/", (req, res) => res.json({ ip: req.ip, ips: req.ips }));
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const request = http.request({
        hostname: "127.0.0.1",
        port: address.port,
        path: "/",
        headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          server.close();
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(error);
          }
        });
      });
      request.on("error", (error) => {
        server.close();
        reject(error);
      });
      request.end();
    });
    server.on("error", reject);
  });
}

test("proxy hop count defaults closed and accepts only a small explicit integer", () => {
  assert.equal(resolveExpressTrustProxyHops(undefined), 0);
  assert.equal(resolveExpressTrustProxyHops("0"), 0);
  assert.equal(resolveExpressTrustProxyHops("1"), 1);
  assert.equal(resolveExpressTrustProxyHops("8"), 8);
  for (const invalid of ["", "-1", "1.5", "9", "true", "loopback", "1,2"]) {
    assert.throws(
      () => resolveExpressTrustProxyHops(invalid),
      /EXPRESS_TRUST_PROXY_HOPS_INVALID/,
    );
  }
});

test("one trusted runtime proxy separates clients and ignores a spoofed left prefix", async () => {
  const untrusted = await requestIp(0, "198.51.100.200");
  assert.notEqual(untrusted.ip, "198.51.100.200");

  const first = await requestIp(1, "198.51.100.200, 203.0.113.10");
  const second = await requestIp(1, "198.51.100.200, 203.0.113.11");
  assert.equal(first.ip, "203.0.113.10");
  assert.equal(second.ip, "203.0.113.11");
  assert.notEqual(first.ip, second.ip);
  assert.equal(first.ips.includes("198.51.100.200"), false);
});

test("closed Runtime Compose explicitly enables exactly its nginx hop", async () => {
  const compose = await fs.readFile(new URL("../docker-compose.runtime.yml", import.meta.url), "utf8");
  assert.match(compose, /EXPRESS_TRUST_PROXY_HOPS:\s*"1"/);
});

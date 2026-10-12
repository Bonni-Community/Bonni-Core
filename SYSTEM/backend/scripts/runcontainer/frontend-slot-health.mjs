import crypto from "node:crypto";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_HTML_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_ASSET_LIMIT_BYTES = 16 * 1024 * 1024;
const MAXIMUM_BODY_LIMIT_BYTES = 64 * 1024 * 1024;
const MAXIMUM_MARKER_BYTES = 16 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export class FrontendSlotHealthError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}:${detail}` : code);
    this.name = "FrontendSlotHealthError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "") {
  throw new FrontendSlotHealthError(code, detail);
}

function safeErrorMessage(error) {
  return String(error?.message || error || "unknown").replace(/[\r\n\u0000]+/gu, " ").slice(0, 512);
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  if (normalized === "[::1]" || normalized === "::1") return true;
  const parts = normalized.split(".");
  return parts.length === 4
    && parts[0] === "127"
    && parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
}

function exactLoopbackRootUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    fail("FRONTEND_SLOT_HEALTH_BASE_URL_INVALID");
  }
  if (
    parsed.protocol !== "http:"
    || !isLoopbackHostname(parsed.hostname)
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    fail("FRONTEND_SLOT_HEALTH_BASE_URL_NOT_LOOPBACK_ROOT", parsed.origin || "invalid");
  }
  return parsed;
}

function positiveInteger(value, fallback, label, maximum) {
  const parsed = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    fail("FRONTEND_SLOT_HEALTH_OPTION_INVALID", label);
  }
  return parsed;
}

function optionalSha256(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) fail("FRONTEND_SLOT_HEALTH_OPTION_INVALID", label);
  return normalized;
}

function optionalMarker(value, label) {
  if (value === undefined || value === null) return null;
  const marker = String(value);
  if (!marker || Buffer.byteLength(marker, "utf8") > MAXIMUM_MARKER_BYTES) {
    fail("FRONTEND_SLOT_HEALTH_OPTION_INVALID", label);
  }
  return marker;
}

function contentType(response) {
  return String(response?.headers?.get?.("content-type") || "").trim().toLowerCase();
}

async function readBoundedBody(response, maximumBytes, label) {
  const lengthHeader = String(response?.headers?.get?.("content-length") || "").trim();
  if (/^\d+$/u.test(lengthHeader) && Number(lengthHeader) > maximumBytes) {
    fail("FRONTEND_SLOT_HEALTH_BODY_TOO_LARGE", label);
  }
  if (response?.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value || []);
        bytes += chunk.length;
        if (bytes > maximumBytes) {
          await reader.cancel().catch(() => undefined);
          fail("FRONTEND_SLOT_HEALTH_BODY_TOO_LARGE", label);
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, bytes);
  }
  if (typeof response?.arrayBuffer !== "function") {
    fail("FRONTEND_SLOT_HEALTH_RESPONSE_INVALID", label);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > maximumBytes) fail("FRONTEND_SLOT_HEALTH_BODY_TOO_LARGE", label);
  return body;
}

async function fetchBoundedResource(fetchImpl, url, { timeoutMs, maximumBytes, accept, label }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    let response;
    try {
      response = await fetchImpl(url.href, {
        method: "GET",
        headers: { accept },
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) fail("FRONTEND_SLOT_HEALTH_REQUEST_TIMEOUT", label);
      fail("FRONTEND_SLOT_HEALTH_REQUEST_FAILED", `${label}:${safeErrorMessage(error)}`);
    }
    if (!response || typeof response.status !== "number") {
      fail("FRONTEND_SLOT_HEALTH_RESPONSE_INVALID", label);
    }
    if (response.redirected === true || (response.status >= 300 && response.status < 400)) {
      fail("FRONTEND_SLOT_HEALTH_REDIRECT_FORBIDDEN", label);
    }
    if (response.url) {
      let finalUrl;
      try {
        finalUrl = new URL(response.url);
      } catch {
        fail("FRONTEND_SLOT_HEALTH_RESPONSE_URL_INVALID", label);
      }
      if (finalUrl.href !== url.href) fail("FRONTEND_SLOT_HEALTH_RESPONSE_URL_CHANGED", label);
    }
    if (response.status !== 200) {
      fail("FRONTEND_SLOT_HEALTH_STATUS_NOT_OK", `${label}:${response.status}`);
    }
    let body;
    try {
      body = await readBoundedBody(response, maximumBytes, label);
    } catch (error) {
      if (controller.signal.aborted) fail("FRONTEND_SLOT_HEALTH_REQUEST_TIMEOUT", label);
      throw error;
    }
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

function decodeHtml(body) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    fail("FRONTEND_SLOT_HEALTH_HTML_INVALID_UTF8");
  }
}

function decodeHtmlAttribute(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&#38;", "&")
    .replaceAll("&#x26;", "&");
}

function localAssetUrls(html, pageUrl) {
  const urls = [];
  const seen = new Set();
  const tagPattern = /<(?:script|link|img|source)\b[^>]*>/giu;
  const attributePattern = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu;
  for (const match of html.matchAll(tagPattern)) {
    const attribute = attributePattern.exec(match[0]);
    const rawValue = decodeHtmlAttribute(String(attribute?.[1] ?? attribute?.[2] ?? attribute?.[3] ?? "").trim());
    if (!rawValue || rawValue.startsWith("#")) continue;
    let candidate;
    try {
      candidate = new URL(rawValue, pageUrl);
    } catch {
      continue;
    }
    if (
      candidate.protocol !== "http:"
      || candidate.origin !== pageUrl.origin
      || !isLoopbackHostname(candidate.hostname)
      || candidate.username
      || candidate.password
      || candidate.pathname === "/"
    ) continue;
    candidate.hash = "";
    if (!seen.has(candidate.href)) {
      seen.add(candidate.href);
      urls.push(candidate);
    }
  }
  return urls;
}

function selectAssetUrl(urls, pageUrl, expectedAssetPath) {
  if (!expectedAssetPath) return urls[0] || null;
  let expected;
  try {
    expected = new URL(String(expectedAssetPath), pageUrl);
  } catch {
    fail("FRONTEND_SLOT_HEALTH_OPTION_INVALID", "expectedAssetPath");
  }
  expected.hash = "";
  if (
    expected.protocol !== "http:"
    || expected.origin !== pageUrl.origin
    || !isLoopbackHostname(expected.hostname)
    || expected.username
    || expected.password
    || expected.pathname === "/"
  ) fail("FRONTEND_SLOT_HEALTH_OPTION_INVALID", "expectedAssetPath");
  return urls.find((candidate) => candidate.href === expected.href) || null;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Verify the static frontend served by one local RUN slot surface.
 *
 * The same function can probe Candidate, direct Active or the local proxy by
 * passing their loopback root URL. It never follows a redirect or fetches an
 * asset outside the exact loopback origin.
 */
export async function probeFrontendSlotHealth(options = {}) {
  const pageUrl = exactLoopbackRootUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") fail("FRONTEND_SLOT_HEALTH_FETCH_UNAVAILABLE");
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs", 60_000);
  const maxHtmlBytes = positiveInteger(
    options.maxHtmlBytes,
    DEFAULT_HTML_LIMIT_BYTES,
    "maxHtmlBytes",
    MAXIMUM_BODY_LIMIT_BYTES,
  );
  const maxAssetBytes = positiveInteger(
    options.maxAssetBytes,
    DEFAULT_ASSET_LIMIT_BYTES,
    "maxAssetBytes",
    MAXIMUM_BODY_LIMIT_BYTES,
  );
  const expectedHtmlSha256 = optionalSha256(options.expectedHtmlSha256, "expectedHtmlSha256");
  const expectedAssetSha256 = optionalSha256(options.expectedAssetSha256, "expectedAssetSha256");
  const expectedHtmlMarker = optionalMarker(options.expectedHtmlMarker, "expectedHtmlMarker");
  const expectedAssetMarker = optionalMarker(options.expectedAssetMarker, "expectedAssetMarker");

  const htmlResult = await fetchBoundedResource(fetchImpl, pageUrl, {
    timeoutMs,
    maximumBytes: maxHtmlBytes,
    accept: "text/html",
    label: "html",
  });
  const htmlContentType = contentType(htmlResult.response);
  if (htmlContentType.split(";", 1)[0].trim() !== "text/html") {
    fail("FRONTEND_SLOT_HEALTH_HTML_CONTENT_TYPE_INVALID", htmlContentType || "missing");
  }
  const html = decodeHtml(htmlResult.body);
  const htmlSha256 = sha256(htmlResult.body);
  if (expectedHtmlSha256 && htmlSha256 !== expectedHtmlSha256) {
    fail("FRONTEND_SLOT_HEALTH_HTML_HASH_MISMATCH", htmlSha256);
  }
  if (expectedHtmlMarker && !html.includes(expectedHtmlMarker)) {
    fail("FRONTEND_SLOT_HEALTH_HTML_MARKER_MISSING");
  }

  const assets = localAssetUrls(html, pageUrl);
  const assetUrl = selectAssetUrl(assets, pageUrl, options.expectedAssetPath);
  if (!assetUrl) {
    fail(
      options.expectedAssetPath
        ? "FRONTEND_SLOT_HEALTH_EXPECTED_ASSET_MISSING"
        : "FRONTEND_SLOT_HEALTH_LOCAL_ASSET_MISSING",
    );
  }
  const assetResult = await fetchBoundedResource(fetchImpl, assetUrl, {
    timeoutMs,
    maximumBytes: maxAssetBytes,
    accept: "*/*",
    label: "asset",
  });
  const assetContentType = contentType(assetResult.response);
  if (assetContentType.split(";", 1)[0].trim() === "text/html") {
    fail("FRONTEND_SLOT_HEALTH_ASSET_CONTENT_TYPE_INVALID", assetContentType);
  }
  if (assetResult.body.length === 0) fail("FRONTEND_SLOT_HEALTH_ASSET_EMPTY");
  const assetSha256 = sha256(assetResult.body);
  if (expectedAssetSha256 && assetSha256 !== expectedAssetSha256) {
    fail("FRONTEND_SLOT_HEALTH_ASSET_HASH_MISMATCH", assetSha256);
  }
  if (expectedAssetMarker && !assetResult.body.includes(Buffer.from(expectedAssetMarker, "utf8"))) {
    fail("FRONTEND_SLOT_HEALTH_ASSET_MARKER_MISSING");
  }

  return {
    ok: true,
    origin: pageUrl.origin,
    html: {
      url: pageUrl.href,
      contentType: htmlContentType,
      bytes: htmlResult.body.length,
      sha256: htmlSha256,
      markerMatched: expectedHtmlMarker ? true : null,
    },
    asset: {
      url: assetUrl.href,
      path: `${assetUrl.pathname}${assetUrl.search}`,
      contentType: assetContentType,
      bytes: assetResult.body.length,
      sha256: assetSha256,
      markerMatched: expectedAssetMarker ? true : null,
    },
  };
}

export const FRONTEND_SLOT_HEALTH_DEFAULTS = Object.freeze({
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxHtmlBytes: DEFAULT_HTML_LIMIT_BYTES,
  maxAssetBytes: DEFAULT_ASSET_LIMIT_BYTES,
});

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_LIST_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

function runBounded(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    let settled = false;
    const terminate = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > Number(options.maxStdoutBytes || MAX_LIST_BYTES)) {
        overflow = true;
        terminate();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > Number(options.maxStderrBytes || MAX_STDERR_BYTES)) {
        overflow = true;
        terminate();
        return;
      }
      stderr.push(chunk);
    });
    const timer = setTimeout(terminate, Number(options.timeoutMs || 60_000));
    timer.unref();
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (overflow) {
        reject(new Error("RELEASE_ARCHIVE_TAR_OUTPUT_LIMIT"));
        return;
      }
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(errorOutput || `Tar-Prüfung endete mit Status ${code}.`));
        return;
      }
      resolve(output);
    });
  });
}

export function parseDockerArchiveManifest(input) {
  const text = typeof input === "string" ? input : String(input || "");
  if (!text || Buffer.byteLength(text) > MAX_MANIFEST_BYTES) {
    throw new Error("RELEASE_ARCHIVE_MANIFEST_INVALID");
  }
  let manifest;
  try { manifest = JSON.parse(text); } catch { throw new Error("RELEASE_ARCHIVE_MANIFEST_INVALID"); }
  if (!Array.isArray(manifest) || manifest.length !== 1) {
    throw new Error("RELEASE_ARCHIVE_MUST_CONTAIN_ONE_IMAGE");
  }
  const entry = manifest[0];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("RELEASE_ARCHIVE_MANIFEST_INVALID");
  }
  const tags = entry.RepoTags;
  if (tags === null || tags === undefined) return [];
  if (!Array.isArray(tags) || tags.length > 32) throw new Error("RELEASE_ARCHIVE_TAGS_INVALID");
  return tags.map((tag) => {
    if (typeof tag !== "string" || tag.length < 3 || tag.length > 255) {
      throw new Error("RELEASE_ARCHIVE_TAGS_INVALID");
    }
    return tag;
  });
}

export function assertReleaseArchiveTags(identity, actualTags, options = {}) {
  if (!identity || typeof identity.repository !== "string" || typeof identity.version !== "string") {
    throw new Error("RELEASE_ARCHIVE_TAG_IDENTITY_INVALID");
  }
  if (!Array.isArray(actualTags) || actualTags.length > 32) throw new Error("RELEASE_ARCHIVE_TAGS_INVALID");
  const expectedTag = `${identity.repository}:${identity.version}`;
  if (actualTags.length !== 1) throw new Error("RELEASE_ARCHIVE_VERSION_TAG_REQUIRED");
  const forbiddenTags = new Set(options.forbiddenTags || []);
  const seen = new Set();
  for (const tag of actualTags) {
    if (typeof tag !== "string" || tag.length < 3 || tag.length > 255 || seen.has(tag)) {
      throw new Error("RELEASE_ARCHIVE_TAGS_INVALID");
    }
    seen.add(tag);
    if (forbiddenTags.has(tag)) throw new Error("RELEASE_ARCHIVE_FORBIDDEN_RUNTIME_TAG");
    if (tag !== expectedTag) throw new Error("RELEASE_ARCHIVE_UNEXPECTED_TAG");
  }
  return true;
}

/** Lists and reads only manifest.json on stdout; it never extracts archive files. */
export async function inspectDockerArchiveTags(archivePath, options = {}) {
  const resolved = path.resolve(archivePath);
  const stat = await fs.lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
    throw new Error("RELEASE_ARCHIVE_FILE_INVALID");
  }
  const tarBinary = options.tarBinary || "/bin/tar";
  const listing = await (options.execute || runBounded)(tarBinary, ["-tf", resolved], {
    maxStdoutBytes: MAX_LIST_BYTES,
    maxStderrBytes: MAX_STDERR_BYTES,
    timeoutMs: 60_000,
  });
  const entries = String(listing).split("\n").map((entry) => entry.replace(/\r$/, "")).filter(Boolean);
  const manifests = entries.filter((entry) => entry === "manifest.json" || entry === "./manifest.json");
  if (manifests.length !== 1) throw new Error("RELEASE_ARCHIVE_MANIFEST_MISSING_OR_DUPLICATE");
  const manifest = await (options.execute || runBounded)(tarBinary, ["-xOf", resolved, manifests[0]], {
    maxStdoutBytes: MAX_MANIFEST_BYTES,
    maxStderrBytes: MAX_STDERR_BYTES,
    timeoutMs: 60_000,
  });
  return parseDockerArchiveManifest(manifest);
}

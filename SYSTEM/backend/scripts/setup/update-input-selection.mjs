import fs from "node:fs/promises";
import path from "node:path";

export const UPDATE_INPUT_SELECTION_SCHEMA = "bonni.update-input-selection/v1";

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

// Bind an explicit input to one direct child. Other ZIPs are deliberately not read.
export async function resolveUpdateInputSelection({ updateRoot, zipFile, expectedSha256 }) {
  if (typeof zipFile !== "string" || !path.isAbsolute(zipFile)
    || path.extname(zipFile).toLowerCase() !== ".zip"
    || typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    fail("UPDATE_PACKAGE_INTAKE_SELECTION_INVALID");
  }
  const source = path.resolve(zipFile);
  if (path.relative(path.resolve(updateRoot), path.dirname(source)) !== "") {
    fail("UPDATE_PACKAGE_INTAKE_SELECTION_OUTSIDE_UPDATE");
  }
  const state = await fs.lstat(source);
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1) {
    fail("UPDATE_PACKAGE_INTAKE_SELECTION_UNSAFE");
  }
  return { name: path.basename(source), path: source, expectedSha256 };
}

export function assertUpdateInputHash(expectedSha256, actualSha256) {
  if (expectedSha256 !== undefined && expectedSha256 !== actualSha256) {
    fail("UPDATE_PACKAGE_INTAKE_SELECTION_CHANGED");
  }
}

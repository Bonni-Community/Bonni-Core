import { promises as fs } from "node:fs";
import path from "node:path";

export type UpdatePackageType = "system" | "module-package" | "import" | "unknown";

const KNOWN_EXTENSIONS = new Set([".zip", ".bonni"]);

function detectType(extension: string): UpdatePackageType {
  if (extension === ".zip" || extension === ".bonni") return "module-package";
  return "unknown";
}

export async function scanUpdateInbox() {
  const inbox = path.resolve(process.cwd(), "updates");

  try {
    const entries = await fs.readdir(inbox, { withFileTypes: true });
    const items = entries
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const extension = path.extname(entry.name).toLowerCase();
        return {
          name: entry.name,
          extension,
          type: KNOWN_EXTENSIONS.has(extension) ? detectType(extension) : "unknown",
          path: path.join("updates", entry.name).replaceAll("\\", "/"),
        };
      });

    return {
      ok: true,
      inbox,
      acceptedExtensions: Array.from(KNOWN_EXTENSIONS),
      items,
    };
  } catch (error) {
    return {
      ok: true,
      inbox,
      acceptedExtensions: Array.from(KNOWN_EXTENSIONS),
      items: [],
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

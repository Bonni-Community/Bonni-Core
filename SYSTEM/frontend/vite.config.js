import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Bonni-Core-only Frontend.
// Apps, Add-ons und Plug-ins werden später über den Module-Manager installiert.
const systemRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(systemRoot, "..");

// Installierte Pakete liegen innerhalb von System. Die zusätzlichen
// projectRoot-Pfade bleiben nur für ältere, bereits vorhandene Installationen
// erlaubt.
const packageRootNames = [
  "app",
  "apps",
  "add-on",
  "addon",
  "addons",
  "plug-in",
  "plugin",
  "plugins",
  "bridge",
  "bridges",
];
const packageRoots = [
  ...packageRootNames.map((name) => path.resolve(systemRoot, name)),
  ...packageRootNames.map((name) => path.resolve(projectRoot, name)),
];

const frontendMimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function setLocalFeatureModuleHeaders(response, contentType = "") {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "no-store");
  if (contentType) response.setHeader("Content-Type", contentType);
}

function safeFeatureModuleRequestPath(requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl || "/", "http://localhost").pathname);
  } catch {
    return null;
  }

  const prefix = "/feature-modules/";
  if (!pathname.startsWith(prefix)) return null;

  const segments = pathname.slice(prefix.length).split("/");
  const slug = segments.shift();
  if (!slug || !/^[a-z0-9][a-z0-9_-]*$/i.test(slug)) return null;
  if (!segments.length || segments.some((segment) => (
    !segment
    || segment === "."
    || segment === ".."
    || !/^[a-z0-9._-]+$/i.test(segment)
  ))) return null;

  return { slug, relativeFile: segments.join(path.sep) };
}

function resolveLocalFeatureModuleFile({ slug, relativeFile }, roots) {
  for (const packagesRoot of roots) {
    const publicRoot = path.resolve(packagesRoot, slug, "frontend", "dist");
    if (!existsSync(publicRoot)) continue;

    const candidate = path.resolve(publicRoot, relativeFile);
    const relative = path.relative(publicRoot, candidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;

    try {
      const publicRootReal = realpathSync(publicRoot);
      const candidateReal = realpathSync(candidate);
      const realRelative = path.relative(publicRootReal, candidateReal);
      if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) continue;
      if (!statSync(candidateReal).isFile()) continue;
      return candidateReal;
    } catch {
      // Das Paket oder sein Build kann während eines Updates kurz fehlen.
    }
  }

  return null;
}

export function createLocalFeatureModuleAssetMiddleware({ roots = packageRoots } = {}) {
  return function localFeatureModuleAssetMiddleware(request, response, next) {
    const requestPath = safeFeatureModuleRequestPath(request.url);
    if (!requestPath) {
      next();
      return;
    }

    if (request.method === "OPTIONS") {
      setLocalFeatureModuleHeaders(response);
      response.statusCode = 204;
      response.end();
      return;
    }

    if (!(["GET", "HEAD"].includes(request.method || "GET"))) {
      next();
      return;
    }

    const file = resolveLocalFeatureModuleFile(requestPath, roots);
    if (!file) {
      // Nicht lokal vorhandene bzw. extern installierte Module werden weiter
      // vom manifest-gesteuerten Backend ausgeliefert.
      next();
      return;
    }

    const extension = path.extname(file).toLowerCase();
    const contentType = frontendMimeTypes.get(extension);
    if (!contentType) {
      next();
      return;
    }

    const size = statSync(file).size;
    setLocalFeatureModuleHeaders(response, contentType);
    response.setHeader("Content-Length", String(size));
    response.statusCode = 200;

    if (request.method === "HEAD") {
      response.end();
      return;
    }

    const stream = createReadStream(file);
    stream.on("error", next);
    stream.pipe(response);
  };
}

export function localFeatureModuleAssetsPlugin() {
  return {
    name: "bonni-local-feature-module-assets",
    enforce: "pre",
    configureServer(server) {
      // Vor Vites Proxy registrieren: lokale, gerade installierte App-Builds
      // können dadurch nie als JSON-404 an einen Modulskript-Import gelangen.
      server.middlewares.use(createLocalFeatureModuleAssetMiddleware());
    },
  };
}

function normalizeBackendTarget(value) {
  const configured = String(value || "http://localhost:4000")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/api$/i, "");

  try {
    const url = new URL(configured);
    return ["http:", "https:"].includes(url.protocol)
      ? url.origin
      : "http://localhost:4000";
  } catch {
    return "http://localhost:4000";
  }
}

export function configureFeatureModuleAssetProxy(proxy) {
  proxy.on("proxyRes", (proxyResponse) => {
    // Abgeschottete App-iframes besitzen absichtlich eine undurchsichtige
    // Origin. Nur die oeffentlichen, unveraenderlichen Moduldateien duerfen
    // deshalb auch im Vite-Entwicklungsbetrieb cross-origin geladen werden.
    proxyResponse.headers["cross-origin-resource-policy"] = "cross-origin";
  });
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "");
  const backendTarget = normalizeBackendTarget(
    process.env.VITE_BACKEND_ACTIVE_URL ||
      process.env.VITE_API_ORIGIN ||
      env.VITE_BACKEND_ACTIVE_URL ||
      env.VITE_API_ORIGIN,
  );

  return {
    base: "/",
    plugins: [localFeatureModuleAssetsPlugin(), react()],
    resolve: {
      alias: {
        react: path.resolve(__dirname, "node_modules/react"),
        "react-dom": path.resolve(__dirname, "node_modules/react-dom"),
        "react/jsx-runtime": path.resolve(__dirname, "node_modules/react/jsx-runtime.js"),
      },
      dedupe: ["react", "react-dom"],
    },
    server: {
      proxy: {
        // Installierte Apps laufen im Entwicklungsbetrieb in einem iframe auf
        // der Vite-Origin. Relative /api-Aufrufe müssen deshalb genauso wie
        // die App-Dateien an das aktive Bonni-Core-Backend weitergereicht
        // werden. So bleiben Entwicklung und Produktion same-origin.
        "/api": {
          target: backendTarget,
          changeOrigin: true,
        },
        // Die App-Frontends werden im Entwicklungsbetrieb vom Core-Backend
        // aus ihren manifest-definierten dist-Ordnern ausgeliefert. Der Proxy
        // hält das iframe auf derselben Origin wie den Vite-App-Host.
        "/feature-modules": {
          target: backendTarget,
          changeOrigin: true,
          configure: configureFeatureModuleAssetProxy,
        },
        // Öffentliche Einstiege installierter Apps werden ebenfalls vom
        // Backend anhand des aktivierten Manifests ausgeliefert. Dadurch ist
        // /meet auch im Vite-Entwicklungsbetrieb ohne Bonni-Anmeldung direkt
        // erreichbar; API und Build-Dateien bleiben weiterhin same-origin.
        "/meet": {
          target: backendTarget,
          changeOrigin: true,
        },
        // Geschützter, lesbarer Member-Einstieg. Das Backend leitet erst nach
        // Prüfung des aktivierten Moduls in den Bonni-Core-Login/App-Router.
        "/meetapp": {
          target: backendTarget,
          changeOrigin: true,
        },
      },
      fs: {
        // Erlaubt Bonni-Core und installierte Modulquellen. Die eigentliche
        // Dateifreigabe bleibt auf frontend/dist und sichere Dateitypen begrenzt.
        allow: [__dirname, systemRoot, projectRoot, ...packageRoots],
      },
    },
  };
});

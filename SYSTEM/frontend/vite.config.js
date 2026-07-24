import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Bonni-Core-only Frontend.
// Apps, Add-ons und Plug-ins werden später über den Module-Manager installiert.
const systemRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(systemRoot, "..");

// Neue Begriffe statt altem feature-modules.
// Diese Ordner dürfen fehlen; Vite nutzt sie nur als erlaubte /@fs-Roots.
const appRoot = path.resolve(projectRoot, "app");
const addOnRoot = path.resolve(projectRoot, "add-on");
const plugInRoot = path.resolve(projectRoot, "plug-in");

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
    plugins: [react()],
    resolve: {
      alias: {
        "#logger": path.resolve(__dirname, "system/services/application/logger/index.js"),
        "#loggerLabels": path.resolve(__dirname, "system/services/application/logger/core/loggerLabels.js"),
        react: path.resolve(__dirname, "node_modules/react"),
        "react-dom": path.resolve(__dirname, "node_modules/react-dom"),
        "react/jsx-runtime": path.resolve(__dirname, "node_modules/react/jsx-runtime.js"),
      },
      dedupe: ["react", "react-dom"],
    },
    server: {
      proxy: {
        // Die App-Frontends werden im Entwicklungsbetrieb vom Core-Backend
        // aus ihren manifest-definierten dist-Ordnern ausgeliefert. Der Proxy
        // hält das iframe auf derselben Origin wie den Vite-App-Host.
        "/feature-modules": {
          target: backendTarget,
          changeOrigin: true,
        },
      },
      fs: {
        // Erlaubt Bonni-Core und spätere installierte Modulquellen ohne den alten feature-modules-Begriff.
        allow: [__dirname, systemRoot, projectRoot, appRoot, addOnRoot, plugInRoot],
      },
    },
  };
});

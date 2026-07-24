import { apiRequest } from "../../../../api/apiClient.js";

function normalizeLogArguments(args) {
  if (args.length === 1 && typeof args[0] === "object" && args[0] !== null) {
    return args[0];
  }

  if (args.length >= 3) {
    const [module, label, data] = args;
    return { module, label, data };
  }

  const [label = "LOG", data = null] = args;
  return {
    module: "frontend",
    label,
    data,
  };
}

async function sendLog({ module = "frontend", level = "info", label = "LOG", data = null }) {
  try {
    await apiRequest("/api/debug/client-log", {
      method: "POST",
      body: {
        side: "frontend",
        module,
        level,
        label,
        data,
      },
    });
  } catch (err) {
    console.error("FRONTEND LOGGER FAILED:", err);
  }
}

function log(level, args) {
  const payload = normalizeLogArguments(args);
  return sendLog({ ...payload, level });
}

export const clientLogger = {
  info(...args) {
    return log("info", args);
  },

  warn(...args) {
    return log("warn", args);
  },

  error(...args) {
    return log("error", args);
  },

  debug(...args) {
    return log("debug", args);
  },
};

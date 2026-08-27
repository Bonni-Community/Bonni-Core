import type { Server } from "node:http";

export const DEFAULT_SERVER_DRAIN_TIMEOUT_MS = 5_000;

type ClosableServer = Pick<Server, "close">
  & Partial<Pick<Server, "closeIdleConnections" | "closeAllConnections">>;

export type LocalSupervisorProcessInput = {
  nodeEnv: string;
  slotRole: string;
  supervisorFlag: string | undefined;
  connected: boolean;
};

export type ServerDrainResult = {
  forced: boolean;
  alreadyClosed: boolean;
  forceCloseError: string | null;
};

function isServerNotRunning(error: unknown) {
  return (error as NodeJS.ErrnoException | null)?.code === "ERR_SERVER_NOT_RUNNING";
}

export function isLocalUpdateSupervisorProcess(input: LocalSupervisorProcessInput) {
  return input.nodeEnv !== "production"
    && input.slotRole === "active"
    && input.supervisorFlag === "1"
    && input.connected;
}

function beginServerDrain(server: ClosableServer, timeoutMs: number) {
  return new Promise<ServerDrainResult>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (
      result: ServerDrainResult,
      error?: unknown,
    ) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };

    try {
      // `close()` synchronously stops the listener from accepting new
      // connections. Its callback can nevertheless wait forever for an old
      // keep-alive/socket, so completion is bounded below.
      server.close((error?: Error) => {
        if (error && !isServerNotRunning(error)) {
          finish({ forced: false, alreadyClosed: false, forceCloseError: null }, error);
          return;
        }
        finish({
          forced: false,
          alreadyClosed: Boolean(error),
          forceCloseError: null,
        });
      });
      server.closeIdleConnections?.();
    } catch (error) {
      if (isServerNotRunning(error)) {
        finish({ forced: false, alreadyClosed: true, forceCloseError: null });
        return;
      }
      finish({ forced: false, alreadyClosed: false, forceCloseError: null }, error);
      return;
    }

    if (settled) return;
    timer = setTimeout(() => {
      if (typeof server.closeAllConnections !== "function") {
        finish(
          { forced: true, alreadyClosed: false, forceCloseError: "closeAllConnections unavailable" },
          new Error("SERVER_FORCE_CLOSE_UNAVAILABLE"),
        );
        return;
      }
      try {
        server.closeAllConnections();
      } catch (error) {
        finish(
          {
            forced: true,
            alreadyClosed: false,
            forceCloseError: error instanceof Error ? error.message : String(error),
          },
          error,
        );
        return;
      }
      // The listener was already closed synchronously. Resolve independently
      // of the Node close callback so one stuck socket cannot keep the
      // Emergency backend alive through npm/prisma maintenance.
      finish({ forced: true, alreadyClosed: false, forceCloseError: null });
    }, Math.max(1, timeoutMs));
  });
}

export function beginBoundedServerDrain(
  servers: ClosableServer[],
  timeoutMs = DEFAULT_SERVER_DRAIN_TIMEOUT_MS,
) {
  // Mapping invokes every `server.close()` before this function returns. A
  // caller can therefore start the Emergency stop immediately afterwards and
  // still know that no Core listener accepts new work.
  return Promise.all(servers.map((server) => beginServerDrain(server, timeoutMs)));
}

export async function completeLocalSupervisorShutdown(options: {
  servers: ClosableServer[];
  stopEmergency: () => Promise<unknown>;
  verifyEmergency?: (result: unknown) => void | Promise<void>;
  disconnectPrisma: () => Promise<unknown>;
  drainTimeoutMs?: number;
}) {
  const drain = beginBoundedServerDrain(options.servers, options.drainTimeoutMs);
  // All close calls above have already been issued. Do not wait for their
  // callbacks before beginning the separately verified process-tree stop.
  const emergency = Promise.resolve().then(options.stopEmergency);
  const [serverDrain, emergencyResult] = await Promise.all([drain, emergency]);
  await options.verifyEmergency?.(emergencyResult);
  await options.disconnectPrisma();
  return { serverDrain, emergencyResult };
}

export function sendIpcMessageAndWait(
  send: (message: unknown, callback: (error: Error | null) => void) => boolean,
  message: unknown,
) {
  return new Promise<void>((resolve, reject) => {
    try {
      send(message, (error) => {
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

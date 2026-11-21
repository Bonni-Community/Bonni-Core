export const DEFAULT_SERVER_DRAIN_TIMEOUT_MS = 5_000;
function isServerNotRunning(error) {
    return error?.code === "ERR_SERVER_NOT_RUNNING";
}
export function isLocalUpdateSupervisorProcess(input) {
    return input.nodeEnv !== "production"
        && input.slotRole === "active"
        && input.supervisorFlag === "1"
        && input.connected;
}
function beginServerDrain(server, timeoutMs) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        const finish = (result, error) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            if (error)
                reject(error);
            else
                resolve(result);
        };
        try {
            // `close()` synchronously stops the listener from accepting new
            // connections. Its callback can nevertheless wait forever for an old
            // keep-alive/socket, so completion is bounded below.
            server.close((error) => {
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
        }
        catch (error) {
            if (isServerNotRunning(error)) {
                finish({ forced: false, alreadyClosed: true, forceCloseError: null });
                return;
            }
            finish({ forced: false, alreadyClosed: false, forceCloseError: null }, error);
            return;
        }
        if (settled)
            return;
        timer = setTimeout(() => {
            if (typeof server.closeAllConnections !== "function") {
                finish({ forced: true, alreadyClosed: false, forceCloseError: "closeAllConnections unavailable" }, new Error("SERVER_FORCE_CLOSE_UNAVAILABLE"));
                return;
            }
            try {
                server.closeAllConnections();
            }
            catch (error) {
                finish({
                    forced: true,
                    alreadyClosed: false,
                    forceCloseError: error instanceof Error ? error.message : String(error),
                }, error);
                return;
            }
            // The listener was already closed synchronously. Resolve independently
            // of the Node close callback so one stuck socket cannot keep the
            // Emergency backend alive through npm/prisma maintenance.
            finish({ forced: true, alreadyClosed: false, forceCloseError: null });
        }, Math.max(1, timeoutMs));
    });
}
export function beginBoundedServerDrain(servers, timeoutMs = DEFAULT_SERVER_DRAIN_TIMEOUT_MS) {
    // Mapping invokes every `server.close()` before this function returns. A
    // caller can therefore start the Emergency stop immediately afterwards and
    // still know that no Core listener accepts new work.
    return Promise.all(servers.map((server) => beginServerDrain(server, timeoutMs)));
}
export async function completeLocalSupervisorShutdown(options) {
    const drain = beginBoundedServerDrain(options.servers, options.drainTimeoutMs);
    // All close calls above have already been issued. Do not wait for their
    // callbacks before beginning the separately verified process-tree stop.
    const emergency = Promise.resolve().then(options.stopEmergency);
    const [serverDrain, emergencyResult] = await Promise.all([drain, emergency]);
    await options.verifyEmergency?.(emergencyResult);
    await options.disconnectPrisma();
    return { serverDrain, emergencyResult };
}
export function sendIpcMessageAndWait(send, message) {
    return new Promise((resolve, reject) => {
        try {
            send(message, (error) => {
                if (error)
                    reject(error);
                else
                    resolve();
            });
        }
        catch (error) {
            reject(error);
        }
    });
}

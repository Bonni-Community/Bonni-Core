import { useEffect, useMemo, useState } from "react";

import {
  cryptoDatabasePrefix,
  cryptoStorageKey,
  formatMatrixError,
} from "../core/matrixSession.js";

const INITIAL_STATE = {
  client: null,
  syncState: "STOPPED",
  cryptoState: "idle",
  cryptoWarning: "",
  error: "",
  revision: 0,
};

export default function useMatrixClient(session) {
  const [state, setState] = useState(INITIAL_STATE);
  const sessionKey = useMemo(() => (
    session ? `${session.homeserver}|${session.userId}|${session.deviceId}|${session.accessToken}` : ""
  ), [session]);

  useEffect(() => {
    if (!sessionKey || !session) {
      setState(INITIAL_STATE);
      return undefined;
    }

    let active = true;
    let client = null;

    const bumpRevision = () => {
      if (!active) return;
      setState((current) => ({ ...current, revision: current.revision + 1 }));
    };

    const onSync = (syncState, _previousState, data) => {
      if (!active) return;
      const error = syncState === "ERROR"
        ? formatMatrixError(data?.error, "Die Matrix-Synchronisierung ist unterbrochen.")
        : "";
      setState((current) => ({
        ...current,
        syncState,
        error,
        revision: current.revision + 1,
      }));
    };

    let eventBindings = [];

    async function start() {
      let sdk;
      try {
        sdk = await import("matrix-js-sdk");
      } catch (error) {
        if (active) {
          setState((current) => ({
            ...current,
            syncState: "ERROR",
            error: formatMatrixError(error, "Das Matrix-SDK konnte nicht geladen werden."),
          }));
        }
        return;
      }
      if (!active) return;

      client = sdk.createClient({
        baseUrl: session.homeserver,
        accessToken: session.accessToken,
        refreshToken: session.refreshToken || undefined,
        userId: session.userId,
        deviceId: session.deviceId || undefined,
        timelineSupport: true,
      });

      eventBindings = [
        [sdk.ClientEvent.Sync, onSync],
        [sdk.RoomEvent.Timeline, bumpRevision],
        [sdk.RoomEvent.Name, bumpRevision],
        [sdk.RoomEvent.MyMembership, bumpRevision],
        [sdk.RoomStateEvent.Events, bumpRevision],
        [sdk.MatrixEventEvent.Decrypted, bumpRevision],
      ].filter(([eventName]) => Boolean(eventName));

      for (const [eventName, listener] of eventBindings) client.on(eventName, listener);

      setState({
        ...INITIAL_STATE,
        client,
        syncState: "STARTING",
        cryptoState: "starting",
      });

      let cryptoState = "ready";
      let cryptoWarning = "";

      try {
        const storageKey = await cryptoStorageKey(session);
        await client.initRustCrypto({
          cryptoDatabasePrefix: cryptoDatabasePrefix(session),
          storageKey,
        });
      } catch (error) {
        cryptoState = "unavailable";
        cryptoWarning = `Verschlüsselung konnte nicht initialisiert werden: ${formatMatrixError(error)}`;
      }

      if (!active) return;
      setState((current) => ({ ...current, cryptoState, cryptoWarning }));

      try {
        await client.startClient({ initialSyncLimit: 40, lazyLoadMembers: true });
      } catch (error) {
        if (!active) return;
        setState((current) => ({
          ...current,
          syncState: "ERROR",
          error: formatMatrixError(error, "MatrixChat konnte nicht gestartet werden."),
        }));
      }
    }

    start();

    return () => {
      active = false;
      for (const [eventName, listener] of eventBindings) client?.off(eventName, listener);
      client?.stopClient();
    };
  }, [sessionKey]);

  return state;
}

import { useCallback, useEffect, useMemo, useState } from "react";

import ChatPanel from "./components/ChatPanel.jsx";
import JoinRoomModal from "./components/JoinRoomModal.jsx";
import LoginPanel from "./components/LoginPanel.jsx";
import MatrixMark from "./components/MatrixMark.jsx";
import RoomSidebar from "./components/RoomSidebar.jsx";
import SettingsModal from "./components/SettingsModal.jsx";
import { loginWithMatrixPassword } from "./core/matrixAuth.js";
import {
  DEFAULT_MATRIX_CONFIG,
  isHomeserverAllowed,
  loadMatrixConfig,
} from "./core/matrixConfig.js";
import {
  clearMatrixSession,
  formatMatrixError,
  loadMatrixSession,
  saveMatrixSession,
} from "./core/matrixSession.js";
import {
  buildMessages,
  buildRoomViewModels,
  filterRooms,
} from "./core/matrixViewModel.js";
import useBonniContext from "./hooks/useBonniContext.js";
import useMatrixClient from "./hooks/useMatrixClient.js";

function HostGate({ embedded }) {
  return (
    <main className="host-gate">
      <MatrixMark />
      <p className="eyebrow">Bonni Core · MatrixChat</p>
      <h1>{embedded ? "Bonni-Kontext wird geladen …" : "Bitte über Bonni Core öffnen"}</h1>
      <p>
        {embedded
          ? "Das Add-on wartet auf die sichere Sitzungsübergabe des Bonni-Core-Hosts."
          : "Der Produktions-Build akzeptiert nur Aufrufe über den Bonni-Core-Add-on-Host."}
      </p>
      {embedded ? <span className="spinner" aria-label="Lädt" /> : null}
    </main>
  );
}

export default function App() {
  const { context, embedded, sendAction } = useBonniContext();
  const [config, setConfig] = useState(DEFAULT_MATRIX_CONFIG);
  const [session, setSession] = useState(() => loadMatrixSession());
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [selectedRoomId, setSelectedRoomId] = useState("");
  const [roomQuery, setRoomQuery] = useState("");
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [joinModalOpen, setJoinModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [sending, setSending] = useState(false);

  const matrix = useMatrixClient(session);
  const rooms = useMemo(
    () => buildRoomViewModels(matrix.client),
    [matrix.client, matrix.revision],
  );
  const visibleRooms = useMemo(() => filterRooms(rooms, roomQuery), [rooms, roomQuery]);
  const selectedRoom = useMemo(
    () => rooms.find((room) => room.id === selectedRoomId) || null,
    [rooms, selectedRoomId],
  );
  const messages = useMemo(
    () => buildMessages(matrix.client, selectedRoomId),
    [matrix.client, matrix.revision, selectedRoomId],
  );

  useEffect(() => {
    let cancelled = false;
    loadMatrixConfig().then((nextConfig) => {
      if (!cancelled) setConfig(nextConfig);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!rooms.length) {
      setSelectedRoomId("");
      return;
    }

    if (!rooms.some((room) => room.id === selectedRoomId)) {
      setSelectedRoomId((rooms.find((room) => !room.invited) || rooms[0]).id);
    }
  }, [rooms, selectedRoomId]);

  const closeJoinModal = useCallback(() => {
    setJoinModalOpen(false);
    setActionError("");
  }, []);

  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  async function handleLogin({ homeserver, username, password, remember }) {
    setLoginBusy(true);
    setLoginError("");

    try {
      if (!isHomeserverAllowed(homeserver, config)) {
        throw new Error("Dieser Homeserver ist in der MatrixChat-Konfiguration nicht freigegeben.");
      }

      const nextSession = await loginWithMatrixPassword({ homeserver, username, password });
      const savedSession = saveMatrixSession(nextSession, remember);
      setSession(savedSession);
      return true;
    } catch (error) {
      setLoginError(formatMatrixError(error, "Matrix-Anmeldung fehlgeschlagen."));
      return false;
    } finally {
      setLoginBusy(false);
    }
  }

  function selectRoom(roomId) {
    setSelectedRoomId(roomId);
    setMobileSidebarOpen(false);
    setActionError("");

    const room = matrix.client?.getRoom(roomId);
    const events = room?.getLiveTimeline?.()?.getEvents?.() || [];
    const lastEvent = events.at(-1);
    if (lastEvent && room?.getMyMembership?.() === "join") {
      matrix.client.sendReadReceipt(lastEvent).catch(() => {});
    }
  }

  async function joinRoom(roomAddress) {
    if (!matrix.client || !roomAddress) return false;
    setActionBusy(true);
    setActionError("");

    try {
      const room = await matrix.client.joinRoom(roomAddress);
      setSelectedRoomId(room.roomId);
      return true;
    } catch (error) {
      setActionError(formatMatrixError(error, "Dem Raum konnte nicht beigetreten werden."));
      return false;
    } finally {
      setActionBusy(false);
    }
  }

  async function acceptInvite(roomId) {
    const success = await joinRoom(roomId);
    if (success) setSelectedRoomId(roomId);
  }

  async function declineInvite(roomId) {
    if (!matrix.client) return;
    setActionBusy(true);
    setActionError("");

    try {
      await matrix.client.leave(roomId);
      setSelectedRoomId("");
    } catch (error) {
      setActionError(formatMatrixError(error, "Die Einladung konnte nicht abgelehnt werden."));
    } finally {
      setActionBusy(false);
    }
  }

  async function sendMessage(body) {
    if (!matrix.client || !selectedRoomId) return false;
    setSending(true);
    setActionError("");

    try {
      await matrix.client.sendTextMessage(selectedRoomId, body);
      return true;
    } catch (error) {
      setActionError(formatMatrixError(error, "Die Nachricht konnte nicht gesendet werden."));
      return false;
    } finally {
      setSending(false);
    }
  }

  async function logoutMatrix() {
    setActionBusy(true);
    setActionError("");

    try {
      await matrix.client?.logout(true);
    } catch (error) {
      console.warn("Matrix-Token konnte serverseitig nicht widerrufen werden", error);
    } finally {
      clearMatrixSession();
      setSession(null);
      setSettingsOpen(false);
      setSelectedRoomId("");
      setActionBusy(false);
    }
  }

  if (!context) return <HostGate embedded={embedded} />;

  if (!session) {
    return (
      <LoginPanel
        config={config}
        context={context}
        busy={loginBusy}
        error={loginError}
        onLogin={handleLogin}
      />
    );
  }

  return (
    <div className="matrix-app">
      <RoomSidebar
        rooms={visibleRooms}
        selectedRoomId={selectedRoomId}
        query={roomQuery}
        userId={session.userId}
        mobileOpen={mobileSidebarOpen}
        onQueryChange={setRoomQuery}
        onSelectRoom={selectRoom}
        onJoinRoom={() => setJoinModalOpen(true)}
        onBack={() => sendAction("close")}
        onSettings={() => setSettingsOpen(true)}
        onCloseMobile={() => setMobileSidebarOpen(false)}
      />

      {mobileSidebarOpen ? (
        <button className="sidebar-scrim" type="button" onClick={() => setMobileSidebarOpen(false)} aria-label="Raumliste schließen" />
      ) : null}

      <ChatPanel
        room={selectedRoom}
        messages={messages}
        syncState={matrix.syncState}
        cryptoState={matrix.cryptoState}
        cryptoWarning={matrix.cryptoWarning}
        error={actionError || matrix.error}
        sending={sending}
        mobileSidebarOpen={mobileSidebarOpen}
        onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
        onJoinRoom={() => setJoinModalOpen(true)}
        onAcceptInvite={acceptInvite}
        onDeclineInvite={declineInvite}
        onSend={sendMessage}
      />

      {joinModalOpen ? (
        <JoinRoomModal
          busy={actionBusy}
          error={actionError}
          onJoin={joinRoom}
          onClose={closeJoinModal}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsModal
          session={session}
          cryptoState={matrix.cryptoState}
          busy={actionBusy}
          onLogout={logoutMatrix}
          onClose={closeSettings}
        />
      ) : null}
    </div>
  );
}

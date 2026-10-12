function eventTimestamp(event) {
  return Number(event?.getTs?.() || event?.event?.origin_server_ts || 0);
}

function eventType(event) {
  return String(event?.getType?.() || event?.event?.type || "");
}

function eventContent(event) {
  return event?.getContent?.() || event?.event?.content || {};
}

function senderName(room, event) {
  const senderId = String(event?.getSender?.() || event?.event?.sender || "");
  const member = room?.getMember?.(senderId);
  return member?.name || member?.rawDisplayName || senderId || "Unbekannt";
}

export function initials(value) {
  const parts = String(value || "#")
    .replace(/^[@#!]/, "")
    .split(/[\s._:-]+/)
    .filter(Boolean);

  if (parts.length > 1) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return (parts[0] || "#").slice(0, 2).toUpperCase();
}

export function messageBodyForEvent(event) {
  const type = eventType(event);
  const content = eventContent(event);

  if (type === "m.room.encrypted") return "Verschlüsselte Nachricht";
  if (type !== "m.room.message") return "";

  const replacedContent = content?.["m.new_content"];
  const body = String(replacedContent?.body || content?.body || "").trim();

  if (content.msgtype === "m.image") return body ? `Bild: ${body}` : "Bild";
  if (content.msgtype === "m.file") return body ? `Datei: ${body}` : "Datei";
  if (content.msgtype === "m.audio") return body ? `Audio: ${body}` : "Audiodatei";
  if (content.msgtype === "m.video") return body ? `Video: ${body}` : "Video";
  if (content.msgtype === "m.location") return body || "Standort";
  return body;
}

function isEditEvent(event) {
  const relation = eventContent(event)?.["m.relates_to"];
  return relation?.rel_type === "m.replace";
}

export function eventToMessage(room, event, ownUserId) {
  const type = eventType(event);
  if (!["m.room.message", "m.room.encrypted"].includes(type) || isEditEvent(event)) return null;

  const body = messageBodyForEvent(event);
  if (!body) return null;

  const senderId = String(event?.getSender?.() || event?.event?.sender || "");
  const content = eventContent(event);
  const id = String(event?.getId?.() || event?.event?.event_id || `local-${eventTimestamp(event)}`);
  const status = String(event?.getStatus?.() || "").toLowerCase();

  return {
    id,
    senderId,
    senderName: senderName(room, event),
    senderInitials: initials(senderName(room, event)),
    body,
    timestamp: eventTimestamp(event),
    own: Boolean(ownUserId && senderId === ownUserId),
    notice: content.msgtype === "m.notice",
    emote: content.msgtype === "m.emote",
    encrypted: type === "m.room.encrypted" || Boolean(event?.isEncrypted?.()),
    pending: ["sending", "queued", "encrypting"].some((value) => status.includes(value)),
    failed: status.includes("not_sent") || status.includes("cancelled"),
  };
}

function roomEvents(room) {
  return room?.getLiveTimeline?.()?.getEvents?.() || room?.timeline || [];
}

function roomLastEvent(room) {
  const events = roomEvents(room);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (messageBodyForEvent(event) && !isEditEvent(event)) return event;
  }
  return null;
}

function unreadCount(room) {
  try {
    return Number(room?.getUnreadNotificationCount?.("total") || 0);
  } catch {
    return 0;
  }
}

function highlightCount(room) {
  try {
    return Number(room?.getUnreadNotificationCount?.("highlight") || 0);
  } catch {
    return 0;
  }
}

export function roomToViewModel(room) {
  const lastEvent = roomLastEvent(room);
  const membership = String(room?.getMyMembership?.() || "join");
  const name = String(room?.name || room?.getCanonicalAlias?.() || room?.roomId || "Unbenannter Raum");

  return {
    id: room.roomId,
    name,
    initials: initials(name),
    membership,
    invited: membership === "invite",
    encrypted: Boolean(room?.hasEncryptionStateEvent?.()),
    unread: unreadCount(room),
    highlights: highlightCount(room),
    memberCount: Number(room?.getJoinedMemberCount?.() || 0),
    lastMessage: lastEvent ? messageBodyForEvent(lastEvent) : membership === "invite" ? "Einladung" : "Noch keine Nachrichten",
    lastTimestamp: lastEvent ? eventTimestamp(lastEvent) : 0,
  };
}

export function buildRoomViewModels(client) {
  if (!client) return [];

  return client.getRooms()
    .map(roomToViewModel)
    .filter((room) => ["join", "invite"].includes(room.membership))
    .sort((left, right) => {
      if (left.invited !== right.invited) return left.invited ? -1 : 1;
      if (left.lastTimestamp !== right.lastTimestamp) return right.lastTimestamp - left.lastTimestamp;
      return left.name.localeCompare(right.name, "de");
    });
}

export function buildMessages(client, roomId) {
  const room = client?.getRoom?.(roomId);
  if (!room) return [];

  const ownUserId = client.getUserId?.();
  return roomEvents(room)
    .map((event) => eventToMessage(room, event, ownUserId))
    .filter(Boolean)
    .slice(-250);
}

export function filterRooms(rooms, query) {
  const needle = String(query || "").trim().toLocaleLowerCase("de");
  if (!needle) return rooms;

  return rooms.filter((room) => (
    room.name.toLocaleLowerCase("de").includes(needle)
    || room.id.toLocaleLowerCase("de").includes(needle)
  ));
}

export function formatMessageTime(timestamp) {
  if (!timestamp) return "";
  return new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

export function formatRoomTime(timestamp) {
  if (!timestamp) return "";

  const value = new Date(timestamp);
  const today = new Date();
  if (value.toDateString() === today.toDateString()) return formatMessageTime(timestamp);

  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
  }).format(value);
}

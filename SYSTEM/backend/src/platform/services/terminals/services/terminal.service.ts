import { prisma } from "../../../../core/database/database.js";

export async function listTerminals() {
  return prisma.terminal.findMany({
    include: {
      capabilities: true,
      localNode: true
    },
    orderBy: {
      name: "asc"
    }
  });
}

export async function getTerminal(id: string) {
  return prisma.terminal.findUnique({
    where: { id },
    include: {
      capabilities: true,
      sessions: {
        orderBy: {
          startedAt: "desc"
        },
        take: 10
      },
      localNode: true
    }
  });
}

export async function createTerminal(data: {
  key: string;
  name: string;
  type: string;
  layoutPreset: string;
  roomId?: string;
  localNodeId?: string;
}) {
  return prisma.terminal.create({
    data
  });
}

export async function updateTerminal(id: string, data: {
  name?: string;
  layoutPreset?: string;
  active?: boolean;
}) {
  return prisma.terminal.update({
    where: { id },
    data
  });
}

export async function getTerminalStatus(id: string) {
  const terminal = await prisma.terminal.findUnique({
    where: { id },
    include: {
      localNode: true,
      sessions: {
        where: {
          endedAt: null
        }
      }
    }
  });

  if (!terminal) {
    throw Object.assign(new Error("TERMINAL_NOT_FOUND"), { statusCode: 404 });
  }

  return {
    terminalId: terminal.id,
    terminalKey: terminal.key,
    active: terminal.active,
    localNode: terminal.localNode,
    online: terminal.localNode?.status !== "ERROR",
    emergencyMode: terminal.localNode?.status === "EMERGENCY_LOCAL",
    activeSessions: terminal.sessions.length
  };
}

export async function startTerminalSession(terminalId: string, data: {
  accountId?: string;
  personId?: string;
}) {
  return prisma.terminalSession.create({
    data: {
      terminalId,
      accountId: data.accountId,
      personId: data.personId
    }
  });
}

export async function endTerminalSession(sessionId: string) {
  return prisma.terminalSession.update({
    where: { id: sessionId },
    data: {
      endedAt: new Date()
    }
  });
}

export async function listCapabilities(terminalId: string) {
  return prisma.terminalCapability.findMany({
    where: {
      terminalId
    },
    orderBy: {
      capability: "asc"
    }
  });
}

export async function setCapability(terminalId: string, capability: string, enabled: boolean) {
  return prisma.terminalCapability.upsert({
    where: {
      terminalId_capability: {
        terminalId,
        capability
      }
    },
    update: {
      enabled
    },
    create: {
      terminalId,
      capability,
      enabled
    }
  });
}

import { prisma } from "../../../core/database/database.js";

export async function listTerminals() {
  return prisma.terminal.findMany({
    include: {
      capabilities: true
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
      }
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
  localNodeId?: string | null;
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
    localNodeId: terminal.localNodeId,
    online: terminal.active,
    emergencyMode: false,
    activeSessions: terminal.sessions.length
  };
}

export async function startTerminalSession(terminalId: string, accountId: string) {
  if (!accountId) {
    throw Object.assign(new Error("UNAUTHORIZED"), { statusCode: 401 });
  }

  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { id: true, personId: true, isActive: true },
  });

  if (!account?.isActive) {
    throw Object.assign(new Error("ACCOUNT_DISABLED"), { statusCode: 401 });
  }

  return prisma.terminalSession.create({
    data: {
      terminalId,
      accountId: account.id,
      personId: account.personId,
    }
  });
}

export async function endTerminalSession(sessionId: string, accountId: string) {
  if (!accountId) {
    throw Object.assign(new Error("UNAUTHORIZED"), { statusCode: 401 });
  }

  const session = await prisma.terminalSession.findUnique({
    where: { id: sessionId },
    select: { id: true, accountId: true },
  });

  if (!session) {
    throw Object.assign(new Error("TERMINAL_SESSION_NOT_FOUND"), { statusCode: 404 });
  }

  if (session.accountId !== accountId) {
    throw Object.assign(new Error("TERMINAL_SESSION_FORBIDDEN"), { statusCode: 403 });
  }

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

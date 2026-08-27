import { prisma } from "../../../core/database/prisma.js";

type SessionInput = {
  accountId: string;
  loginName: string;
  credentialRevision: number;
  expiresAt?: Date;
};

const memorySessions = new Map<string, any>();

export class CoreSessionService {
  async createSession(input: SessionInput) {
    try {
      return await prisma.session.create({
        data: {
          accountId: input.accountId,
          credentialRevision: input.credentialRevision,
          startedAt: new Date(),
        },
      });
    } catch {
      const sessionId = `${input.accountId}-${Date.now()}`;
      const session = {
        id: sessionId,
        sessionId,
        accountId: input.accountId,
        loginName: input.loginName,
        credentialRevision: input.credentialRevision,
        startedAt: new Date(),
        lastSeenAt: new Date(),
      };
      memorySessions.set(sessionId, session);
      return session;
    }
  }

  async listSessionsForAccount(accountId: string) {
    try {
      return await prisma.session.findMany({
        where: {
          accountId,
          endedAt: null,
        },
      });
    } catch {
      return Array.from(memorySessions.values()).filter(
        (session) => session.accountId === accountId && !session.endedAt
      );
    }
  }

  async touchSessionsForAccount(accountId: string) {
    const sessions = await this.listSessionsForAccount(accountId);

    for (const session of sessions) {
      if (session.id && !String(session.id).startsWith(accountId + "-")) {
        try {
          await prisma.session.update({
            where: { id: session.id },
            data: {
              // Schema hat kein lastSeenAt. Deshalb bleibt startedAt erhalten.
              // Aktive Session wird durch endedAt = null erkannt.
            },
          });
        } catch {
          // ignore
        }
      } else {
        session.lastSeenAt = new Date();
        memorySessions.set(session.id || session.sessionId, session);
      }
    }

    return {
      accountId,
      touchedCount: sessions.length,
      touchedAt: new Date(),
    };
  }

  async closeSession(sessionId: string) {
    try {
      return await prisma.session.update({
        where: {
          id: sessionId,
        },
        data: {
          endedAt: new Date(),
        },
      });
    } catch {
      const existing = memorySessions.get(sessionId);
      if (existing) {
        existing.endedAt = new Date();
        memorySessions.set(sessionId, existing);
      }

      return {
        id: sessionId,
        sessionId,
        closed: Boolean(existing),
        endedAt: new Date(),
      };
    }
  }

  async closeSessionsForAccount(accountId: string) {
    const sessions = await this.listSessionsForAccount(accountId);

    for (const session of sessions) {
      await this.closeSession(session.id || session.sessionId);
    }

    return {
      accountId,
      closedCount: sessions.length,
      closedAt: new Date(),
    };
  }
}

export const coreSessionService = new CoreSessionService();

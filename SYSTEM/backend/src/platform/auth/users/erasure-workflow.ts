import { createHash } from "node:crypto";

// Request and independent approval. The restartable cycle service owns execution.
export const ERASURE_TYPE = "SYSTEM_WIDE_USER_ERASURE_V1";
export const ERASURE_SUBJECT = "BONNI_USER";
export const ERASURE_MODULE = "core.privacy.erasure";
const PURPOSE = "DSGVO_SUBJECT_DATA_DELETE" as const;

export type Actor = { id: string; personId: string | null; sessionId: string; revision: number };
export type Target = { id: string; personId: string | null; memberId: string | null; revision: number; active: boolean; protectedSystemAccount: boolean };
export type Entry = {
  id: string; status: string; accountId: string | null; subjectId: string | null;
  requestedByAccountId: string | null; createdAt: Date; updatedAt: Date; resultJson: unknown;
};
type Action = "request" | "approve";
type Binding = { purpose: typeof PURPOSE; moduleKey: string; subjectId: string };
type Plan = { id: string; target: Target; revision: string; entry: Entry | null; binding: Binding };
export type WorkflowPorts = {
  target: (id: string) => Promise<Target | null>;
  latest: (accountId: string) => Promise<Entry | null>;
  find: (id: string) => Promise<Entry | null>;
  proofConfirmed: (accountId: string, proofId: string, binding: string) => Promise<boolean>;
  challenge: (actor: Actor, binding: Binding) => Promise<unknown>;
  consume: (actor: Actor, binding: Binding, id: string) => Promise<unknown>;
  create: (actor: Actor, plan: Plan, proofId: string) => Promise<Entry>;
  approve: (actor: Actor, plan: Plan, proofId: string) => Promise<Entry>;
};

export function erasureError(code: string, message: string, statusCode = 409): never {
  throw Object.assign(new Error(message), { code, statusCode });
}
const digest = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const active = (row: Entry | null) => row?.status === "OPEN" || row?.status === "IN_REVIEW";
export function erasureDto(row: Entry | null) {
  if (!row || !active(row)) return { request: null };
  const approved = row.status === "IN_REVIEW";
  const info = row.resultJson && typeof row.resultJson === "object" ? row.resultJson : {};
  const cycle = (info as any).cycle;
  const states = ["DEACTIVATED", "WAITING_CYCLE", "BLOCKED", "ERASING"];
  // IN_REVIEW alone is not proof that this workflow recorded independent approval.
  if (approved && (!("approvedAt" in info) || typeof info.approvedAt !== "string" || !Number.isFinite(Date.parse(info.approvedAt))
    || !("approvedByAccountId" in info) || typeof info.approvedByAccountId !== "string" || !info.approvedByAccountId
    || info.approvedByAccountId === row.accountId || info.approvedByAccountId === row.requestedByAccountId
    || !("approvalProofId" in info) || typeof info.approvalProofId !== "string" || !info.approvalProofId)) {
    return erasureError("ERASURE_STATE_UNVERIFIED", "Der Bearbeitungsstand muss geprüft werden.");
  }
  return { request: {
    id: row.id,
    state: approved ? cycle && states.includes(cycle.state) ? cycle.state as "DEACTIVATED" | "WAITING_CYCLE" | "BLOCKED" | "ERASING" : "APPROVED_PENDING_CHECKS" as const : "REQUESTED" as const,
    requestedAt: row.createdAt.toISOString(),
    ...(approved && "approvedAt" in info ? { approvedAt: String(info.approvedAt) } : {}),
  } };
}

export function erasureWorkflow(p: WorkflowPorts) {
  async function assertOrigin(row: Entry) {
    const info = row.resultJson && typeof row.resultJson === "object" ? row.resultJson : {};
    const prefix = "erasure-v1:request:" + row.id + ":";
    if (!/^era_[a-f0-9]{64}$/u.test(row.id) || !row.accountId || row.requestedByAccountId !== row.accountId
      || !("scope" in info) || info.scope !== "BONNI_USER_AND_ALL_APPS"
      || !("requestProofId" in info) || typeof info.requestProofId !== "string" || !/^[A-Za-z0-9._:-]{1,180}$/u.test(info.requestProofId)
      || !("requestBinding" in info) || typeof info.requestBinding !== "string"
      || !info.requestBinding.startsWith(prefix) || !/^[a-f0-9]{64}$/u.test(info.requestBinding.slice(prefix.length))
      || !await p.proofConfirmed(row.accountId, info.requestProofId, info.requestBinding)) {
      return erasureError("ERASURE_ORIGIN_UNVERIFIED", "Der bestätigte Ursprung dieses Antrags ist nicht nachweisbar.");
    }
  }
  async function plan(actor: Actor, action: Action, requestId?: string): Promise<Plan> {
    const old = action === "approve" ? await p.find(requestId!) : await p.latest(actor.id);
    if (action === "approve" && (!old || !old.accountId || old.status !== "OPEN")) {
      return erasureError("ERASURE_NOT_PENDING", "Dieser Antrag steht nicht zur Freigabe an.");
    }
    if (action === "request" && active(old)) {
      return erasureError("ERASURE_ALREADY_REQUESTED", "Es gibt bereits einen offenen Löschantrag.");
    }
    const target = await p.target(action === "request" ? actor.id : old!.accountId!);
    if (!target) return erasureError("ERASURE_PERSONAL_ACCOUNT_REQUIRED", "Persönlicher Benutzerzugang nicht verfügbar.");
    if (target.protectedSystemAccount) {
      return erasureError("ERASURE_SYSTEM_ACCOUNT_PROTECTED", "Der feste Systemzugang ist kein löschbares persönliches Benutzerkonto.");
    }
    if (action === "request" && (!target.active || target.revision !== actor.revision || target.personId !== actor.personId)) {
      return erasureError("ERASURE_IDENTITY_CHANGED", "Die Identität hat sich geändert. Bitte erneut anmelden.");
    }
    if (action === "approve") {
      await assertOrigin(old!);
      const reviewer = await p.target(actor.id);
      if (!reviewer?.active || reviewer.revision !== actor.revision || reviewer.personId !== actor.personId) {
        return erasureError("ERASURE_REVIEWER_CHANGED", "Der Zugang für die Freigabe hat sich geändert.");
      }
      if (actor.id === target.id || actor.id === old!.requestedByAccountId
        || (actor.personId && (actor.personId === target.personId || actor.personId === old!.subjectId))) {
        return erasureError("ERASURE_SELF_APPROVAL_FORBIDDEN", "Eine andere berechtigte Person muss den Antrag freigeben.", 403);
      }
      if (!actor.personId || !target.personId || target.personId !== old!.subjectId
        || old!.requestedByAccountId !== target.id) {
        return erasureError("ERASURE_IDENTITY_UNVERIFIED", "Die getrennten Personenzuordnungen müssen zuerst geprüft werden.");
      }
    }
    const revision = old ? JSON.stringify([old.id, old.status, old.updatedAt.toISOString()]) : "initial";
    // A unique generation for each account and predecessor. Concurrent submissions
    // therefore collide on the existing primary key, without a schema migration.
    const id = action === "approve" ? old!.id : "era_" + digest([ERASURE_TYPE, target.id, revision]);
    // The public generic 2FA endpoint cannot issue a moduleKey or subjectId. The
    // opaque compound binding also distinguishes request, decision, session and
    // target version even though ordinary DSGVO purposes share CORE.<purpose>.
    const subjectId = "erasure-v1:" + action + ":" + id + ":" + digest([action, id, revision, actor.id, actor.personId,
      actor.sessionId, actor.revision, target.id, target.personId, target.memberId, target.revision]);
    return { id, revision, target, entry: old, binding: { purpose: PURPOSE, moduleKey: ERASURE_MODULE, subjectId } };
  }
  return {
    async read(accountId: string) {
      const row = await p.latest(accountId);
      if (row && active(row)) {
        const target = await p.target(accountId);
        if (!target || target.protectedSystemAccount || target.id !== row.accountId || target.personId !== row.subjectId) {
          return erasureError("ERASURE_IDENTITY_CHANGED", "Die ursprüngliche Personenzuordnung muss geprüft werden.");
        }
        await assertOrigin(row);
      }
      const dto = erasureDto(row);
      if (row?.status === "IN_REVIEW") {
        const info = row.resultJson as Record<string, unknown>;
        const prefix = "erasure-v1:approve:" + row.id + ":";
        if (typeof info.approvalBinding !== "string" || !info.approvalBinding.startsWith(prefix)
          || !/^[a-f0-9]{64}$/u.test(info.approvalBinding.slice(prefix.length))
          || !await p.proofConfirmed(String(info.approvedByAccountId), String(info.approvalProofId), info.approvalBinding)) {
          return erasureError("ERASURE_APPROVAL_UNVERIFIED", "Die gesonderte Freigabe ist nicht nachweisbar.");
        }
      }
      return dto;
    },
    async challenge(actor: Actor, action: Action, requestId?: string) {
      const intent = await plan(actor, action, requestId);
      return { challenge: await p.challenge(actor, intent.binding) };
    },
    async submit(actor: Actor, action: Action, challengeId: string, requestId?: string) {
      const before = await plan(actor, action, requestId);
      await p.consume(actor, before.binding, challengeId);
      if (!await p.proofConfirmed(actor.id, challengeId, before.binding.subjectId)) {
        return erasureError("ERASURE_PROOF_UNVERIFIED", "Die Zwei-Faktor-Bestätigung ist im zentralen System nicht nachweisbar.");
      }
      const current = await plan(actor, action, requestId);
      if (current.binding.subjectId !== before.binding.subjectId) {
        return erasureError("ERASURE_PLAN_CHANGED", "Der Antrag oder die Zuordnung hat sich geändert.");
      }
      const saved = action === "request"
        ? await p.create(actor, current, challengeId)
        : await p.approve(actor, current, challengeId);
      return erasureDto(saved);
    },
  };
}

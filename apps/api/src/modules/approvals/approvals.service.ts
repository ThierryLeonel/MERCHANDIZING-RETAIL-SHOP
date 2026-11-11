import { Injectable } from "@nestjs/common";
import { APPROVAL_TYPES, ApprovalType } from "@retail/api-contracts";
import type { Tx } from "@retail/db";
import { verify } from "@node-rs/argon2";
import { AuthContext, assertBranch } from "../../common/auth-context";
import { AuditService } from "../../common/audit.service";
import { conflict, DomainError, forbidden, invalid, notFound } from "../../common/errors";
import { D, DecInput } from "../../common/money";
import { PrismaService } from "../../common/prisma.service";
import { SequenceService } from "../../common/sequence.service";
import { loadAuthContext } from "../../common/guards";

export type ApprovalHook = (tx: Tx, req: { id: string; subject_id: string | null; payload: unknown; requested_by_id: string; branch_id: string | null }, status: "APPROVED" | "REJECTED", approver: AuthContext) => Promise<void>;

@Injectable()
export class ApprovalsService {
  private hooks = new Map<string, ApprovalHook>();
  constructor(private prisma: PrismaService, private seq: SequenceService, private audit: AuditService) {}

  /** Lets a module advance its document when an approval is decided (runs in the decision transaction). */
  registerHook(type: ApprovalType, hook: ApprovalHook) {
    this.hooks.set(type, hook);
  }

  policy(tx: Tx, businessId: string, type: ApprovalType) {
    return tx.approvalPolicy.findUnique({ where: { business_id_request_type: { business_id: businessId, request_type: type } } });
  }

  /** True when the amount/percent exceeds the configured threshold (null threshold = always required). */
  async isRequired(tx: Tx, businessId: string, type: ApprovalType, opts: { amount?: DecInput; percent?: DecInput }): Promise<boolean> {
    const p = await this.policy(tx, businessId, type);
    if (!p || !p.enabled) return false;
    if (p.threshold_amount != null && opts.amount != null) return D(opts.amount).abs().greaterThan(p.threshold_amount);
    if (p.threshold_percent != null && opts.percent != null) return D(opts.percent).greaterThan(p.threshold_percent);
    return p.threshold_amount == null && p.threshold_percent == null;
  }

  async request(
    auth: AuthContext,
    input: { type: ApprovalType; reason: string; amount?: DecInput; branchId?: string | null; subjectType?: string; subjectId?: string; payload?: object },
    tx?: Tx,
  ) {
    if (!input.reason?.trim()) throw invalid("REASON_REQUIRED", "A reason is required for approval requests");
    assertBranch(auth, input.branchId);
    const run = async (t: Tx) => {
      const number = await this.seq.next(t, auth.businessId, "APPROVAL", "APR-");
      const req = await t.approvalRequest.create({
        data: {
          business_id: auth.businessId,
          branch_id: input.branchId ?? null,
          number,
          request_type: input.type,
          subject_type: input.subjectType ?? null,
          subject_id: input.subjectId ?? null,
          amount: input.amount != null ? D(input.amount) : null,
          payload: (input.payload ?? {}) as any,
          reason: input.reason,
          requested_by_id: auth.userId,
          actions: { create: { actor_id: auth.userId, action: "REQUEST", note: input.reason } },
        },
      });
      await this.audit.record(auth, { action: "approval.requested", entityType: "approval_request", entityId: req.id, summary: `${input.type} approval requested (${number})`, data: input, branchId: input.branchId }, t);
      return req;
    };
    return tx ? run(tx) : this.prisma.tx(run);
  }

  async decide(auth: AuthContext, id: string, decision: "APPROVE" | "REJECT", note?: string) {
    return this.prisma.tx(async (tx) => {
      const req = await tx.approvalRequest.findFirst({ where: { id, business_id: auth.businessId } });
      if (!req) throw notFound("Approval request");
      if (req.status !== "PENDING") throw conflict("APPROVAL_NOT_PENDING", `Request is already ${req.status.toLowerCase()}`);
      const perm = APPROVAL_TYPES[req.request_type as ApprovalType];
      if (!perm || !auth.permissions.has(perm)) throw forbidden(`You are not authorised to decide ${req.request_type} requests`);
      assertBranch(auth, req.branch_id);
      const policy = await this.policy(tx, auth.businessId, req.request_type as ApprovalType);
      if (req.requested_by_id === auth.userId && !policy?.allow_self_approval) {
        throw forbidden("You cannot approve your own request");
      }
      const status = decision === "APPROVE" ? "APPROVED" : "REJECTED";
      const updated = await tx.approvalRequest.updateMany({
        where: { id, status: "PENDING" },
        data: { status, decided_by_id: auth.userId, decided_at: new Date(), decision_note: note ?? null },
      });
      if (updated.count !== 1) throw conflict("APPROVAL_NOT_PENDING", "Request was decided concurrently");
      await tx.approvalAction.create({ data: { approval_request_id: id, actor_id: auth.userId, action: decision, note: note ?? null } });
      const hook = this.hooks.get(req.request_type);
      if (hook) await hook(tx, req, status, auth);
      await this.audit.record(auth, { action: `approval.${status.toLowerCase()}`, entityType: "approval_request", entityId: id, summary: `${req.request_type} ${req.number} ${status.toLowerCase()}`, data: { note }, branchId: req.branch_id }, tx);
      return tx.approvalRequest.findUnique({ where: { id } });
    });
  }

  /** Supervisor override at the POS: the approver signs in on the cashier's screen. */
  async decideWithCredentials(requester: AuthContext, id: string, email: string, password: string, note?: string) {
    const user = await this.prisma.client.user.findFirst({ where: { business_id: requester.businessId, email: email.toLowerCase(), status: "ACTIVE" } });
    if (!user || !(await verify(user.password_hash, password))) throw new DomainError("INVALID_CREDENTIALS", "Approver credentials are invalid", 401);
    const session = await this.prisma.client.userSession.create({
      data: { user_id: user.id, refresh_token_hash: "supervisor-override", expires_at: new Date(Date.now() + 60_000), user_agent: "supervisor-override" },
    });
    try {
      const approverAuth = await loadAuthContext(this.prisma, user.id, session.id);
      approverAuth.ip = requester.ip;
      return await this.decide(approverAuth, id, "APPROVE", note ?? "Supervisor override at POS");
    } finally {
      await this.prisma.client.userSession.update({ where: { id: session.id }, data: { revoked_at: new Date(), revoked_reason: "single-use supervisor override" } });
    }
  }

  /**
   * Consumes an APPROVED request exactly once. The request must be of the
   * expected type, raised by the acting user, and cover the amount.
   */
  async consume(tx: Tx, auth: AuthContext, id: string, type: ApprovalType, check?: { minAmount?: DecInput; subjectId?: string }) {
    const req = await tx.approvalRequest.findFirst({ where: { id, business_id: auth.businessId } });
    if (!req) throw notFound("Approval request");
    if (req.request_type !== type) throw invalid("APPROVAL_TYPE_MISMATCH", `Approval ${req.number} is for ${req.request_type}, not ${type}`);
    if (req.status !== "APPROVED") throw invalid("APPROVAL_NOT_APPROVED", `Approval ${req.number} is ${req.status.toLowerCase()}`);
    if (req.requested_by_id !== auth.userId) throw forbidden("Approval was requested by another user");
    if (check?.minAmount != null && req.amount != null && D(check.minAmount).abs().greaterThan(D(req.amount).abs())) {
      throw invalid("APPROVAL_INSUFFICIENT", `Approval ${req.number} covers ${req.amount}, but ${check.minAmount} is needed`);
    }
    if (check?.subjectId && req.subject_id && req.subject_id !== check.subjectId) throw invalid("APPROVAL_SUBJECT_MISMATCH", "Approval was granted for a different record");
    const r = await tx.approvalRequest.updateMany({ where: { id, status: "APPROVED" }, data: { status: "CONSUMED", consumed_at: new Date() } });
    if (r.count !== 1) throw conflict("APPROVAL_ALREADY_USED", "Approval has already been used");
    await tx.approvalAction.create({ data: { approval_request_id: id, actor_id: auth.userId, action: "CONSUME" } });
    return req;
  }
}

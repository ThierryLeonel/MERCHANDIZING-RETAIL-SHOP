import { Injectable } from "@nestjs/common";
import type { Tx } from "@retail/db";
import type { AuthContext } from "./auth-context";
import { PrismaService } from "./prisma.service";
import { redact } from "./redact";
import { toJSONSafe } from "./money";

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  data?: unknown;
  branchId?: string | null;
}

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  async record(auth: Pick<AuthContext, "userId" | "businessId"> & { ip?: string }, input: AuditInput, tx?: Tx) {
    const db = tx ?? this.prisma.client;
    await db.auditEvent.create({
      data: {
        business_id: auth.businessId,
        actor_id: auth.userId,
        branch_id: input.branchId ?? null,
        action: input.action,
        entity_type: input.entityType,
        entity_id: input.entityId ?? null,
        summary: input.summary,
        data: toJSONSafe(redact(input.data ?? {})) as any,
        ip_address: auth.ip ?? null,
      },
    });
  }
}

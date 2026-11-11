import { Controller, Get, Param, ParseUUIDPipe, Post, Query, Res, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiConsumes, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { Auth, AuthContext, can, Public, RequirePermissions } from "../../common/auth-context";
import { AuditService } from "../../common/audit.service";
import { forbidden, invalid, notFound } from "../../common/errors";
import { PrismaService } from "../../common/prisma.service";
import { config } from "../../config";
import { LocalStorageAdapter, sniff } from "./storage";

const OWNER_PERMS: Record<string, string> = { product: "products.manage", expense: "expenses.manage", supplier_invoice: "payables.manage", goods_receipt: "purchasing.receive" };

@ApiTags("system")
@Controller()
export class SystemController {
  constructor(private prisma: PrismaService, private storage: LocalStorageAdapter, private audit: AuditService) {}

  @Public()
  @Get("health")
  async health() {
    const started = Date.now();
    await this.prisma.client.$queryRaw`SELECT 1`;
    const worker = await this.prisma.client.backgroundJob.findUnique({ where: { name: "worker-heartbeat" } });
    return { status: "ok", database: "ok", db_latency_ms: Date.now() - started, worker_last_seen: worker?.last_run_at ?? null, mobile_money_mode: config.mobileMoneyMode, time: new Date().toISOString() };
  }

  @ApiBearerAuth()
  @ApiConsumes("multipart/form-data")
  @Post("attachments")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: config.uploadMaxBytes, files: 1 } }))
  async upload(@Auth() a: AuthContext, @UploadedFile() file: { buffer: Buffer; originalname: string; size: number }, @Query("owner_type") ownerType: string, @Query("owner_id") ownerId?: string) {
    if (!file) throw invalid("FILE_REQUIRED", "Attach a file");
    const perm = OWNER_PERMS[ownerType];
    if (!perm) throw invalid("OWNER_TYPE", `Unsupported owner_type; use one of ${Object.keys(OWNER_PERMS).join(", ")}`);
    if (!can(a, perm as any)) throw forbidden();
    const kind = sniff(file.buffer);
    if (!kind) throw invalid("FILE_TYPE", "Only JPEG, PNG, WebP images and PDF documents are accepted");
    if (ownerType === "product" && kind.mime === "application/pdf") throw invalid("FILE_TYPE", "Product images must be JPEG, PNG or WebP");
    const key = await this.storage.put(file.buffer, kind.ext);
    const att = await this.prisma.client.attachment.create({ data: { business_id: a.businessId, owner_type: ownerType, owner_id: ownerId ?? null, storage_key: key, file_name: file.originalname.slice(0, 200).replace(/[^\w.\- ]/g, "_"), mime_type: kind.mime, size_bytes: file.size, uploaded_by_id: a.userId } });
    if (ownerType === "product" && ownerId) await this.prisma.client.product.updateMany({ where: { id: ownerId, business_id: a.businessId }, data: { image_attachment_id: att.id } });
    await this.audit.record(a, { action: "attachment.uploaded", entityType: "attachment", entityId: att.id, summary: `${kind.mime} uploaded for ${ownerType}` });
    return { id: att.id, mime_type: att.mime_type, size_bytes: att.size_bytes };
  }

  /** Private download: requires authentication and business ownership. */
  @ApiBearerAuth()
  @Get("attachments/:id")
  @RequirePermissions("products.view")
  async download(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Res() res: Response) {
    const att = await this.prisma.client.attachment.findFirst({ where: { id, business_id: a.businessId } });
    if (!att) throw notFound("Attachment");
    if (att.owner_type !== "product" && !can(a, (OWNER_PERMS[att.owner_type] ?? "admin.settings") as any) && !can(a, "reports.financial")) throw forbidden();
    const buf = await this.storage.get(att.storage_key);
    res.setHeader("Content-Type", att.mime_type);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `inline; filename="${att.file_name}"`);
    res.send(buf);
  }
}

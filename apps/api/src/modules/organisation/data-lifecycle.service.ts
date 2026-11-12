import {
  BadRequestException,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { canConfigureOrganisation } from "@astrama/domain";
import { dataPolicySchema, defaultDataPolicy, type DataPolicy } from "@astrama/contracts";
import { AuthRequest, type AuthContext, SessionGuard } from "../auth/auth.service.js";
import { Database, lockConfiguration, type Tx } from "../../database.js";

export async function readDataPolicy(tx: Tx, tenantId: string): Promise<DataPolicy> {
  const [row] = await tx.$queryRaw<
    { policy: unknown; revision: number }[]
  >`SELECT policy,revision FROM tenant_data_policies WHERE tenant_id=${tenantId}::uuid`;
  return row
    ? dataPolicySchema.parse({ ...(row.policy as object), revision: row.revision })
    : structuredClone(defaultDataPolicy);
}
export function checkAttachmentPolicy(
  policy: DataPolicy,
  filename: string,
  size: number,
  count = 0,
  total = 0,
) {
  const rule = policy.attachments,
    extension = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
  if (
    size > rule.maxFileBytes ||
    count >= rule.maxFilesPerTicket ||
    total + size > rule.maxTotalBytes
  )
    throw new BadRequestException("This file exceeds the organisation attachment limits");
  if (rule.allowedExtensions.length && !rule.allowedExtensions.includes(extension))
    throw new BadRequestException("This file extension is not allowed by the organisation");
}
@Injectable()
export class DataPolicyService {
  constructor(private readonly db: Database) {}
  private async run<T>(auth: AuthContext, work: (tx: Tx) => Promise<T>) {
    if (!canConfigureOrganisation({ ...auth, mfaVerified: auth.view.mfaVerified }))
      throw new ForbiddenException("MFA-verified administrator required");
    return this.db.withTenant(auth.tenantId, async (tx) => {
      await lockConfiguration(tx, auth.tenantId);
      const user = await tx.user.findFirst({
        where: {
          tenantId: auth.tenantId,
          id: auth.id,
          active: true,
          role: "admin",
          mfaEnrolled: true,
        },
      });
      const session = await tx.session.findFirst({
        where: {
          tenantId: auth.tenantId,
          userId: auth.id,
          id: auth.sessionId,
          mfaVerified: true,
          expiresAt: { gt: new Date() },
        },
      });
      if (!user || !session) throw new ForbiddenException("MFA-verified administrator required");
      return work(tx);
    });
  }
  get(auth: AuthContext) {
    return this.run(auth, (tx) => readDataPolicy(tx, auth.tenantId));
  }
  async set(auth: AuthContext, body: unknown) {
    const input = dataPolicySchema.parse(body);
    return this.run(auth, async (tx) => {
      const before = await readDataPolicy(tx, auth.tenantId);
      if (before.revision !== input.revision)
        throw new ConflictException("Data policy changed. Refresh and try again.");
      const after = { ...input, revision: input.revision + 1 };
      await tx.$executeRaw`INSERT INTO tenant_data_policies(tenant_id,revision,policy) VALUES(${auth.tenantId}::uuid,${after.revision},${JSON.stringify(after)}::jsonb) ON CONFLICT(tenant_id) DO UPDATE SET revision=EXCLUDED.revision,policy=EXCLUDED.policy`;
      await tx.configAudit.create({
        data: {
          tenantId: auth.tenantId,
          actorId: auth.id,
          entityId: auth.tenantId,
          action: "data_policy.updated",
          detail: { before, after },
        },
      });
      return after;
    });
  }
}
@Controller("admin/data-policy")
@UseGuards(SessionGuard)
export class DataPolicyController {
  constructor(private readonly policies: DataPolicyService) {}
  @Get() get(@Req() req: AuthRequest) {
    return this.policies.get(req.auth);
  }
  @Post() set(@Req() req: AuthRequest) {
    return this.policies.set(req.auth, req.body);
  }
}

import {
  BadRequestException,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { retentionClasses, operatorActionSchema, operatorPlanSchema } from "@astrama/contracts";
import { Database } from "./database.js";
import {
  currentOperator,
  operatorAudit,
  operatorSupportAccess,
  withOperatorTenant,
} from "./operator-access.js";
import {
  OperatorGuard,
  type OperatorRequest,
  type OperatorSessionContext,
} from "./operator-auth.js";
import { operationalHealth } from "./operations.js";
import { queueUserInvitation, occupiedSeats } from "./modules/users/users.service.js";
import { readDataPolicy } from "./modules/organisation/data-lifecycle.service.js";
import { paymentProvider } from "./modules/billing/payment-provider.js";
import { reserveTenantBudget } from "./tenant-budgets.js";

@Injectable()
export class OperatorConsoleService {
  constructor(private readonly db: Database) {}
  organisations(auth: OperatorSessionContext, query: unknown) {
    const { search } = z
      .object({ search: z.string().trim().max(160).default("") })
      .strict()
      .parse(query);
    return this.db.$transaction(async (tx) => {
      await currentOperator(tx, auth);
      const [row] = await tx.$queryRaw<{ data: unknown }[]>`
        SELECT operator_organisation_metadata(${auth.id}::uuid,${search},NULL) AS data`;
      await operatorAudit(tx, auth.id, null, "organisations.viewed", "Operator console view");
      return row!.data;
    });
  }
  organisation(auth: OperatorSessionContext, tenantId: string) {
    return withOperatorTenant(
      this.db,
      auth,
      tenantId,
      false,
      async (tx, tenant) => {
        const [row] = await tx.$queryRaw<{ data: unknown[] }[]>`
        SELECT operator_organisation_metadata(${auth.id}::uuid,'',${tenant.id}::uuid) AS data`;
        await operatorAudit(tx, auth.id, tenant, "organisation.viewed", "Operator console view");
        return row!.data[0];
      },
      true,
    );
  }
  async health(auth: OperatorSessionContext) {
    await this.db.$transaction(async (tx) => {
      await currentOperator(tx, auth);
      await operatorAudit(tx, auth.id, null, "health.viewed", "Operator console view");
    });
    return operationalHealth(this.db);
  }
  plans(auth: OperatorSessionContext) {
    return this.db.$transaction(async (tx) => {
      await currentOperator(tx, auth);
      const [row] = await tx.$queryRaw<
        { data: unknown }[]
      >`SELECT operator_billing_plans(${auth.id}::uuid) AS data`;
      await operatorAudit(tx, auth.id, null, "billing.plans_viewed", "Operator console view");
      return row!.data;
    });
  }
  async savePlan(auth: OperatorSessionContext, body: unknown) {
    const { reason, ...plan } = operatorPlanSchema.parse(body);
    await this.db.$transaction(async (tx) => {
      if ((await currentOperator(tx, auth)).role !== "owner")
        throw new ForbiddenException("Owner operator required");
    });
    if (plan.active)
      await paymentProvider().validatePrice(plan.stripePriceId, plan.billingInterval);
    try {
      await this.db.$transaction(async (tx) => {
        if ((await currentOperator(tx, auth)).role !== "owner")
          throw new ForbiddenException("Owner operator required");
        await tx.$executeRaw`SELECT operator_save_billing_plan(${auth.id}::uuid,${reason},${JSON.stringify(plan)}::jsonb)`;
      });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "meta" in error &&
        ["23505", "23514"].includes(String((error.meta as { code?: string })?.code))
      )
        throw new ConflictException(
          "Plan already exists or its assigned commercial terms changed. Create a new plan ID.",
        );
      throw error;
    }
    return { ok: true };
  }
  jobs(auth: OperatorSessionContext, tenantId: string) {
    return withOperatorTenant(
      this.db,
      auth,
      tenantId,
      false,
      async (tx, tenant) => {
        await operatorAudit(tx, auth.id, tenant, "jobs.viewed", "Operator console view");
        return tx.operatorJob.findMany({
          where: { tenantId: tenant.id },
          orderBy: { createdAt: "desc" },
          take: 50,
          select: {
            id: true,
            kind: true,
            status: true,
            createdAt: true,
            completedAt: true,
            lastError: true,
          },
        });
      },
      true,
    );
  }
  action(auth: OperatorSessionContext, tenantId: string, body: unknown, idempotency: unknown) {
    const input = operatorActionSchema.parse(body);
    return withOperatorTenant(
      this.db,
      auth,
      tenantId,
      true,
      async (tx, initial, operator) => {
        await tx.$queryRaw`SELECT id FROM tenants WHERE id=${initial.id}::uuid FOR UPDATE`;
        const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: initial.id } });
        if (tenant.status === "deleted")
          throw new ForbiddenException("Organisation deletion is already underway");
        if (
          ["set-plan", "suspend", "reactivate", "extend-retention", "schedule-deletion"].includes(
            input.action,
          ) &&
          operator.role !== "owner"
        )
          throw new ForbiddenException("Owner operator required");
        if (
          input.action === "export" ||
          input.action === "mfa-recovery" ||
          input.action === "set-plan"
        ) {
          const jobId = z.string().uuid().parse(idempotency);
          const payload: Record<string, unknown> = {
            input,
            expectedPlanId: tenant.planId,
            expectedSubscriptionId: tenant.stripeSubscriptionId,
          };
          const [retry] = await tx.$queryRaw<{ id: string; status: string }[]>`
          SELECT id,status FROM operator_jobs WHERE id=${jobId}::uuid AND operator_id=${auth.id}::uuid
            AND tenant_id=${tenant.id}::uuid AND kind=${input.action} AND reason=${input.reason}
            AND payload->'input'=${JSON.stringify(input)}::jsonb`;
          if (retry) return { ok: true, jobId: retry.id, status: retry.status };
          if (tenant.revision !== input.revision)
            throw new ConflictException("Organisation changed. Refresh before submitting again.");
          if (input.action === "export") {
            if (!tenant.active) throw new ForbiddenException("Organisation is unavailable");
            await operatorSupportAccess(tx, auth.id, tenant.id);
            await reserveTenantBudget(tx, tenant.id, "exports");
          } else if (input.action === "mfa-recovery") {
            const admin = await tx.user.findFirst({
              where: {
                id: input.userId,
                tenantId: tenant.id,
                role: "admin",
                active: true,
                mfaEnrolled: true,
              },
            });
            if (!tenant.active || !admin)
              throw new BadRequestException("An active enrolled administrator is required");
            payload.expectedUserRevision = admin.revision;
            payload.expectedUserEmail = admin.email;
          } else {
            const plan = await tx.billingPlan.findFirst({
              where: { id: input.planId, active: true },
            });
            if (!plan) throw new NotFoundException("Active plan not found");
            if (input.seatLimit < (await occupiedSeats(tx, tenant.id)))
              throw new ConflictException("Seat limit is below occupied and reserved seats");
          }
          const inserted =
            await tx.$executeRaw`INSERT INTO operator_jobs(id,operator_id,tenant_id,tenant_slug,kind,reason,payload)
          VALUES(${jobId}::uuid,${auth.id}::uuid,${tenant.id}::uuid,${tenant.slug},${input.action},${input.reason},${JSON.stringify(payload)}::jsonb)
          ON CONFLICT(id) DO NOTHING`;
          if (!inserted)
            throw new ConflictException("Idempotency key was already used for another action");
          await operatorAudit(
            tx,
            auth.id,
            tenant,
            `operator.${input.action}.requested`,
            input.reason,
            { jobId },
          );
          return { ok: true, jobId, status: "queued" };
        }
        if (tenant.revision !== input.revision)
          throw new ConflictException("Organisation changed. Refresh before submitting again.");
        if (input.action === "resend-invite") {
          const admin = await tx.user.findFirst({
            where: { id: input.userId, tenantId: tenant.id, role: "admin", active: false },
          });
          if (!tenant.active || !admin)
            throw new BadRequestException("An inactive invited administrator is required");
          if (!["trial", "active"].includes(tenant.status))
            throw new ForbiddenException(
              "Restore organisation write access before sending invitations",
            );
          await queueUserInvitation(tx, tenant.id, admin);
        } else if (input.action === "extend-trial") {
          if (
            !(
              tenant.status === "trial" ||
              (tenant.status === "read_only" && tenant.readOnlyReason === "trial_ended")
            ) ||
            input.trialEndsAt <= new Date() ||
            (tenant.trialEndsAt && input.trialEndsAt <= tenant.trialEndsAt)
          )
            throw new BadRequestException("Choose a later trial end for a trial organisation");
          await tx.tenant.update({
            where: { id: tenant.id },
            data: {
              status: "trial",
              trialEndsAt: input.trialEndsAt,
              readOnlyReason: null,
              readOnlySince: null,
              deleteAfter: null,
              revision: { increment: 1 },
            },
          });
        } else if (input.action === "suspend" || input.action === "reactivate") {
          const liftOperatorHold =
            input.action === "reactivate" &&
            tenant.status === "read_only" &&
            tenant.readOnlyReason === "operator";
          await tx.tenant.update({
            where: { id: tenant.id },
            data: {
              active: input.action === "reactivate",
              revision: { increment: 1 },
              ...(liftOperatorHold
                ? { status: "active", readOnlyReason: null, readOnlySince: null, deleteAfter: null }
                : {}),
            },
          });
          if (input.action === "suspend")
            await tx.session.deleteMany({ where: { tenantId: tenant.id } });
        } else {
          if (input.deleteAfter <= new Date())
            throw new BadRequestException("Choose a future deletion date");
          if (input.action === "extend-retention") {
            if (
              tenant.status !== "read_only" ||
              !tenant.deleteAfter ||
              input.deleteAfter <= tenant.deleteAfter
            )
              throw new BadRequestException(
                "Choose a later deletion date for a read-only organisation",
              );
            await tx.tenant.update({
              where: { id: tenant.id },
              data: { deleteAfter: input.deleteAfter, revision: { increment: 1 } },
            });
          } else {
            if (input.expectedSlug !== tenant.slug)
              throw new BadRequestException("Type the organisation slug exactly");
            const policy = await readDataPolicy(tx, tenant.id);
            if (
              policy.legalHold ||
              retentionClasses.some((kind) => policy.retention[kind].legalHold)
            )
              throw new ConflictException("Legal hold blocks deletion scheduling");
            await tx.tenant.update({
              where: { id: tenant.id },
              data: {
                status: "read_only",
                readOnlyReason: "operator",
                readOnlySince: tenant.readOnlySince ?? new Date(),
                deleteAfter: input.deleteAfter,
                revision: { increment: 1 },
              },
            });
          }
        }
        const after = await tx.tenant.findUniqueOrThrow({
          where: { id: tenant.id },
          select: {
            active: true,
            status: true,
            trialEndsAt: true,
            deleteAfter: true,
            revision: true,
          },
        });
        await operatorAudit(tx, auth.id, tenant, `operator.${input.action}`, input.reason, {
          before: {
            active: tenant.active,
            status: tenant.status,
            trialEndsAt: tenant.trialEndsAt,
            deleteAfter: tenant.deleteAfter,
            revision: tenant.revision,
          },
          after,
          ...("userId" in input ? { userId: input.userId } : {}),
        });
        return { ok: true };
      },
      true,
    );
  }
}

@Controller("operator")
@UseGuards(OperatorGuard)
export class OperatorConsoleController {
  constructor(private readonly service: OperatorConsoleService) {}
  @Get("organisations") list(@Req() req: OperatorRequest, @Query() query: unknown) {
    return this.service.organisations(req.operator, query);
  }
  @Get("organisations/:id") get(@Req() req: OperatorRequest, @Param("id") id: string) {
    return this.service.organisation(req.operator, id);
  }
  @Get("organisations/:id/jobs") jobs(@Req() req: OperatorRequest, @Param("id") id: string) {
    return this.service.jobs(req.operator, id);
  }
  @Post("organisations/:id/actions") action(@Req() req: OperatorRequest, @Param("id") id: string) {
    return this.service.action(req.operator, id, req.body, req.headers["idempotency-key"]);
  }
  @Get("health") health(@Req() req: OperatorRequest) {
    return this.service.health(req.operator);
  }
  @Get("plans") plans(@Req() req: OperatorRequest) {
    return this.service.plans(req.operator);
  }
  @Post("plans") savePlan(@Req() req: OperatorRequest) {
    return this.service.savePlan(req.operator, req.body);
  }
}

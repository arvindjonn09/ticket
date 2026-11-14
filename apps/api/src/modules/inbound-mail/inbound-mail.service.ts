import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { Controller, Get, Headers, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Prisma, type InboundMailSettings as MailSettings, type Ticket } from "@prisma/client";
import { randomBytes, randomUUID } from "node:crypto";
import sanitizeHtml from "sanitize-html";
import { effectiveDepartment } from "@astrama/domain";
import {
  Database,
  lockConfiguration,
  lockConfigurationExclusive,
  type Tx,
} from "../../database.js";
import { decryptSecret, encryptSecret } from "../../mfa.js";
import { maxFileBytes, scanFile } from "../attachments/attachments.service.js";
import { checkAttachmentPolicy, readDataPolicy } from "../organisation/data-lifecycle.service.js";
import { TicketsService } from "../tickets/tickets.service.js";
import { makeSlaSnapshot } from "../sla/sla.policy.js";
import { SessionGuard, type AuthRequest } from "../auth/auth.service.js";
import {
  emailCategorySelectionSchema,
  inboundMailAddressSchema,
  inboundMailSettingsSchema,
} from "@astrama/contracts";
import type { AuthContext } from "../auth/auth.service.js";
import {
  isLoopMessage,
  notificationDeliveryId,
  recipientAddress,
  replyTokenHash,
  senderHash,
  TestInboundAdapter,
  validWebhookSignature,
  type InboundMessageInput,
} from "./inbound-mail.adapter.js";

const appHost = process.env.APP_ORIGIN ? new URL(process.env.APP_ORIGIN).hostname : "";
const allowedHtml = {
  allowedTags: ["p", "br", "strong", "em", "ul", "ol", "li", "blockquote", "a"],
  allowedAttributes: { a: ["href"] },
  allowedSchemes: ["http", "https", "mailto"],
};
const terminalMailStates = ["Complete", "Cancelled", "Rejected"];

export function collapseQuotedHistory(text: string) {
  return text
    .split(
      /\n(?:On .{1,200}wrote:|_{5,}\s*Forwarded message\s*_{5,}|-{5,}\s*Original Message\s*-{5,})/i,
      1,
    )[0]!
    .trim();
}

@Injectable()
export class InboundMailService {
  private readonly storage = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: true,
    ...(process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY
      ? {
          credentials: {
            accessKeyId: process.env.S3_ACCESS_KEY,
            secretAccessKey: process.env.S3_SECRET_KEY,
          },
        }
      : {}),
  });

  constructor(
    private readonly db: Database,
    private readonly tickets: TicketsService,
  ) {}

  private async admin<T>(auth: AuthContext, work: (tx: Tx) => Promise<T>): Promise<T> {
    if (auth.role !== "admin" || !auth.view.mfaVerified)
      throw new ForbiddenException("MFA-verified administrator required");
    return this.db.withTenant(auth.tenantId, async (tx) => {
      await lockConfigurationExclusive(tx, auth.tenantId);
      const [user, session] = await Promise.all([
        tx.user.findFirst({
          where: { tenantId: auth.tenantId, id: auth.id, active: true, role: "admin" },
        }),
        tx.session.findFirst({
          where: {
            tenantId: auth.tenantId,
            id: auth.sessionId,
            userId: auth.id,
            mfaVerified: true,
            expiresAt: { gt: new Date() },
          },
        }),
      ]);
      if (!user || !session) throw new ForbiddenException("MFA-verified administrator required");
      return work(tx);
    });
  }

  async settings(auth: AuthContext) {
    return this.admin(auth, async (tx) => {
      const [settings, addresses, departments, categories] = await Promise.all([
        tx.inboundMailSettings.findUnique({ where: { tenantId: auth.tenantId } }),
        tx.inboundMailAddress.findMany({
          where: { tenantId: auth.tenantId },
          orderBy: { address: "asc" },
        }),
        tx.department.findMany({
          where: { tenantId: auth.tenantId, active: true },
          select: { id: true, name: true },
        }),
        tx.category.findMany({
          where: { tenantId: auth.tenantId, active: true, sensitive: false },
          select: { id: true, name: true, departmentId: true },
        }),
      ]);
      return {
        revision: settings?.revision ?? 0,
        configured: !!settings,
        secretConfigured: !!settings?.encryptedWebhookSecret,
        triageDepartmentId: settings?.triageDepartmentId ?? null,
        triageCategoryId: settings?.triageCategoryId ?? null,
        allowUnverifiedSenders: settings?.allowUnverifiedSenders ?? false,
        addresses,
        departments,
        categories,
      };
    });
  }

  async saveSettings(auth: AuthContext, input: unknown) {
    const value = inboundMailSettingsSchema.parse(input);
    return this.admin(auth, async (tx) => {
      const prior = await tx.inboundMailSettings.findUnique({ where: { tenantId: auth.tenantId } });
      if ((prior?.revision ?? 0) !== value.revision)
        throw new ConflictException("Inbound mail settings changed; refresh and retry");
      const [department, category, staffed] = await Promise.all([
        tx.department.findFirst({
          where: {
            tenantId: auth.tenantId,
            id: value.triageDepartmentId,
            active: true,
            isTriage: true,
          },
        }),
        tx.category.findFirst({
          where: {
            tenantId: auth.tenantId,
            id: value.triageCategoryId,
            active: true,
            sensitive: false,
          },
        }),
        tx.membership.count({
          where: {
            tenantId: auth.tenantId,
            departmentId: value.triageDepartmentId,
            user: { active: true, role: "agent" },
          },
        }),
      ]);
      if (!department || !category || !staffed)
        throw new BadRequestException(
          "Choose an active triage queue, general category, and staffed group",
        );
      return tx.inboundMailSettings.upsert({
        where: { tenantId: auth.tenantId },
        create: {
          tenantId: auth.tenantId,
          triageDepartmentId: department.id,
          triageCategoryId: category.id,
          allowUnverifiedSenders: value.allowUnverifiedSenders,
        },
        update: {
          revision: { increment: 1 },
          triageDepartmentId: department.id,
          triageCategoryId: category.id,
          allowUnverifiedSenders: value.allowUnverifiedSenders,
        },
      });
    });
  }

  async rotateSecret(auth: AuthContext) {
    return this.admin(auth, async (tx) => {
      const settings = await tx.inboundMailSettings.findUnique({
        where: { tenantId: auth.tenantId },
      });
      if (!settings) throw new ConflictException("Save inbound mail settings first");
      const secret = randomBytes(32).toString("hex");
      await tx.inboundMailSettings.update({
        where: { tenantId: auth.tenantId },
        data: {
          revision: { increment: 1 },
          encryptedWebhookSecret: encryptSecret(secret, `inbound-mail:${auth.tenantId}`),
        },
      });
      return { secret };
    });
  }

  async saveAddress(auth: AuthContext, input: unknown) {
    const value = inboundMailAddressSchema.parse(input);
    return this.admin(auth, async (tx) => {
      const [settings, department, category, staffed] = await Promise.all([
        tx.inboundMailSettings.findUnique({ where: { tenantId: auth.tenantId } }),
        tx.department.findFirst({
          where: { tenantId: auth.tenantId, id: value.departmentId, active: true },
        }),
        tx.category.findFirst({
          where: { tenantId: auth.tenantId, id: value.categoryId, active: true, sensitive: false },
        }),
        tx.membership.count({
          where: {
            tenantId: auth.tenantId,
            departmentId: value.departmentId,
            user: { active: true, role: "agent" },
          },
        }),
      ]);
      if (
        !settings ||
        !department ||
        !category ||
        !staffed ||
        effectiveDepartment(category.departmentId, null) !== department.id
      )
        throw new BadRequestException(
          "Choose a configured tenant, active department, matching category, and staffed group",
        );
      if (
        value.isGeneral &&
        (department.id !== settings.triageDepartmentId ||
          value.categoryId !== settings.triageCategoryId)
      )
        throw new BadRequestException(
          "The general address must route to the configured triage queue and category",
        );
      if (value.id) {
        const prior = await tx.inboundMailAddress.findFirst({
          where: { tenantId: auth.tenantId, id: value.id },
        });
        if (!prior || prior.revision !== value.revision)
          throw new ConflictException("Address changed; refresh and retry");
        return tx.inboundMailAddress.update({
          where: { id: prior.id },
          data: {
            address: value.address,
            departmentId: department.id,
            categoryId: category.id,
            isGeneral: value.isGeneral,
            active: value.active,
            revision: { increment: 1 },
          },
        });
      }
      return tx.inboundMailAddress.create({
        data: {
          tenantId: auth.tenantId,
          address: value.address,
          departmentId: department.id,
          categoryId: category.id,
          isGeneral: value.isGeneral,
          active: value.active,
        },
      });
    });
  }

  async emailCategories(auth: AuthContext, ticketId: string) {
    return this.tickets.scoped(auth, async (tx, actor) => {
      const ticket = await this.tickets.record(tx, actor, ticketId);
      if (ticket.callerId !== actor.id || !ticket.inboundSenderEmail || ticket.inboundUnverified)
        throw new NotFoundException("Ticket not found");
      const categories = await tx.category.findMany({
        where: { tenantId: actor.tenantId, active: true, sensitive: false, allowIncidents: true },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      });
      return { categories };
    });
  }

  async chooseEmailCategory(auth: AuthContext, ticketId: string, input: unknown) {
    const value = emailCategorySelectionSchema.parse(input);
    return this.tickets.scoped(auth, async (tx, actor) => {
      const ticket = await this.tickets.record(tx, actor, ticketId);
      if (ticket.callerId !== actor.id || !ticket.inboundSenderEmail || ticket.inboundUnverified)
        throw new NotFoundException("Ticket not found");
      if (ticket.revision !== value.revision)
        throw new ConflictException({
          message: "Ticket changed; refresh and retry.",
          current: await this.tickets.detail(tx, actor, ticket),
        });
      const category = await tx.category.findFirst({
        where: {
          tenantId: actor.tenantId,
          id: value.categoryId,
          active: true,
          sensitive: false,
          allowIncidents: true,
        },
      });
      if (!category)
        throw new BadRequestException("Choose an active, non-sensitive incident category");
      const departmentId = effectiveDepartment(category.departmentId, null);
      const [department, staffed] = await Promise.all([
        tx.department.findFirst({
          where: { tenantId: actor.tenantId, id: departmentId, active: true, isTriage: false },
        }),
        tx.membership.count({
          where: { tenantId: actor.tenantId, departmentId, user: { active: true, role: "agent" } },
        }),
      ]);
      if (!department || !staffed)
        throw new BadRequestException("The selected category is not currently staffed");
      await tx.ticket.update({
        where: { id: ticket.id },
        data: {
          categoryId: category.id,
          departmentId,
          assignedToId: null,
          untriaged: false,
          revision: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      await tx.audit.create({
        data: {
          tenantId: actor.tenantId,
          ticketId: ticket.id,
          actorId: actor.id,
          action: "ticket.email_category_selected",
          detail: { oldDepartmentId: ticket.departmentId, departmentId, categoryId: category.id },
        },
      });
      await tx.outbox.create({
        data: {
          tenantId: actor.tenantId,
          ticketId: ticket.id,
          event: "ticket.routed",
          payload: { audience: "internal", kind: "inbound_routed" },
        },
      });
      return this.tickets.detail(tx, actor, await this.tickets.record(tx, actor, ticket.id));
    });
  }

  async accept(input: unknown, timestamp: string, signature: string) {
    const message = TestInboundAdapter.normalize(input);
    const destination = recipientAddress(message.recipient);
    const [lookup] = await this.db.$queryRaw<{ tenant_id: string; address_id: string | null }[]>`
      SELECT tenant_id,address_id FROM resolve_inbound_address(${destination.address})
    `;
    if (!lookup) return { accepted: true };
    return this.db.withTenant(lookup.tenant_id, async (tx) => {
      const settings = await tx.inboundMailSettings.findUnique({
        where: { tenantId: lookup.tenant_id },
      });
      if (!settings?.encryptedWebhookSecret)
        throw new UnauthorizedException("Webhook is not configured");
      const secret = decryptSecret(
        settings.encryptedWebhookSecret,
        `inbound-mail:${lookup.tenant_id}`,
      );
      if (!validWebhookSignature(timestamp, message, signature, secret))
        throw new UnauthorizedException("Invalid inbound signature");
      if (
        await tx.inboundMessage.findUnique({
          where: {
            tenantId_messageId: { tenantId: lookup.tenant_id, messageId: message.messageId },
          },
          select: { id: true },
        })
      )
        return { accepted: true };

      const ownAddresses = (
        await tx.inboundMailAddress.findMany({
          where: { tenantId: lookup.tenant_id },
          select: { address: true },
        })
      ).map((row) => row.address);
      const loop = isLoopMessage(message, ownAddresses, appHost);
      if (!loop) {
        const [limit] = await tx.$queryRaw<{ message_count: number }[]>`
          INSERT INTO inbound_sender_rates(tenant_id,sender_hash,window_started_at,message_count)
          VALUES(${lookup.tenant_id}::uuid,${senderHash(message.sender)},now(),1)
          ON CONFLICT(tenant_id,sender_hash) DO UPDATE SET
            window_started_at=CASE WHEN inbound_sender_rates.window_started_at<=now()-interval '1 hour' THEN now() ELSE inbound_sender_rates.window_started_at END,
            message_count=CASE WHEN inbound_sender_rates.window_started_at<=now()-interval '1 hour' THEN 1 ELSE inbound_sender_rates.message_count+1 END
          RETURNING message_count
        `;
        if ((limit?.message_count ?? 21) > 20) return { accepted: true };
      }
      const attachmentBytes = message.attachments.reduce(
        (sum, file) => sum + Buffer.from(file.contentBase64, "base64").byteLength,
        0,
      );
      if (attachmentBytes > maxFileBytes)
        throw new BadRequestException("Email attachments exceed 5 MiB");
      await tx.inboundMessage.create({
        data: {
          tenantId: lookup.tenant_id,
          messageId: message.messageId,
          recipient: message.recipient,
          senderEmail: message.sender,
          inReplyTo: message.inReplyTo,
          references: message.references,
          replyTokenHash: destination.token ? replyTokenHash(destination.token) : null,
          kind: message.kind,
          bounceFor: message.bounceFor,
          subject: message.subject,
          textBody: message.text,
          htmlBody: message.html ? sanitizeHtml(message.html, allowedHtml) : null,
          headers: message.headers as Prisma.InputJsonValue,
          authResults: message.authResults as Prisma.InputJsonValue,
          attachments: message.attachments as unknown as Prisma.InputJsonValue,
          status: loop ? "ignored" : "queued",
        },
      });
      return { accepted: true };
    });
  }

  async dispatch() {
    while (true) {
      const messages = await this.db.$queryRaw<{ tenant_id: string; id: string }[]>`
        SELECT * FROM pending_inbound_messages()
      `;
      if (!messages.length) return;
      for (const message of messages) await this.process(message.tenant_id, message.id);
    }
  }

  private async process(tenantId: string, id: string) {
    const uploaded: string[] = [];
    try {
      await this.db.withTenant(tenantId, async (tx) => {
        await lockConfiguration(tx, tenantId);
        const message = await tx.inboundMessage.findFirst({ where: { tenantId, id } });
        if (!message || !["queued", "failed"].includes(message.status)) return;
        await tx.inboundMessage.update({
          where: { id },
          data: { status: "processing", attempts: { increment: 1 } },
        });
        if (message.kind === "bounce") {
          const deliveryId = message.bounceFor ? notificationDeliveryId(message.bounceFor) : null;
          if (deliveryId)
            await tx.notificationDelivery.updateMany({
              where: { tenantId, id: deliveryId },
              data: { status: "skipped", lastError: "Delivery bounce received" },
            });
          await this.finishMessage(tx, tenantId, id, null, []);
          return;
        }
        const settings = await tx.inboundMailSettings.findUnique({ where: { tenantId } });
        if (!settings) {
          await this.finishMessage(tx, tenantId, id, null, [], "ignored");
          return;
        }
        const sender = await tx.user.findFirst({
          where: { tenantId, email: message.senderEmail, active: true },
        });
        const auth = message.authResults as { spf: string; dkim: string; dmarc: string };
        const verified =
          !!sender && auth.spf === "pass" && auth.dkim === "pass" && auth.dmarc === "pass";
        if (!sender && !settings.allowUnverifiedSenders) {
          await this.finishMessage(tx, tenantId, id, null, [], "ignored");
          return;
        }
        const correlation =
          verified && sender ? await this.correlatedTicket(tx, tenantId, message, sender.id) : null;
        if (correlation && !terminalMailStates.includes(correlation.state)) {
          const participant = await this.isParticipant(tx, tenantId, correlation, sender!.id);
          if (participant) {
            await tx.activity.create({
              data: {
                tenantId,
                ticketId: correlation.id,
                authorId: sender!.id,
                body: collapseQuotedHistory(message.textBody),
                audience: "customer",
              },
            });
            await tx.ticket.update({
              where: { id: correlation.id },
              data: { revision: { increment: 1 }, updatedAt: new Date() },
            });
            await tx.audit.create({
              data: {
                tenantId,
                ticketId: correlation.id,
                actorId: sender!.id,
                action: "ticket.email_reply",
                detail: { inboundMessageId: id },
              },
            });
            await tx.outbox.create({
              data: {
                tenantId,
                ticketId: correlation.id,
                event: "ticket.message",
                payload: { audience: "customer", inbound: true },
              },
            });
            const attachments = await this.addAttachments(
              tx,
              tenantId,
              correlation,
              this.asInput(message),
              sender!.id,
              "customer",
              uploaded,
            );
            await this.finishMessage(tx, tenantId, id, correlation.id, attachments);
            return;
          }
        }
        const route = verified
          ? await this.route(tx, tenantId, message.recipient, settings)
          : await this.triageRoute(tx, tenantId, settings);
        const actorId =
          verified && sender
            ? sender.id
            : await this.triageReporter(tx, tenantId, route.departmentId);
        const source =
          correlation && terminalMailStates.includes(correlation.state) ? correlation : null;
        const created = await this.createInboundTicket(tx, {
          tenantId,
          actorId,
          message: this.asInput(message),
          categoryId: source?.categoryId ?? route.categoryId,
          departmentId: source?.departmentId ?? route.departmentId,
          replyAddress: recipientAddress(message.recipient).address,
          unverified: !verified,
          duplicateOfId: source?.id ?? null,
          routingException: route.exception,
          messageRowId: id,
          uploaded,
        });
        await this.finishMessage(tx, tenantId, id, created.ticket.id, created.attachments);
      });
    } catch {
      for (const key of uploaded)
        await this.storage
          .send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }))
          .catch(() => undefined);
      await this.db.withTenant(tenantId, async (tx) => {
        const message = await tx.inboundMessage.findFirst({ where: { tenantId, id } });
        if (!message || message.status === "processed" || message.status === "ignored") return;
        const attempts = message.attempts + 1;
        await tx.inboundMessage.update({
          where: { id },
          data: {
            status: attempts >= 8 ? "ignored" : "failed",
            attempts,
            ...(attempts >= 8 ? { attachments: [] } : {}),
            nextAttemptAt: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** attempts)),
            lastError: "Inbound message processing failed",
          },
        });
      });
    }
  }

  private async finishMessage(
    tx: Tx,
    tenantId: string,
    id: string,
    ticketId: string | null,
    attachments: Prisma.InputJsonValue,
    status = "processed",
  ) {
    await tx.inboundMessage.update({
      where: { id },
      data: { status, ticketId, attachments, processedAt: new Date(), lastError: null },
    });
  }

  private asInput(message: {
    kind: string;
    messageId: string;
    recipient: string;
    senderEmail: string;
    inReplyTo: string | null;
    references: string[];
    bounceFor: string | null;
    subject: string;
    textBody: string;
    htmlBody: string | null;
    headers: Prisma.JsonValue;
    authResults: Prisma.JsonValue;
    attachments: Prisma.JsonValue;
  }): InboundMessageInput {
    return {
      kind: message.kind === "bounce" ? "bounce" : "delivery",
      messageId: message.messageId,
      recipient: message.recipient,
      sender: message.senderEmail,
      inReplyTo: message.inReplyTo ?? undefined,
      references: message.references,
      bounceFor: message.bounceFor ?? undefined,
      subject: message.subject,
      text: message.textBody,
      html: message.htmlBody ?? undefined,
      headers: message.headers as InboundMessageInput["headers"],
      authResults: message.authResults as InboundMessageInput["authResults"],
      attachments: message.attachments as InboundMessageInput["attachments"],
    };
  }

  private async triageRoute(tx: Tx, tenantId: string, settings: MailSettings) {
    const triageDepartment = await tx.department.findFirst({
      where: { tenantId, id: settings.triageDepartmentId, active: true, isTriage: true },
    });
    const triageCategory = await tx.category.findFirst({
      where: { tenantId, id: settings.triageCategoryId, active: true, sensitive: false },
    });
    if (!triageDepartment || !triageCategory) throw new Error("Triage routing is unavailable");
    return { departmentId: triageDepartment.id, categoryId: triageCategory.id, exception: false };
  }

  private async route(tx: Tx, tenantId: string, recipient: string, settings: MailSettings) {
    const triage = await this.triageRoute(tx, tenantId, settings);
    const baseAddress = recipientAddress(recipient).address;
    const mapping = await tx.inboundMailAddress.findFirst({
      where: { tenantId, address: baseAddress, active: true },
    });
    if (!mapping || mapping.isGeneral) return { ...triage, exception: !mapping };
    const [department, category, memberCount] = await Promise.all([
      tx.department.findFirst({ where: { tenantId, id: mapping.departmentId, active: true } }),
      tx.category.findFirst({
        where: { tenantId, id: mapping.categoryId, active: true, sensitive: false },
      }),
      tx.membership.count({
        where: {
          tenantId,
          departmentId: mapping.departmentId,
          user: { active: true, role: "agent" },
        },
      }),
    ]);
    if (
      !department ||
      !category ||
      !memberCount ||
      effectiveDepartment(category.departmentId, null) !== department.id
    )
      return { ...triage, exception: true };
    return { departmentId: department.id, categoryId: category.id, exception: false };
  }

  private async triageReporter(tx: Tx, tenantId: string, departmentId: string) {
    const department = await tx.department.findFirst({ where: { tenantId, id: departmentId } });
    const id = department?.queueOwnerId ?? department?.substituteId;
    const user = id
      ? await tx.user.findFirst({ where: { tenantId, id, active: true, role: "agent" } })
      : await tx.user.findFirst({
          where: { tenantId, active: true, role: "agent", memberships: { some: { departmentId } } },
          orderBy: { id: "asc" },
        });
    if (!user) throw new Error("Triage queue has no active reporter");
    return user.id;
  }

  private async createInboundTicket(
    tx: Tx,
    input: {
      tenantId: string;
      actorId: string;
      message: InboundMessageInput;
      categoryId: string;
      departmentId: string;
      replyAddress: string;
      unverified: boolean;
      duplicateOfId: string | null;
      routingException: boolean;
      messageRowId: string;
      uploaded: string[];
    },
  ): Promise<{ ticket: Ticket; attachments: Prisma.InputJsonValue }> {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: input.tenantId } });
    const actor = await tx.user.findFirstOrThrow({
      where: { tenantId: input.tenantId, id: input.actorId, active: true },
    });
    const [counter] = await tx.$queryRaw<{ sequence: number }[]>`
      INSERT INTO counters(tenant_id,type,sequence) VALUES(${input.tenantId}::uuid,'incident',1)
      ON CONFLICT(tenant_id,type) DO UPDATE SET sequence=counters.sequence+1 RETURNING sequence
    `;
    if (!counter) throw new Error("Incident counter allocation failed");
    const now = new Date();
    const sla = await makeSlaSnapshot(tx, input.tenantId, tenant.defaultPriority, now, true);
    const summary =
      sanitizeHtml(input.message.subject, { allowedTags: [], allowedAttributes: {} })
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160) || "Email support request";
    const original = input.message.text || "Email message received.";
    const body = collapseQuotedHistory(original).slice(0, 5000) || "Email message received.";
    const replyTokenAddress = input.replyAddress;
    const ticket = await tx.ticket.create({
      data: {
        tenantId: input.tenantId,
        type: "incident",
        sequence: counter.sequence,
        number: `${tenant.incidentPrefix}${String(counter.sequence).padStart(4, "0")}`,
        summary,
        description: body,
        state: "Open",
        priority: tenant.defaultPriority,
        severity: tenant.defaultSeverity,
        categoryId: input.categoryId,
        departmentId: input.departmentId,
        callerId: input.actorId,
        submittedById: input.actorId,
        duplicateOfId: input.duplicateOfId,
        channel: "Email",
        untriaged: true,
        inboundSenderEmail: input.message.sender,
        inboundUnverified: input.unverified,
        inboundReplyAddress: replyTokenAddress,
        ...sla,
      },
    });
    await tx.activity.create({
      data: {
        tenantId: input.tenantId,
        ticketId: ticket.id,
        authorId: input.actorId,
        body,
        audience: input.unverified ? "internal" : "customer",
      },
    });
    await tx.audit.create({
      data: {
        tenantId: input.tenantId,
        ticketId: ticket.id,
        actorId: input.actorId,
        action: "incident.email_created",
        detail: {
          inboundMessageId: input.messageRowId,
          unverified: input.unverified,
          routingException: input.routingException,
        },
      },
    });
    await tx.outbox.create({
      data: {
        tenantId: input.tenantId,
        ticketId: ticket.id,
        event: "incident.created",
        payload: { audience: "internal", inbound: true, unverified: input.unverified },
      },
    });
    if (!input.unverified)
      await tx.outbox.create({
        data: {
          tenantId: input.tenantId,
          ticketId: ticket.id,
          event: "inbound.ack",
          payload: { kind: "inbound_ack", audience: "customer" },
        },
      });
    const attachments = await this.addAttachments(
      tx,
      input.tenantId,
      ticket,
      input.message,
      actor.id,
      input.unverified ? "internal" : "customer",
      input.uploaded,
    );
    return { ticket, attachments };
  }

  private async addAttachments(
    tx: Tx,
    tenantId: string,
    ticket: Ticket,
    message: InboundMessageInput,
    authorId: string,
    audience: "customer" | "internal",
    uploaded: string[],
  ): Promise<Prisma.InputJsonValue> {
    const results: { id: string; filename: string; size: number; status: string }[] = [];
    if (!message.attachments.length || !process.env.S3_BUCKET) return results;
    const policy = await readDataPolicy(tx, tenantId);
    const prior = await tx.attachment.aggregate({
      where: { tenantId, ticketId: ticket.id },
      _sum: { size: true },
      _count: true,
    });
    let total = prior._sum.size ?? 0;
    let count = prior._count;
    for (const file of message.attachments) {
      const bytes = Buffer.from(file.contentBase64, "base64");
      if (!bytes.length || bytes.length > maxFileBytes) continue;
      try {
        checkAttachmentPolicy(policy, file.filename, bytes.length, count, total);
      } catch {
        continue;
      }
      let status = "clean";
      try {
        await scanFile(bytes);
      } catch {
        status = "quarantined";
      }
      const storageKey = `${tenantId}/${ticket.id}/${randomUUID()}`;
      try {
        await this.storage.send(
          new PutObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key: storageKey,
            Body: bytes,
            ContentType: "application/octet-stream",
          }),
        );
      } catch {
        continue;
      }
      uploaded.push(storageKey);
      const stored = await tx.attachment.create({
        data: {
          tenantId,
          ticketId: ticket.id,
          authorId,
          filename: file.filename
            .split(/[\\/]/)
            .pop()!
            .replace(/\p{Cc}/gu, "")
            .slice(0, 180),
          contentType: "application/octet-stream",
          size: bytes.length,
          audience,
          status,
          storageKey,
        },
      });
      results.push({ id: stored.id, filename: stored.filename, size: stored.size, status });
      await tx.audit.create({
        data: {
          tenantId,
          ticketId: ticket.id,
          actorId: authorId,
          action: "ticket.attachment",
          detail: { attachmentId: stored.id, audience, quarantined: status !== "clean" },
        },
      });
      count++;
      total += bytes.length;
    }
    return results;
  }

  private async correlatedTicket(
    tx: Tx,
    tenantId: string,
    message: {
      replyTokenHash: string | null;
      inReplyTo: string | null;
      references: string[];
      subject: string;
    },
    senderId: string,
  ) {
    const deliveryIds = [message.inReplyTo, ...message.references]
      .filter((v): v is string => !!v)
      .map(notificationDeliveryId)
      .filter((v): v is string => !!v);
    let ticketId: string | null = null;
    if (message.replyTokenHash) {
      const delivery = await tx.notificationDelivery.findFirst({
        where: { tenantId, replyTokenHash: message.replyTokenHash },
      });
      if (delivery)
        ticketId =
          (
            await tx.outbox.findFirst({
              where: { tenantId, id: delivery.eventId },
              select: { ticketId: true },
            })
          )?.ticketId ?? null;
    }
    if (!ticketId && deliveryIds.length) {
      const delivery = await tx.notificationDelivery.findFirst({
        where: { tenantId, id: { in: deliveryIds } },
      });
      if (delivery)
        ticketId =
          (
            await tx.outbox.findFirst({
              where: { tenantId, id: delivery.eventId },
              select: { ticketId: true },
            })
          )?.ticketId ?? null;
    }
    if (!ticketId) {
      const number = message.subject.match(/\[([A-Z0-9_-]{2,32})\]/i)?.[1];
      if (number) {
        const found = await tx.ticket.findFirst({
          where: {
            tenantId,
            number,
            OR: [{ callerId: senderId }, { submittedById: senderId }, { requestedForId: senderId }],
          },
          select: { id: true },
        });
        ticketId = found?.id ?? null;
      }
    }
    return ticketId ? tx.ticket.findFirst({ where: { tenantId, id: ticketId } }) : null;
  }

  private async isParticipant(tx: Tx, tenantId: string, ticket: Ticket, senderId: string) {
    if ([ticket.callerId, ticket.submittedById, ticket.requestedForId].includes(senderId))
      return true;
    return !!(await tx.membership.findFirst({
      where: {
        tenantId,
        userId: senderId,
        departmentId: ticket.departmentId,
        department: { active: true },
        user: { active: true, role: "agent" },
      },
    }));
  }
}

@Controller("inbound-mail")
export class InboundMailWebhookController {
  constructor(private readonly inbound: InboundMailService) {}
  @HttpCode(202)
  @Post("webhook")
  accept(
    @Req() request: { body: unknown },
    @Headers("x-astrama-timestamp") timestamp = "",
    @Headers("x-astrama-signature") signature = "",
  ) {
    return this.inbound.accept(request.body, timestamp, signature);
  }
}

@Controller("admin/inbound-mail")
@UseGuards(SessionGuard)
export class InboundMailAdminController {
  constructor(private readonly inbound: InboundMailService) {}
  @Get() settings(@Req() request: AuthRequest) {
    return this.inbound.settings(request.auth);
  }
  @Post() saveSettings(@Req() request: AuthRequest) {
    return this.inbound.saveSettings(request.auth, request.body);
  }
  @Post("secret") rotateSecret(@Req() request: AuthRequest) {
    return this.inbound.rotateSecret(request.auth);
  }
  @Post("addresses") saveAddress(@Req() request: AuthRequest) {
    return this.inbound.saveAddress(request.auth, request.body);
  }
  @Post("process") async process(@Req() request: AuthRequest) {
    if (request.auth.role !== "admin" || !request.auth.view.mfaVerified)
      throw new ForbiddenException("MFA-verified administrator required");
    await this.inbound.dispatch();
    return { processed: true };
  }
}

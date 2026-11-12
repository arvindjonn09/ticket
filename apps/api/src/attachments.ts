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
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { FastifyReply } from "fastify";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";
import { canMessage, isGroupAgent, type Actor } from "@astrama/domain";
import { AuthRequest, SessionGuard } from "./auth.js";
import { TicketsService } from "./tickets.js";
import { readDataPolicy, checkAttachmentPolicy } from "./data-lifecycle.js";

export const maxFileBytes = 5 * 1024 * 1024;
const metadata = z.object({
  audience: z.enum(["customer", "internal"]),
  revision: z.coerce.number().int().nonnegative(),
});
const uuid = z.string().uuid();

// ClamAV INSTREAM: length-prefixed chunks, terminated by a zero-length chunk.
export function scanFile(
  bytes: Buffer,
  host = process.env.CLAMAV_HOST,
  port = Number(process.env.CLAMAV_PORT ?? 3310),
): Promise<void> {
  if (!host)
    return Promise.reject(
      new ServiceUnavailableException("File scanning is unavailable. Try again later."),
    );
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    let response = "";
    const fail = () => {
      socket.destroy();
      reject(new ServiceUnavailableException("File scanning is unavailable. Try again later."));
    };
    socket.setTimeout(15000, fail);
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.write("zINSTREAM\0");
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        const chunk = bytes.subarray(offset, offset + 65536),
          length = Buffer.alloc(4);
        length.writeUInt32BE(chunk.length);
        socket.write(length);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
    socket.on("data", (chunk) => {
      response += chunk.toString();
      if (response.length > 2048) return fail();
      if (!response.includes("\0")) return;
      socket.destroy();
      if (response.trim().replace(/\0/g, "") === "stream: OK") resolve();
      else if (response.includes(" FOUND"))
        reject(new BadRequestException("This file failed the security scan and was not uploaded."));
      else
        reject(
          new ServiceUnavailableException(
            "The file could not be scanned. Try another file or contact support.",
          ),
        );
    });
    socket.once("end", () => {
      if (!response.includes("\0")) fail();
    });
  });
}

@Injectable()
export class AttachmentsService {
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
  constructor(private readonly tickets: TicketsService) {}
  private bucket() {
    if (!process.env.S3_BUCKET || !process.env.S3_ENDPOINT)
      throw new ServiceUnavailableException("Attachments are not configured");
    return process.env.S3_BUCKET;
  }
  list(actor: Actor, id: string) {
    return this.tickets.scoped(actor, async (tx, current) => {
      const ticket = await this.tickets.record(tx, current, id);
      const attachments = await tx.attachment.findMany({
        where: {
          tenantId: actor.tenantId,
          ticketId: id,
          status: "clean",
          ...(isGroupAgent(current, ticket) ? {} : { audience: "customer" }),
        },
        select: { id: true, filename: true, size: true, audience: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      });
      const policy = await readDataPolicy(tx, actor.tenantId);
      return {
        attachments,
        maxFileBytes: policy.attachments.maxFileBytes,
        policy: policy.attachments,
      };
    });
  }
  async upload(req: AuthRequest, id: string) {
    const bucket = this.bucket(),
      actor = req.auth;
    // Authorize before consuming/scanning the uploaded file.
    await this.tickets.scoped(actor, async (tx, current) => {
      const ticket = await this.tickets.record(tx, current, id);
      if (!canMessage(current, ticket, "customer"))
        throw new ForbiddenException("Attachments cannot be added to this ticket");
    });
    const file = await req.file({
      limits: { fileSize: maxFileBytes, files: 1, fields: 2, parts: 3 },
    });
    if (!file) throw new BadRequestException("Choose a file");
    const bytes = await file.toBuffer();
    if (file.file.truncated || !bytes.length)
      throw new BadRequestException("Choose a non-empty file up to 5 MiB");
    const field = (name: string) => {
      const value = file.fields[name];
      return value && !Array.isArray(value) && value.type === "field" ? value.value : undefined;
    };
    const input = metadata.parse({ audience: field("audience"), revision: field("revision") });
    const filename = file.filename
      .normalize("NFC")
      .split(/[\\/]/)
      .pop()
      ?.replace(/\p{Cc}/gu, "")
      .trim();
    if (!filename || filename === "." || filename === ".." || filename.length > 180)
      throw new BadRequestException("Use a filename between 1 and 180 characters");
    await this.tickets.scoped(actor, async (tx) =>
      checkAttachmentPolicy(await readDataPolicy(tx, actor.tenantId), filename, bytes.length),
    );
    await scanFile(bytes);
    const storageKey = `${actor.tenantId}/${id}/${randomUUID()}`;
    await this.storage.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: storageKey,
        Body: bytes,
        ContentType: "application/octet-stream",
      }),
    );
    try {
      await this.tickets.scoped(actor, async (tx, current) => {
        const ticket = await this.tickets.record(tx, current, id);
        if (!canMessage(current, ticket, input.audience))
          throw new ForbiddenException("This attachment audience is not permitted");
        if (ticket.revision !== input.revision)
          throw new ConflictException("Ticket changed. Refresh before uploading.");
        const existing = await tx.attachment.aggregate({
          where: { tenantId: actor.tenantId, ticketId: id },
          _sum: { size: true },
          _count: true,
        });
        checkAttachmentPolicy(
          await readDataPolicy(tx, actor.tenantId),
          filename,
          bytes.length,
          existing._count,
          existing._sum.size ?? 0,
        );
        const attachment = await tx.attachment.create({
          data: {
            tenantId: actor.tenantId,
            ticketId: id,
            authorId: actor.id,
            filename,
            contentType: "application/octet-stream",
            size: bytes.length,
            audience: input.audience,
            status: "clean",
            storageKey,
          },
        });
        await tx.ticket.update({
          where: { id },
          data: { revision: { increment: 1 }, updatedAt: new Date() },
        });
        await tx.audit.create({
          data: {
            tenantId: actor.tenantId,
            ticketId: id,
            actorId: actor.id,
            action: "ticket.attachment",
            detail: { attachmentId: attachment.id, audience: input.audience },
          },
        });
        await tx.outbox.create({
          data: {
            tenantId: actor.tenantId,
            ticketId: id,
            event: "ticket.attachment",
            payload: { attachmentId: attachment.id, audience: input.audience },
          },
        });
      });
    } catch (error) {
      await this.storage
        .send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }))
        .catch(() => {
          /* Orphan objects are inaccessible and can be reclaimed during storage maintenance. */
        });
      throw error;
    }
    return { ok: true };
  }
  async download(actor: Actor, id: string, attachmentId: string, reply: FastifyReply) {
    const file = await this.tickets.scoped(actor, async (tx, current) => {
      const ticket = await this.tickets.record(tx, current, id);
      if (!uuid.safeParse(attachmentId).success)
        throw new NotFoundException("Attachment not found");
      const found = await tx.attachment.findFirst({
        where: { tenantId: actor.tenantId, ticketId: id, id: attachmentId, status: "clean" },
      });
      if (!found || (found.audience === "internal" && !isGroupAgent(current, ticket)))
        throw new NotFoundException("Attachment not found");
      return found;
    });
    const object = await this.storage.send(
      new GetObjectCommand({ Bucket: this.bucket(), Key: file.storageKey }),
    );
    if (!object.Body) throw new NotFoundException("Attachment not found");
    reply
      .header("Content-Type", "application/octet-stream")
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "private, no-store")
      .header(
        "Content-Disposition",
        `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.filename).replace(/'/g, "%27")}`,
      );
    return reply.send(object.Body as Readable);
  }
}

@Controller("tickets/:id/attachments")
@UseGuards(SessionGuard)
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}
  @Get() list(@Req() req: AuthRequest, @Param("id") id: string) {
    return this.attachments.list(req.auth, id);
  }
  @Post() upload(@Req() req: AuthRequest, @Param("id") id: string) {
    return this.attachments.upload(req, id);
  }
  @Get(":attachmentId/download") download(
    @Req() req: AuthRequest,
    @Param("id") id: string,
    @Param("attachmentId") attachmentId: string,
    @Res() reply: FastifyReply,
  ) {
    return this.attachments.download(req.auth, id, attachmentId, reply);
  }
}

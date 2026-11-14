import "reflect-metadata";
import {
  ArgumentsHost,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  HttpException,
  Module,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { AuthService, SessionGuard, type AuthRequest } from "./modules/auth/auth.service.js";
import { Database } from "./database.js";
import { TicketsService } from "./modules/tickets/tickets.service.js";
import { AdminService } from "./modules/organisation/admin.service.js";
import {
  UsersController,
  PublicInvitationController,
  UsersService,
} from "./modules/users/users.service.js";
import {
  AttachmentsController,
  AttachmentsService,
  maxFileBytes,
} from "./modules/attachments/attachments.service.js";
import { ReportsController } from "./modules/reports/reports.service.js";
import { RequestsController, RequestsService } from "./modules/requests/requests.service.js";
import { ContractsController } from "./openapi.js";
import { RecoveryController, RecoveryService } from "./recovery.js";
import {
  AutomationController,
  AutomationService,
} from "./modules/automation/automation.service.js";
import {
  DataPolicyController,
  DataPolicyService,
} from "./modules/organisation/data-lifecycle.service.js";
import { OperationsController } from "./operations.js";
import { SlaController, SlaService } from "./modules/sla/sla.service.js";
import {
  InboundMailAdminController,
  InboundMailService,
  InboundMailWebhookController,
} from "./modules/inbound-mail/inbound-mail.service.js";

@Catch()
class Errors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (error instanceof ZodError)
      return reply
        .status(400)
        .send({ message: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    if (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      ["FST_REQ_FILE_TOO_LARGE", "FST_FILES_LIMIT", "FST_FIELDS_LIMIT", "FST_PARTS_LIMIT"].includes(
        error.code,
      )
    )
      return reply
        .status(413)
        .send({ message: "Upload one file up to 5 MiB with its audience and ticket revision." });
    if (error instanceof HttpException) {
      const response = error.getResponse();
      return reply
        .status(error.getStatus())
        .send(typeof response === "string" ? { message: response } : response);
    }
    host
      .switchToHttp()
      .getRequest<FastifyRequest>()
      .log.error(
        { errorType: error instanceof Error ? error.name : "UnknownError" },
        "Request failed",
      );
    return reply.status(500).send({ message: "An unexpected error occurred" });
  }
}
@Controller()
class PublicController {
  constructor(
    private readonly auth: AuthService,
    private readonly db: Database,
  ) {}
  @Get("health") async health() {
    try {
      await this.db.$queryRaw`SELECT 1`;
      return { status: "ok" };
    } catch {
      throw new HttpException({ status: "unavailable" }, 503);
    }
  }
  @Post("auth/login") login(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.auth.login(request, reply);
  }
}
@Controller()
@UseGuards(SessionGuard)
class ApiController {
  constructor(
    private readonly auth: AuthService,
    private readonly tickets: TicketsService,
    private readonly inbound: InboundMailService,
  ) {}
  @Get("auth/session") session(@Req() req: AuthRequest) {
    return req.auth.view;
  }
  @Post("auth/logout") logout(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.auth.logout(req.auth, reply);
  }
  @Post("auth/mfa/setup") setupMfa(@Req() req: AuthRequest) {
    return this.auth.setupMfa(req.auth);
  }
  @Post("auth/mfa/verify") verifyMfa(@Req() req: AuthRequest) {
    return this.auth.verifyMfa(req.auth, req.body);
  }
  @Get("auth/notification-preference") notificationPreference(@Req() req: AuthRequest) {
    return this.auth.notificationPreference(req.auth);
  }
  @Post("auth/notification-preference") saveNotificationPreference(@Req() req: AuthRequest) {
    return this.auth.saveNotificationPreference(req.auth, req.body);
  }
  @Get("catalog") catalog(@Req() req: AuthRequest) {
    return this.tickets.catalog(req.auth);
  }
  @Get("tickets") list(@Req() req: AuthRequest) {
    return this.tickets.list(req.auth, req.query);
  }
  @Get("tickets/:id") get(@Req() req: AuthRequest, @Param("id") id: string) {
    return this.tickets.get(req.auth, id);
  }
  @Post("tickets") create(@Req() req: AuthRequest) {
    return this.tickets.create(req.auth, req.body, req.headers["idempotency-key"]);
  }
  @Post("tickets/:id/claim") claim(@Req() req: AuthRequest, @Param("id") id: string) {
    return this.tickets.claim(req.auth, id, req.body);
  }
  @Post("tickets/:id/messages") message(@Req() req: AuthRequest, @Param("id") id: string) {
    return this.tickets.message(req.auth, id, req.body);
  }
  @Post("tickets/:id/state") state(@Req() req: AuthRequest, @Param("id") id: string) {
    return this.tickets.state(req.auth, id, req.body);
  }
  @Get("tickets/:id/email-categories") emailCategories(
    @Req() req: AuthRequest,
    @Param("id") id: string,
  ) {
    return this.inbound.emailCategories(req.auth, id);
  }
  @Post("tickets/:id/email-category") chooseEmailCategory(
    @Req() req: AuthRequest,
    @Param("id") id: string,
  ) {
    return this.inbound.chooseEmailCategory(req.auth, id, req.body);
  }
}
@Controller("admin")
@UseGuards(SessionGuard)
class AdminController {
  constructor(private readonly admin: AdminService) {}
  @Get("config") config(@Req() req: AuthRequest) {
    return this.admin.config(req.auth);
  }
  @Post("groups") createGroup(@Req() req: AuthRequest) {
    return this.admin.group(req.auth, req.body);
  }
  @Post("groups/:id") group(@Req() req: AuthRequest, @Param("id") id: string) {
    return this.admin.group(req.auth, req.body, id);
  }
  @Post("categories") createCategory(@Req() req: AuthRequest) {
    return this.admin.category(req.auth, req.body);
  }
  @Post("categories/:id") category(@Req() req: AuthRequest, @Param("id") id: string) {
    return this.admin.category(req.auth, req.body, id);
  }
  @Post("subcategories") createSubcategory(@Req() req: AuthRequest) {
    return this.admin.subcategory(req.auth, req.body);
  }
  @Post("subcategories/:id") subcategory(@Req() req: AuthRequest, @Param("id") id: string) {
    return this.admin.subcategory(req.auth, req.body, id);
  }
  @Post("categories/:id/delete") removeCategory(@Req() req: AuthRequest, @Param("id") id: string) {
    return this.admin.remove(req.auth, id, req.body, "category");
  }
  @Post("subcategories/:id/delete") removeSubcategory(
    @Req() req: AuthRequest,
    @Param("id") id: string,
  ) {
    return this.admin.remove(req.auth, id, req.body, "subcategory");
  }
}
@Module({
  controllers: [
    PublicController,
    ApiController,
    AdminController,
    UsersController,
    PublicInvitationController,
    AttachmentsController,
    ReportsController,
    RequestsController,
    ContractsController,
    RecoveryController,
    AutomationController,
    DataPolicyController,
    OperationsController,
    SlaController,
    InboundMailWebhookController,
    InboundMailAdminController,
  ],
  providers: [
    Database,
    AuthService,
    SessionGuard,
    TicketsService,
    AdminService,
    UsersService,
    AttachmentsService,
    RequestsService,
    RecoveryService,
    AutomationService,
    DataPolicyService,
    InboundMailService,
    SlaService,
  ],
})
class AppModule {}
export async function createApp() {
  if (!process.env.APP_ORIGIN || new URL(process.env.APP_ORIGIN).origin !== process.env.APP_ORIGIN)
    throw new Error("APP_ORIGIN must be an exact origin");
  if (process.env.NODE_ENV === "production" && !process.env.APP_ORIGIN.startsWith("https://"))
    throw new Error("Production requires an HTTPS origin");
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      bodyLimit: 8_000_000,
      trustProxy: process.env.TRUST_PROXY === "1" ? (_address, hop) => hop < 1 : false,
      logger:
        process.env.NODE_ENV === "test"
          ? false
          : {
              serializers: {
                req: (req: FastifyRequest) => ({
                  method: req.method,
                  path: req.url.split("?")[0],
                  requestId: req.id,
                }),
              },
            },
    }),
    { logger: false },
  );
  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: maxFileBytes, files: 1, fields: 2, parts: 3 },
  });
  app.setGlobalPrefix("api");
  app.useGlobalFilters(new Errors());
  await app.get(Database).assertRuntimeRole();
  app.enableShutdownHooks();
  await app.init();
  return app;
}
if (process.env.NODE_ENV !== "test") {
  const app = await createApp();
  await app.listen(Number(process.env.PORT ?? 4311), "0.0.0.0");
}

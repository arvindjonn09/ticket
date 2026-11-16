import { Module } from "@nestjs/common";
import { Database } from "../../database.js";
import { InvitationMailer } from "../../invitation-mail.js";
import { RecoveryMailer } from "../../recovery-mail.js";
import { RecoveryService } from "../../recovery.js";
import { AutomationService } from "../automation/automation.service.js";
import { InboundMailService } from "../inbound-mail/inbound-mail.service.js";
import { SlaService } from "../sla/sla.service.js";
import { TicketsService } from "../tickets/tickets.service.js";
import { NotificationWorker } from "./notifications.service.js";

@Module({
  providers: [
    Database,
    TicketsService,
    InvitationMailer,
    RecoveryService,
    RecoveryMailer,
    AutomationService,
    SlaService,
    InboundMailService,
    NotificationWorker,
  ],
})
export class NotificationWorkerModule {}

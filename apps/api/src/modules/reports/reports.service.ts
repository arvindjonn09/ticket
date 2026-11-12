import { Controller, ForbiddenException, Get, Param, Req, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { canReadTicket, isGroupAgent, terminalStates } from "@astrama/domain";
import { z } from "zod";
import { AuthRequest, SessionGuard } from "../auth/auth.service.js";
import { Database } from "../../database.js";
import { TicketsService } from "../tickets/tickets.service.js";

export function csvCell(value: string | number): string {
  const text = String(value);
  return `"${(/^[\s]*[=+@\-\t\r\n]/.test(text) ? "'" : "") + text.replaceAll('"', '""')}"`;
}

@Controller()
@UseGuards(SessionGuard)
export class ReportsController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly db: Database,
  ) {}
  @Get("reports/summary") async summary(@Req() req: AuthRequest) {
    const { tickets, limitReached } = await this.tickets.list(req.auth, req.query);
    const states = new Map<string, number>(),
      groups = new Map<string, { departmentId: string; departmentName: string; count: number }>();
    for (const ticket of tickets) {
      states.set(ticket.state, (states.get(ticket.state) ?? 0) + 1);
      const group = groups.get(ticket.departmentId) ?? {
        departmentId: ticket.departmentId,
        departmentName: ticket.departmentName,
        count: 0,
      };
      group.count++;
      groups.set(ticket.departmentId, group);
    }
    const metrics = await this.tickets.scoped(req.auth, async (tx, current) => {
      const records = (
        await tx.ticket.findMany({
          where: { tenantId: current.tenantId, id: { in: tickets.map((t) => t.id) } },
        })
      ).filter((t) => canReadTicket(current, t));
      const ids = records.map((t) => t.id),
        now = Date.now();
      const activities = await tx.activity.findMany({
        where: {
          tenantId: current.tenantId,
          ticketId: { in: ids },
          audience: "customer",
          author: { role: "agent" },
        },
        select: { ticketId: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      });
      const audits = await tx.audit.findMany({
        where: {
          tenantId: current.tenantId,
          ticketId: { in: ids },
          action: { in: ["incident.state", "ticket.state", "request.state"] },
        },
        select: { ticketId: true, detail: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      });
      const firstResponse = new Map<string, number>(),
        resolved = new Map<string, number>();
      for (const a of activities)
        if (!firstResponse.has(a.ticketId)) firstResponse.set(a.ticketId, a.createdAt.getTime());
      for (const a of audits)
        if (
          ["Resolved", "Complete"].includes(String((a.detail as Record<string, unknown>).to)) &&
          !resolved.has(a.ticketId)
        )
          resolved.set(a.ticketId, a.createdAt.getTime());
      const median = (values: number[]) => {
        values.sort((a, b) => a - b);
        const middle = Math.floor(values.length / 2);
        return !values.length
          ? null
          : values.length % 2
            ? values[middle]!
            : (values[middle - 1]! + values[middle]!) / 2;
      };
      const elapsed = (time: number, start: Date) =>
        Math.max(0, (time - start.getTime()) / 3600000);
      const open = records.filter(
        (t) => !terminalStates.includes(t.state) && t.state !== "Resolved",
      );
      const pending = records.filter((t) => t.state === "Pending Approval");
      return {
        openCount: open.length,
        oldestOpenDays: Math.max(0, ...open.map((t) => elapsed(now, t.createdAt) / 24)),
        pendingApprovalCount: pending.length,
        oldestApprovalHours: Math.max(0, ...pending.map((t) => elapsed(now, t.createdAt))),
        medianFirstResponseHours: median(
          records
            .filter((t) => firstResponse.has(t.id))
            .map((t) => elapsed(firstResponse.get(t.id)!, t.createdAt)),
        ),
        medianResolutionHours: median(
          records
            .filter((t) => resolved.has(t.id))
            .map((t) => elapsed(resolved.get(t.id)!, t.createdAt)),
        ),
      };
    });
    return {
      total: tickets.length,
      byState: [...states].map(([state, count]) => ({ state, count })),
      byDepartment: [...groups.values()],
      limitReached,
      ...metrics,
    };
  }
  @Get("tickets/:id/history") async history(@Req() req: AuthRequest, @Param("id") id: string) {
    // Reuse the same authority check as ticket detail; never infer access from a UUID.
    return this.tickets.scoped(req.auth, async (tx, current) => {
      const ticket = await this.tickets.record(tx, current, id);
      const internal = isGroupAgent(current, ticket);
      const events = await tx.audit.findMany({
        where: { tenantId: req.auth.tenantId, ticketId: id },
        include: { actor: { select: { name: true } } },
        orderBy: { createdAt: "asc" },
        take: 1000,
      });
      return {
        events: events
          .filter(
            (e) =>
              internal ||
              !(
                ["incident.message", "ticket.message", "ticket.attachment"].includes(e.action) &&
                (e.detail as Record<string, unknown>).audience === "internal"
              ),
          )
          .map((e) => ({
            id: e.id,
            action: e.action,
            actorName: e.actor.name,
            createdAt: e.createdAt,
            ...(internal ? { detail: e.detail } : {}),
          })),
      };
    });
  }
  @Get("reports/export") async export(@Req() req: AuthRequest, @Res() reply: FastifyReply) {
    if (!["agent", "admin"].includes(req.auth.role))
      throw new ForbiddenException("Staff access required");
    const { tickets, limitReached } = await this.tickets.list(req.auth, req.query);
    await this.db.withTenant(req.auth.tenantId, (tx) =>
      tx.configAudit.create({
        data: {
          tenantId: req.auth.tenantId,
          actorId: req.auth.id,
          entityId: req.auth.id,
          action: "tickets.exported",
          detail: { count: tickets.length, limitReached },
        },
      }),
    );
    const rows = [
      ["Number", "Summary", "State", "Priority", "Group", "Created", "Updated"],
      ...tickets.map((t) => [
        t.number,
        t.summary,
        t.state,
        t.priority,
        t.departmentName,
        t.createdAt,
        t.updatedAt,
      ]),
    ];
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="tickets.csv"')
      .header("Cache-Control", "private, no-store")
      .send("\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n"));
  }
  @Get("knowledge") async knowledge(@Req() req: AuthRequest) {
    const { search } = z.object({ search: z.string().trim().min(2).max(160) }).parse(req.query);
    return this.tickets.scoped(req.auth, async (tx, current) => {
      if (current.role !== "agent") throw new ForbiddenException("Support agent required");
      const tickets = await tx.ticket.findMany({
        where: {
          tenantId: current.tenantId,
          departmentId: { in: current.departmentIds },
          resolution: { not: null },
          OR: [
            { summary: { contains: search, mode: "insensitive" } },
            { resolution: { contains: search, mode: "insensitive" } },
          ],
        },
        select: { id: true, number: true, summary: true, resolution: true },
        orderBy: { updatedAt: "desc" },
        take: 100,
      });
      return { tickets };
    });
  }
}

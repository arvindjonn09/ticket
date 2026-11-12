export type Actor = {
  id: string;
  tenantId: string;
  role: "employee" | "agent" | "admin";
  departmentIds: string[];
  approvalTicketIds?: string[];
};
export type Ticket = {
  id?: string;
  tenantId: string;
  callerId: string;
  submittedById?: string;
  requestedForId?: string | null;
  departmentId: string;
  assignedToId: string | null;
  state: string;
  sensitive: boolean;
  type?: string;
  previousState?: string | null;
};
export const terminalStates = ["Complete", "Cancelled", "Rejected"];
export function isGroupAgent(actor: Actor, ticket: Ticket): boolean {
  return (
    actor.tenantId === ticket.tenantId &&
    actor.role === "agent" &&
    actor.departmentIds.includes(ticket.departmentId)
  );
}
export function canReadTicket(actor: Actor, ticket: Ticket): boolean {
  if (actor.tenantId !== ticket.tenantId) return false;
  return (
    actor.id === ticket.callerId ||
    actor.id === ticket.submittedById ||
    actor.id === ticket.requestedForId ||
    (!!ticket.id && !!actor.approvalTicketIds?.includes(ticket.id)) ||
    (actor.role === "agent" && (!ticket.sensitive || isGroupAgent(actor, ticket)))
  );
}
export function canClaimTicket(actor: Actor, ticket: Ticket): boolean {
  return (
    isGroupAgent(actor, ticket) &&
    ticket.assignedToId === null &&
    !terminalStates.includes(ticket.state)
  );
}
export function canMessage(
  actor: Actor,
  ticket: Ticket,
  audience: "customer" | "internal",
): boolean {
  if (terminalStates.includes(ticket.state)) return false;
  return (
    isGroupAgent(actor, ticket) ||
    (actor.tenantId === ticket.tenantId &&
      [ticket.callerId, ticket.submittedById, ticket.requestedForId].includes(actor.id) &&
      audience === "customer")
  );
}
export function canTransition(actor: Actor, ticket: Ticket, next: string): boolean {
  if (actor.tenantId !== ticket.tenantId) return false;
  if (terminalStates.includes(ticket.state)) return false;
  if (next === "Cancelled")
    return (
      isGroupAgent(actor, ticket) ||
      ([ticket.callerId, ticket.submittedById].includes(actor.id) &&
        ["Open", "Pending Approval"].includes(ticket.state))
    );
  if (isGroupAgent(actor, ticket)) {
    if (["Open", "In Progress"].includes(ticket.state) && next === "On Hold") return true;
    if (ticket.state === "On Hold" && next === ticket.previousState) return true;
    if (ticket.type === "request")
      return (
        (ticket.state === "Open" && next === "In Progress") ||
        (ticket.state === "In Progress" && next === "Complete")
      );
  }
  if (ticket.state === "Resolved" && actor.id === ticket.callerId)
    return ["Complete", "In Progress"].includes(next);
  return (
    isGroupAgent(actor, ticket) &&
    ((ticket.state === "Open" && next === "In Progress") ||
      (ticket.state === "In Progress" && next === "Resolved"))
  );
}
export type ApprovalUser = {
  id: string;
  active: boolean;
  approverEligible: boolean;
  isVp: boolean;
};
export function eligibleApprover(
  user: ApprovalUser | null | undefined,
  submitterId: string,
  requestedForId: string,
  vp: boolean,
): boolean {
  return (
    !!user &&
    user.active &&
    user.approverEligible &&
    (!vp || user.isVp) &&
    user.id !== submitterId &&
    user.id !== requestedForId
  );
}
export function approvalPlan(
  item: { requiresManager: boolean; requiresVp: boolean; vpThresholdMinor: number | null },
  totalCostMinor: number,
) {
  return {
    manager: item.requiresManager,
    vp:
      item.requiresVp ||
      (item.vpThresholdMinor !== null && totalCostMinor >= item.vpThresholdMinor),
  };
}
export function canActApproval(
  actorId: string,
  original: ApprovalUser | null,
  actual: ApprovalUser | null,
  ticket: { callerId: string; requestedForId: string | null },
  vp: boolean,
  delegation?: { startsAt: Date; endsAt: Date; active: boolean },
  now = new Date(),
) {
  if (
    !ticket.requestedForId ||
    !eligibleApprover(original, ticket.callerId, ticket.requestedForId, vp) ||
    !eligibleApprover(actual, ticket.callerId, ticket.requestedForId, vp)
  )
    return false;
  return (
    original!.id === actorId ||
    (!!delegation && delegation.active && delegation.startsAt <= now && delegation.endsAt > now)
  );
}
export function routeCategory(
  category: { departmentId: string; sensitive: boolean },
  departmentAvailable: boolean,
  triageId: string,
) {
  return {
    departmentId: departmentAvailable ? category.departmentId : triageId,
    sensitive: category.sensitive,
    exception: !departmentAvailable,
  };
}
export function canConfigureOrganisation(actor: Actor & { mfaVerified?: boolean }): boolean {
  return actor.role === "admin" && actor.mfaVerified === true;
}
export function effectiveDepartment(
  categoryDepartmentId: string,
  override: string | null | undefined,
): string {
  return override ?? categoryDepartmentId;
}
export * from "./calendar.js";

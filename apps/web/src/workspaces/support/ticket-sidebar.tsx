import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowRight, Check } from "lucide-react";
import { TicketManagement } from "../shared/ticket-tools";
import type { SessionView, TicketDetail } from "../../types";
import { Status, date } from "./support-shared.js";

export function TicketSidebar({
  session,
  ticket,
  isAgent,
  canTransfer,
  isRequester,
  closed,
  pending,
  onSaved,
  onClaim,
  onStart,
  onResolve,
}: {
  session: SessionView;
  ticket: TicketDetail;
  isAgent: boolean;
  canTransfer: boolean;
  isRequester: boolean;
  closed: boolean;
  pending: boolean;
  onSaved: (updated: TicketDetail) => void;
  onClaim: () => void;
  onStart: () => void;
  onResolve: () => void;
}) {
  const { t } = useTranslation();
  return (
    <aside className="details-sidebar">
      <h2>{t("classification")}</h2>
      <dl>
        <dt>{t("channel")}</dt>
        <dd>{t(`channels.${ticket.channel}`)}</dd>
        {ticket.duplicateOfId && (
          <>
            <dt>{t("duplicateOf")}</dt>
            <dd>
              <Link className="ticket-number" to={`/tickets/${ticket.duplicateOfId}`}>
                {t("viewOriginalTicket")}
              </Link>
            </dd>
          </>
        )}
        <dt>{t("status")}</dt>
        <dd>
          <Status state={ticket.state} />
        </dd>
        <dt>{t("priority")}</dt>
        <dd>{ticket.priority}</dd>
        <dt>{t("category")}</dt>
        <dd>{ticket.categoryName}</dd>
        <dt>{t("subcategory")}</dt>
        <dd>{ticket.subcategoryName || t("noSubcategory")}</dd>
        <dt>{t("team")}</dt>
        <dd>{ticket.departmentName}</dd>
        <dt>{t("assignedTo")}</dt>
        <dd>{ticket.assignedToName || t("unassigned")}</dd>
        <dt>{t("updated")}</dt>
        <dd>{date(ticket.updatedAt, true)}</dd>
      </dl>
      <TicketManagement
        session={session}
        ticket={ticket}
        isAgent={isAgent}
        canTransfer={canTransfer}
        isRequester={isRequester}
        closed={closed}
        onSaved={onSaved}
      />
      {isAgent && !closed && (
        <div className="ticket-actions">
          {!ticket.assignedToId && (
            <button className="button secondary full" disabled={pending} onClick={onClaim}>
              {t("claim")}
            </button>
          )}
          {ticket.state === "Open" && (
            <button className="button primary full" disabled={pending} onClick={onStart}>
              {t("startWork")}
              <ArrowRight size={15} />
            </button>
          )}
          {ticket.state === "In Progress" && (
            <button className="button primary full" disabled={pending} onClick={onResolve}>
              {t(ticket.type === "request" ? "fulfilRequest" : "resolve")}
              <Check size={16} />
            </button>
          )}
        </div>
      )}
    </aside>
  );
}

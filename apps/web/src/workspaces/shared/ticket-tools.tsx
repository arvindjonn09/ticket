import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../../api";
import { minorCost } from "../../money";
import { ErrorNotice, type RequestItem } from "../approver/completion";
import type { Catalog, SessionView, TicketDetail } from "../../types";

export function TicketManagement({
  session,
  ticket,
  isAgent,
  canTransfer,
  isRequester,
  closed,
  onSaved,
}: {
  session: SessionView;
  ticket: TicketDetail;
  isAgent: boolean;
  canTransfer: boolean;
  isRequester: boolean;
  closed: boolean;
  onSaved: (ticket: TicketDetail) => void;
}) {
  const { t } = useTranslation();
  const [action, setAction] = useState("");
  const [categoryId, setCategoryId] = useState(ticket.categoryId);
  const catalog = useQuery({
    queryKey: ["catalog"],
    queryFn: () => api<Catalog>("/catalog"),
    enabled: isAgent || canTransfer,
  });
  const assignment = useQuery({
    queryKey: ["assignment-options", ticket.id, ticket.departmentId],
    queryFn: () =>
      api<{ users: { id: string; name: string }[]; canAssign: boolean }>(
        `/tickets/${ticket.id}/assignment-options`,
      ),
    enabled: isAgent && !closed,
  });
  const change = useMutation({
    mutationFn: async ({ path, body }: { path: string; body: Record<string, unknown> }) => {
      const { duplicateNumber, ...values } = body;
      if (duplicateNumber) {
        const result = await api<{ tickets: { id: string; number: string }[] }>(
          `/tickets?${new URLSearchParams({ search: String(duplicateNumber) })}`,
        );
        const duplicate = result.tickets.find(
          (row) =>
            row.number.toLowerCase() === String(duplicateNumber).toLowerCase() &&
            row.id !== ticket.id,
        );
        if (!duplicate) throw new ApiError(400, t("duplicateNotFound"));
        values.duplicateOfId = duplicate.id;
      }
      return api<TicketDetail>(
        `/tickets/${ticket.id}/${path}`,
        {
          method: "POST",
          body: JSON.stringify({ revision: ticket.revision, ...values }),
        },
        session.csrfToken,
      );
    },
    onSuccess: (updated) => {
      onSaved(updated);
      setAction("");
    },
  });
  if (
    closed ||
    (!isAgent &&
      !canTransfer &&
      !(isRequester && ["Open", "Pending Approval"].includes(ticket.state)))
  )
    return null;
  return (
    <div className="ticket-management">
      <h3>{t("manageTicket")}</h3>
      <label>
        {t("action")}
        <select
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            change.reset();
          }}
        >
          <option value="">{t("chooseAction")}</option>
          {isAgent && (
            <>
              <option value="triage">{t("triage")}</option>
              <option value="category">{t("changeCategory")}</option>
              {assignment.data?.canAssign && <option value="assign">{t("assignAgent")}</option>}
              {["Open", "In Progress"].includes(ticket.state) && (
                <option value="hold">{t("putOnHold")}</option>
              )}
              {ticket.state === "On Hold" && <option value="resume">{t("resumeWork")}</option>}
            </>
          )}
          {(isAgent || canTransfer) && <option value="transfer">{t("transfer")}</option>}
          {(isAgent || isRequester) && <option value="cancel">{t("cancelTicket")}</option>}
        </select>
      </label>
      {action && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const reason = String(f.get("reason")).trim();
            if (action === "hold" || action === "resume" || action === "cancel")
              change.mutate({
                path: "state",
                body: {
                  state:
                    action === "hold"
                      ? "On Hold"
                      : action === "cancel"
                        ? "Cancelled"
                        : ticket.previousState || "In Progress",
                  reason,
                  ...(action === "cancel" && f.get("duplicateNumber")
                    ? { duplicateNumber: String(f.get("duplicateNumber")).trim() }
                    : {}),
                  ...(action === "hold" ? { holdReason: reason } : {}),
                },
              });
            else
              change.mutate({
                path: "manage",
                body: {
                  action,
                  reason,
                  ...(action === "triage"
                    ? {
                        priority: f.get("priority"),
                        severity: String(f.get("severity")),
                      }
                    : {}),
                  ...(action === "transfer" ? { departmentId: f.get("departmentId") } : {}),
                  ...(action === "assign" ? { assignedToId: f.get("assignedToId") || null } : {}),
                  ...(action === "category"
                    ? {
                        categoryId,
                        ...(f.get("subcategoryId")
                          ? { subcategoryId: f.get("subcategoryId") }
                          : {}),
                      }
                    : {}),
                },
              });
          }}
        >
          {action === "cancel" && (
            <label>
              {t("duplicateTicket")}
              <input name="duplicateNumber" maxLength={40} />
              <span className="field-hint">{t("duplicateHint")}</span>
            </label>
          )}
          {action === "triage" && (
            <>
              <label>
                {t("priority")}
                <select name="priority" defaultValue={ticket.priority}>
                  {["P1", "P2", "P3", "P4", "P5"].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                {t("severity")}
                <select name="severity" required defaultValue={ticket.severity}>
                  {["S1", "S2", "S3", "S4"].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
            </>
          )}
          {action === "transfer" && (
            <label>
              {t("supportGroup")}
              <select name="departmentId" required defaultValue="">
                <option value="">{t("chooseGroup")}</option>
                {catalog.data?.departments.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {action === "assign" && (
            <label>
              {t("assignedTo")}
              <select name="assignedToId" defaultValue={ticket.assignedToId || ""}>
                <option value="">{t("unassigned")}</option>
                {assignment.data?.users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {action === "category" && (
            <>
              <label>
                {t("category")}
                <select required value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                  {catalog.data?.categories
                    .filter((category) =>
                      ticket.type === "request"
                        ? category.allowRequests !== false
                        : category.allowIncidents !== false,
                    )
                    .map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                {t("subcategory")}
                <select key={categoryId} name="subcategoryId" defaultValue="">
                  <option value="">{t("noSubcategory")}</option>
                  {catalog.data?.categories
                    .find((category) => category.id === categoryId)
                    ?.subcategories.map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.name}
                      </option>
                    ))}
                </select>
              </label>
            </>
          )}
          <label>
            {t(action === "hold" ? "holdReason" : "changeReason")}
            <textarea name="reason" required maxLength={2000} rows={3} />
          </label>
          <button className="button secondary full" disabled={change.isPending}>
            {t(action === "cancel" ? "confirmCancellation" : "saveChanges")}
          </button>
        </form>
      )}
      <ErrorNotice error={catalog.error || change.error} />
      {ticket.holdReason && (
        <p className="field-hint">
          {t("holdReason")}: {ticket.holdReason}
        </p>
      )}
    </div>
  );
}
export function Attachments({
  session,
  ticket,
  isAgent,
  closed,
}: {
  session: SessionView;
  ticket: TicketDetail;
  isAgent: boolean;
  closed: boolean;
}) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const files = useQuery({
    queryKey: ["attachments", ticket.id],
    queryFn: () =>
      api<{
        attachments: {
          id: string;
          filename: string;
          size: number;
          audience: string;
          createdAt: string;
        }[];
        maxFileBytes: number;
      }>(`/tickets/${ticket.id}/attachments`),
    enabled: open,
  });
  const upload = useMutation({
    mutationFn: async (form: HTMLFormElement) => {
      const source = new FormData(form);
      const body = new FormData();
      body.set("audience", String(source.get("audience") || "customer"));
      body.set("revision", String(ticket.revision));
      body.set("file", source.get("file")!);
      const response = await fetch(`/api/tickets/${ticket.id}/attachments`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "x-csrf-token": session.csrfToken },
        body,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new ApiError(response.status, data?.message || t("uploadFailed"));
      }
    },
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["attachments", ticket.id] });
      void cache.invalidateQueries({ queryKey: ["ticket", ticket.id] });
    },
  });
  return (
    <details
      className="description-panel attachments-panel"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>{t("attachments")}</summary>
      <ErrorNotice error={files.error || upload.error} />
      {files.isPending && open && <p role="status">{t("loading")}</p>}
      {files.data?.attachments.map((file) => (
        <div className="report-row" key={file.id}>
          <a
            className="ticket-number"
            href={`/api/tickets/${ticket.id}/attachments/${file.id}/download`}
            download
          >
            {file.filename}
          </a>
          <span>
            {Math.ceil(file.size / 1024)} {t("kilobytes")} ·{" "}
            {t(file.audience === "internal" ? "private" : "public")}
          </span>
        </div>
      ))}
      {!closed &&
        (isAgent ||
          ticket.callerId === session.user.id ||
          ticket.requestedForId === session.user.id) && (
          <form
            className="config-form"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const file = new FormData(form).get("file") as File;
              if (files.data && file.size > files.data.maxFileBytes) {
                (form.elements.namedItem("file") as HTMLInputElement).setCustomValidity(
                  t("fileTooLarge"),
                );
                form.reportValidity();
                return;
              }
              upload.mutate(form, { onSuccess: () => form.reset() });
            }}
          >
            <label>
              {t("selectFile")}
              <input
                name="file"
                type="file"
                required
                onChange={(e) => e.target.setCustomValidity("")}
              />
            </label>
            {isAgent && (
              <label>
                {t("attachmentAudience")}
                <select name="audience">
                  <option value="customer">{t("public")}</option>
                  <option value="internal">{t("private")}</option>
                </select>
              </label>
            )}
            <p className="field-hint">{t("attachmentHint")}</p>
            <button className="button secondary" disabled={upload.isPending || files.isPending}>
              {t(upload.isPending ? "sending" : "upload")}
            </button>
          </form>
        )}
    </details>
  );
}
export function ReviseRequest({
  session,
  ticket,
  onSaved,
}: {
  session: SessionView;
  ticket: TicketDetail;
  onSaved: (ticket: TicketDetail) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const options = useQuery({
    queryKey: ["request-catalog"],
    queryFn: () =>
      api<{ items: RequestItem[]; users: { id: string; name: string }[] }>("/requests/catalog"),
    enabled: open,
  });
  const save = useMutation({
    mutationFn: (body: object) =>
      api<TicketDetail>(
        `/requests/${ticket.id}/change`,
        {
          method: "POST",
          body: JSON.stringify({ revision: ticket.revision, ...body }),
        },
        session.csrfToken,
      ),
    onSuccess: onSaved,
  });
  return (
    <details className="description-panel" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{t("changeRequest")}</summary>
      <p className="field-hint">{t("changeRequestHint")}</p>
      <ErrorNotice error={options.error || save.error} />
      {options.data && (
        <form
          className="config-form"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            save.mutate({
              itemId: f.get("itemId"),
              requestedForId: f.get("requestedForId"),
              quantity: Number(f.get("quantity")),
              reason: String(f.get("reason")).trim(),
              ...(f.get("unitCost")
                ? {
                    unitCostMinor: minorCost(
                      Number(f.get("unitCost")),
                      options.data.items.find((item) => item.id === f.get("itemId"))!.currency,
                    ),
                  }
                : {}),
            });
          }}
        >
          <label>
            {t("requestItem")}
            <select required name="itemId" defaultValue={ticket.itemId || ""}>
              {options.data.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("requestedFor")}
            <select required name="requestedForId" defaultValue={ticket.requestedForId || ""}>
              {options.data.users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </select>
          </label>
          <div className="field-grid">
            <label>
              {t("quantity")}
              <input
                type="number"
                name="quantity"
                required
                min={1}
                max={10000}
                defaultValue={ticket.quantity || 1}
              />
            </label>
            <label>
              {t("correctedUnitCost")}
              <input name="unitCost" type="number" min={0} max={20000000} step="0.001" />
            </label>
          </div>
          <label>
            {t("changeReason")}
            <textarea name="reason" required maxLength={2000} rows={3} />
          </label>
          <button className="button secondary" disabled={save.isPending}>
            {t("changeRequest")}
          </button>
        </form>
      )}
    </details>
  );
}

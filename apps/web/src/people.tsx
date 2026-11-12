import { displayDate } from "./dates";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { ErrorNotice } from "./completion";
import { updateSession } from "./session";
import type { SessionView } from "./types";

type User = {
  id: string;
  name: string;
  email: string;
  role: string;
  approverEligible: boolean;
  isVp: boolean;
  managerId: string | null;
  homeDepartment: string;
  phone: string;
  jobTitle: string;
  active: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
  invitationPending: boolean;
};
type Invitation = { url: string; expiresAt: string };
export function Activation() {
  const { t } = useTranslation();
  const [credentials] = useState(() => {
    const fragment = location.hash;
    const params = new URLSearchParams(
      fragment.includes("?")
        ? fragment.slice(fragment.indexOf("?") + 1)
        : fragment.slice(1),
    );
    const value = {
      organisation: params.get("organisation") || "",
      token: params.get("token") || "",
    };
    return value;
  });
  useEffect(() => {
    history.replaceState(null, "", location.pathname + location.search);
  }, []);
  const activate = useMutation({
    mutationFn: (password: string) =>
      api("/auth/activate", {
        method: "POST",
        body: JSON.stringify({ ...credentials, password }),
      }),
  });
  return (
    <div className="page narrow-page activation-page">
      <section className="form-panel">
        <h1>{t("activateAccount")}</h1>
        <p className="muted">{t("activationIntro")}</p>
        {activate.isSuccess ? (
          <>
            <p role="status">{t("activationDone")}</p>
            <a href="/" className="button primary">
              {t("signIn")}
            </a>
          </>
        ) : !credentials.token || !credentials.organisation ? (
          <p role="alert" className="error">
            {t("invalidInvitation")}
          </p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const password = String(f.get("password"));
              const confirmation = e.currentTarget.elements.namedItem(
                "confirmation",
              ) as HTMLInputElement;
              confirmation.setCustomValidity(
                password === confirmation.value ? "" : t("passwordMismatch"),
              );
              if (e.currentTarget.reportValidity()) activate.mutate(password);
            }}
          >
            <label>
              {t("organisation")}
              <input readOnly value={credentials.organisation} />
            </label>
            <label>
              {t("newPassword")}
              <input
                type="password"
                name="password"
                required
                minLength={12}
                maxLength={256}
                autoComplete="new-password"
              />
            </label>
            <label>
              {t("confirmPassword")}
              <input
                type="password"
                name="confirmation"
                required
                minLength={12}
                maxLength={256}
                autoComplete="new-password"
                onChange={(e) => e.target.setCustomValidity("")}
              />
            </label>
            <p className="field-hint">{t("passwordHint")}</p>
            <ErrorNotice error={activate.error} />
            <button className="button primary" disabled={activate.isPending}>
              {t("activateAccount")}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
export function Profile({ session }: { session: SessionView }) {
  const { t } = useTranslation();
  const { id } = useParams();
  const cache = useQueryClient();
  const profile = useQuery({
    queryKey: ["profile", id || session.user.id],
    queryFn: () =>
      api<
        User & {
          tickets?: {
            id: string;
            number: string;
            summary: string;
            state: string;
          }[];
          limitReached?: boolean;
        }
      >(`/users/${id || session.user.id}`),
  });
  const password = useMutation({
    mutationFn: (body: object) =>
      api(
        "/auth/password",
        { method: "POST", body: JSON.stringify(body) },
        session.csrfToken,
      ),
    onSuccess: () => updateSession(cache, null),
  });
  const user = profile.data;
  return (
    <div className="page narrow-page">
      <div className="page-heading">
        <div>
          <h1>{t("profile")}</h1>
          <p>{t("profileIntro")}</p>
        </div>
      </div>
      <ErrorNotice error={profile.error} />
      {profile.isPending && <p role="status">{t("loading")}</p>}
      {user && (
        <>
          <section className="form-panel">
            <h2>{user.name}</h2>
            <dl className="profile-facts">
              {[
                ["email", user.email],
                ["jobTitle", user.jobTitle],
                ["homeDepartment", user.homeDepartment],
                ["phone", user.phone],
                ["status", t(user.active ? "active" : "inactive")],
                ["created", displayDate(user.createdAt, false)],
                ["updated", displayDate(user.updatedAt, false)],
              ].map(([key, value]) => (
                <div key={key}>
                  <dt>{t(key!)}</dt>
                  <dd>{value || "—"}</dd>
                </div>
              ))}
            </dl>
            {user.managerId && (
              <Link className="text-button" to={`/users/${user.managerId}`}>
                {t("viewManager")}
              </Link>
            )}
          </section>
          <section className="form-panel">
            <h2>{t("ticketHistory")}</h2>
            {user.limitReached && (
              <p className="field-hint">{t("resultsLimit")}</p>
            )}
            {user.tickets?.map((ticket) => (
              <div className="config-record" key={ticket.id}>
                <Link className="ticket-number" to={`/tickets/${ticket.id}`}>
                  {ticket.number} · {ticket.summary}
                </Link>
                <p className="muted">{t(`states.${ticket.state}`)}</p>
              </div>
            ))}
            {!user.tickets?.length && (
              <p className="muted">{t("noTicketHistory")}</p>
            )}
          </section>
          {user.id === session.user.id && (
            <section className="form-panel">
              <h2>{t("changePassword")}</h2>
              <p className="field-hint">{t("passwordSignout")}</p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  password.mutate({
                    currentPassword: f.get("currentPassword"),
                    newPassword: f.get("newPassword"),
                  });
                }}
              >
                <label>
                  {t("currentPassword")}
                  <input
                    name="currentPassword"
                    type="password"
                    required
                    autoComplete="current-password"
                  />
                </label>
                <label>
                  {t("newPassword")}
                  <input
                    name="newPassword"
                    type="password"
                    required
                    minLength={12}
                    maxLength={256}
                    autoComplete="new-password"
                  />
                </label>
                <ErrorNotice error={password.error} />
                <button
                  className="button primary"
                  disabled={password.isPending}
                >
                  {t("changePassword")}
                </button>
              </form>
            </section>
          )}
        </>
      )}
    </div>
  );
}
export function UsersPanel({ session }: { session: SessionView }) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const users = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => api<{ users: User[] }>("/admin/users"),
  });
  const invite = useMutation({
    mutationFn: (user: User) =>
      api<{ invitation: Invitation }>(
        `/admin/users/${user.id}/invite`,
        { method: "POST", body: JSON.stringify({ revision: user.revision }) },
        session.csrfToken,
      ),
    onSuccess: (result) => {
      setInvitations([result.invitation]);
      void cache.invalidateQueries({ queryKey: ["admin-users"] });
    },
  });
  return (
    <section className="form-panel">
      <h2>{t("users")}</h2>
      <p className="muted">{t("usersIntro")}</p>
      <ErrorNotice error={users.error || invite.error} />
      <UserForm
        session={session}
        users={users.data?.users || []}
        onInvitation={(invitation) => setInvitations([invitation])}
      />
      {users.data?.users.map((user) => (
        <details className="config-record" key={`${user.id}-${user.revision}`}>
          <summary>
            {user.name}{" "}
            <span className="config-state">
              {t(
                user.active
                  ? "active"
                  : user.invitationPending
                    ? "invited"
                    : "inactive",
              )}
            </span>
          </summary>
          <UserForm
            session={session}
            user={user}
            users={users.data.users}
            onInvitation={(invitation) => setInvitations([invitation])}
          />
          {!user.active && (
            <button
              className="button secondary"
              disabled={invite.isPending}
              onClick={() => invite.mutate(user)}
            >
              {t("reissueInvitation")}
            </button>
          )}
        </details>
      ))}
      <CsvImport session={session} onInvitations={setInvitations} />
      {invitations.length > 0 && (
        <div className="invitation-results" role="status">
          <h3>{t("invitationLinks")}</h3>
          <p className="field-hint">{t("invitationPrivate")}</p>
          {invitations.map((invitation) => (
            <label key={invitation.url}>
              {t("expiresAt", {
                date: displayDate(invitation.expiresAt),
              })}
              <input
                readOnly
                value={invitation.url}
                onFocus={(e) => e.target.select()}
              />
            </label>
          ))}
          <button className="text-button" onClick={() => setInvitations([])}>
            {t("dismiss")}
          </button>
        </div>
      )}
    </section>
  );
}
function UserForm({
  session,
  user,
  users,
  onInvitation,
}: {
  session: SessionView;
  user?: User;
  users: User[];
  onInvitation: (invitation: Invitation) => void;
}) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const save = useMutation({
    mutationFn: (body: object) =>
      api<{ invitation?: Invitation }>(
        `/admin/users${user ? `/${user.id}` : ""}`,
        { method: "POST", body: JSON.stringify(body) },
        session.csrfToken,
      ),
    onSuccess: (result) => {
      if (result.invitation) onInvitation(result.invitation);
      void cache.invalidateQueries({ queryKey: ["admin-users"] });
      void cache.invalidateQueries({ queryKey: ["admin-config"] });
    },
  });
  return (
    <form
      className="config-form"
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const f = new FormData(form);
        save.mutate(
          {
            name: String(f.get("name")).trim(),
            email: String(f.get("email")).trim(),
            role: f.get("role"),
            approverEligible: f.has("approverEligible"),
            isVp: f.has("isVp"),
            managerId: f.get("managerId") || null,
            homeDepartment: String(f.get("homeDepartment")),
            phone: String(f.get("phone")),
            jobTitle: String(f.get("jobTitle")),
            ...(user
              ? { active: f.has("active"), revision: user.revision }
              : {}),
          },
          {
            onSuccess: () => {
              if (!user) form.reset();
            },
          },
        );
      }}
    >
      <fieldset disabled={save.isPending}>
        <legend>{t(user ? "editUser" : "inviteUser")}</legend>
        <div className="field-grid">
          <label>
            {t("fullName")}
            <input
              name="name"
              required
              maxLength={120}
              defaultValue={user?.name}
            />
          </label>
          <label>
            {t("email")}
            <input
              name="email"
              type="email"
              required
              maxLength={254}
              defaultValue={user?.email}
            />
          </label>
        </div>
        <div className="field-grid">
          <label>
            {t("role")}
            <select name="role" defaultValue={user?.role || "employee"}>
              {["employee", "agent", "admin"].map((role) => (
                <option key={role} value={role}>
                  {t(`roles.${role}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("manager")}
            <select name="managerId" defaultValue={user?.managerId || ""}>
              <option value="">{t("noManager")}</option>
              {users
                .filter((row) => row.active && row.id !== user?.id)
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <div className="field-grid">
          {(["homeDepartment", "phone", "jobTitle"] as const).map((key) => (
            <label key={key}>
              {t(key)}
              <input name={key} maxLength={120} defaultValue={user?.[key]} />
            </label>
          ))}
        </div>
        <label className="checkbox-label">
          <input
            type="checkbox"
            name="approverEligible"
            defaultChecked={user?.approverEligible}
          />
          {t("approverEligible")}
        </label>
        <label className="checkbox-label">
          <input type="checkbox" name="isVp" defaultChecked={user?.isVp} />
          {t("vpEligible")}
        </label>
        {user && (
          <label className="checkbox-label">
            <input type="checkbox" name="active" defaultChecked={user.active} />
            {t("activeAccount")}
          </label>
        )}
        <ErrorNotice error={save.error} />
        <button className="button primary">
          {t(user ? "saveChanges" : "inviteUser")}
        </button>
      </fieldset>
    </form>
  );
}
function CsvImport({
  session,
  onInvitations,
}: {
  session: SessionView;
  onInvitations: (value: Invitation[]) => void;
}) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const [csv, setCsv] = useState("");
  const preview = useMutation({
    mutationFn: () =>
      api<{
        rows: { row: number; errors: string[]; user: { name: string; email: string; role: string } | null }[];
        valid: boolean;
        previewToken: string | null;
        expiresAt: string | null;
      }>(
        "/admin/users/import/preview",
        { method: "POST", body: JSON.stringify({ csv }) },
        session.csrfToken,
      ),
  });
  const commit = useMutation({
    mutationFn: () =>
      api<{ users: { invitation: Invitation }[] }>(
        "/admin/users/import/commit",
        {
          method: "POST",
          body: JSON.stringify({ previewToken: preview.data?.previewToken }),
        },
        session.csrfToken,
      ),
    onSuccess: (result) => {
      onInvitations(result.users.map((row) => row.invitation));
      setCsv("");
      preview.reset();
      void cache.invalidateQueries({ queryKey: ["admin-users"] });
    },
  });
  return (
    <details className="config-record">
      <summary>{t("importUsers")}</summary>
      <form
        className="config-form"
        onSubmit={(e) => {
          e.preventDefault();
          preview.mutate();
        }}
      >
        <label>
          {t("csvData")}
          <textarea
            rows={6}
            required
            value={csv}
            onChange={(e) => {
              setCsv(e.target.value);
              preview.reset();
              commit.reset();
            }}
          />
        </label>
        <p className="field-hint">{t("csvHint")}</p>
        <button
          className="button secondary"
          disabled={preview.isPending || commit.isPending}
        >
          {t("previewImport")}
        </button>
      </form>
      <ErrorNotice error={preview.error || commit.error} />
      {preview.data && (
        <div className="config-record">
          <p role="status">
            {t("importRows", { count: preview.data.rows.length })}
          </p>
          <div className="import-preview">{preview.data.rows.map(row => <div className="report-row" key={row.row}><span>{t("csvRow", { row: row.row })}</span><span>{row.user?.name} {row.user?.email}</span>{row.user && <span>{t(`roles.${row.user.role}`)}</span>}</div>)}</div>
          {preview.data.rows
            .filter((row) => row.errors.length)
            .map((row) => (
              <p className="error" key={row.row}>
                {t("csvRow", { row: row.row })}: {row.errors.join("; ")}
              </p>
            ))}
          <button
            className="button primary"
            disabled={
              !preview.data.valid ||
              !preview.data.previewToken ||
              commit.isPending
            }
            onClick={() => commit.mutate()}
          >
            {t("confirmImport")}
          </button>
        </div>
      )}
    </details>
  );
}
type Settings = {
  id: string;
  name: string;
  brandName: string;
  timezone: string;
  locale: string;
  primaryColour: string;
  revision: number;
  incidentPrefix: string;
  requestPrefix: string;
  defaultPriority: string;
  defaultSeverity: string;
};
export function SettingsPanel({ session }: { session: SessionView }) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const settings = useQuery({
    queryKey: ["admin-settings"],
    queryFn: () => api<Settings>("/admin/settings"),
  });
  const save = useMutation({
    mutationFn: (body: object) =>
      api(
        "/admin/settings",
        { method: "POST", body: JSON.stringify(body) },
        session.csrfToken,
      ),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["admin-settings"] });
      void cache.invalidateQueries({ queryKey: ["session"] });
    },
  });
  return (
    <section className="form-panel">
      <h2>{t("settings")}</h2>
      <ErrorNotice error={settings.error || save.error} />
      {settings.data && (
        <form
          key={settings.data.revision}
          className="config-form"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            save.mutate({
              ...Object.fromEntries(f.entries()),
              revision: settings.data.revision,
            });
          }}
        >
          <div className="field-grid">
            {(
              [
                "name",
                "brandName",
                "timezone",
                "locale",
                "incidentPrefix",
                "requestPrefix",
                "defaultSeverity",
              ] as const
            ).map((key) => (
              <label key={key}>
                {t(`settingFields.${key}`)}
                <input
                  name={key}
                  required
                  maxLength={120}
                  defaultValue={settings.data[key]}
                />
              </label>
            ))}
            <label>
              {t("settingFields.defaultPriority")}
              <select
                name="defaultPriority"
                defaultValue={settings.data.defaultPriority}
              >
                {["P1", "P2", "P3", "P4", "P5"].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              {t("settingFields.primaryColour")}
              <input
                name="primaryColour"
                type="color"
                defaultValue={settings.data.primaryColour}
                required
              />
            </label>
          </div>
          <p className="field-hint">{t("settingsHint")}</p>
          {save.isSuccess && <p role="status">{t("configSaved")}</p>}
          <button className="button primary" disabled={save.isPending}>
            {t("saveChanges")}
          </button>
        </form>
      )}
    </section>
  );
}

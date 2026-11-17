import { useEffect } from "react";
import { Link, NavLink, Outlet, useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Check,
  CirclePlus,
  CreditCard,
  Inbox,
  LifeBuoy,
  LockKeyhole,
  LogOut,
  Ticket,
} from "lucide-react";
import { api } from "../../api";
import { updateSession } from "../../session";
import type { SessionView } from "../../types";
import { ThemePicker, Failure, initials } from "./support-shared.js";

export function Shell({ session }: { session: SessionView }) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const [params] = useSearchParams();
  const brandColour = /^#[0-9a-f]{6}$/i.test(session.tenant.primaryColour || "")
    ? session.tenant.primaryColour
    : undefined;
  const luminance = brandColour
    ? [1, 3, 5]
        .map((index) => parseInt(brandColour.slice(index, index + 2), 16) / 255)
        .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0)
    : 0;
  useEffect(() => {
    document.title = `${session.tenant.brandName} · ${t("serviceDesk")}`;
  }, [session.tenant.brandName, t]);
  const logout = useMutation({
    mutationFn: () => api("/auth/logout", { method: "POST", body: "{}" }, session.csrfToken),
    onSuccess: () => {
      return updateSession(cache, null);
    },
  });
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        {t("overview")}
      </a>
      <aside className="sidebar">
        <Link
          className="brand"
          to={
            session.user.role === "admin"
              ? session.mfaVerified
                ? "/organisation"
                : "/authenticator"
              : "/tickets"
          }
        >
          <span
            className="brand-mark"
            style={
              brandColour
                ? { background: brandColour, color: luminance > 0.179 ? "#000000" : "#ffffff" }
                : undefined
            }
          >
            <LifeBuoy size={23} />
          </span>
          <span>
            {session.tenant.brandName}
            <span className="brand-caption">{t("serviceDesk")}</span>
          </span>
        </Link>
        <div className="workspace-label">{t("workspace")}</div>
        <nav aria-label={t("workspace")}>
          {(session.user.role !== "admin" || session.mfaVerified) && (
            <>
              <NavLink
                to="/tickets"
                end
                className={({ isActive }) =>
                  isActive && !params.get("scope") ? "nav-link active" : "nav-link"
                }
              >
                <Inbox size={18} />
                {t(session.user.role === "agent" ? "allTickets" : "myTickets")}
              </NavLink>
              {session.user.role === "agent" && (
                <Link
                  to="/tickets?scope=mine"
                  className={params.get("scope") === "mine" ? "nav-link active" : "nav-link"}
                >
                  <Ticket size={18} />
                  {t("myTickets")}
                </Link>
              )}
              <NavLink to="/requests/new" className="nav-link">
                <CirclePlus size={18} />
                {t("newRequest")}
              </NavLink>
              <NavLink to="/approvals" className="nav-link">
                <Check size={18} />
                {t("myApprovals")}
              </NavLink>
              <NavLink to="/profile" className="nav-link">
                <Ticket size={18} />
                {t("profile")}
              </NavLink>
              {session.user.role !== "employee" && (
                <NavLink to="/reports" className="nav-link">
                  <Inbox size={18} />
                  {t("reports")}
                </NavLink>
              )}
              <NavLink to="/tickets/new" className="nav-link">
                <CirclePlus size={18} />
                {t("newIncident")}
              </NavLink>
            </>
          )}
          {session.user.role === "admin" && (
            <>
              <NavLink
                to={session.mfaVerified ? "/organisation" : "/authenticator"}
                className="nav-link"
              >
                <LockKeyhole size={18} />
                {t(session.mfaVerified ? "organisationSetup" : "mfaTitle")}
              </NavLink>
              {session.mfaVerified && (
                <NavLink to="/billing" className="nav-link">
                  <CreditCard size={18} />
                  {t("billing.title")}
                </NavLink>
              )}
            </>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="tenant-label">
            <span className="tenant-dot" />
            {session.tenant.name}
          </div>
          <div className="user-block">
            <span className="avatar">{initials(session.user.name)}</span>
            <div>
              <strong>{session.user.name}</strong>
              <span>
                {t(
                  session.user.role === "admin"
                    ? "administrator"
                    : session.user.role === "agent"
                      ? "support"
                      : "employee",
                )}
              </span>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label={t("signOut")}
              title={t("signOut")}
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
            >
              <LogOut size={17} />
            </button>
          </div>
          {logout.error && <Failure error={logout.error} />}
          <ThemePicker />
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <span>
            {t(
              session.user.role === "admin"
                ? "administrator"
                : session.user.role === "agent"
                  ? "support"
                  : "employee",
            )}
          </span>
          <span className="organisation-name">{session.tenant.name}</span>
        </header>
        {session.tenant.status === "read_only" && (
          <div className="lifecycle-banner read-only" role="status">
            {t("readOnlyBanner", {
              date: session.tenant.deleteAfter
                ? new Date(session.tenant.deleteAfter).toLocaleDateString(
                    session.tenant.locale || "en",
                    { dateStyle: "medium" },
                  )
                : "—",
            })}
          </div>
        )}
        {session.tenant.status === "trial" &&
          session.user.role === "admin" &&
          session.tenant.trialEndsAt && (
            <div className="lifecycle-banner trial" role="status">
              {t("trialBanner", {
                count: Math.max(
                  0,
                  Math.ceil(
                    (new Date(session.tenant.trialEndsAt).getTime() - Date.now()) / 86400000,
                  ),
                ),
              })}
            </div>
          )}
        <main id="main-content">
          <Outlet context={session} />
        </main>
        <footer className="page-footer">
          <span>{session.tenant.brandName}</span>
          <span>{t("serviceDesk")}</span>
        </footer>
      </div>
    </div>
  );
}

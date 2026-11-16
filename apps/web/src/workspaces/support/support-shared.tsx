import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Monitor, Moon, Sun } from "lucide-react";
import { ApiError } from "../../api";
import { displayDate } from "../../dates";
import type { SessionView, TicketSummary } from "../../types";

export const states = [
  "Open",
  "In Progress",
  "On Hold",
  "Resolved",
  "Complete",
  "Cancelled",
  "Pending Approval",
  "Rejected",
] as const;

export type Theme = "system" | "light" | "dark";

export function ThemePicker() {
  const { t } = useTranslation();
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem("astrama-theme");
      return saved === "light" || saved === "dark" ? saved : "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    media.addEventListener("change", apply);
    try {
      localStorage.setItem("astrama-theme", theme);
    } catch {
      /* Browser storage may be unavailable. */
    }
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return (
    <div className="theme-picker" role="group" aria-label={t("theme")}>
      {(["light", "dark", "system"] as const).map((mode, index) => {
        const Icon = [Sun, Moon, Monitor][index]!;
        return (
          <button
            key={mode}
            type="button"
            aria-label={t(mode)}
            title={t(mode)}
            aria-pressed={theme === mode}
            onClick={() => setTheme(mode)}
          >
            <Icon size={15} />
          </button>
        );
      })}
    </div>
  );
}

export function Failure({ error, retry }: { error: Error; retry?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="error" role="alert">
      <strong>
        {error instanceof ApiError && error.status === 409
          ? t("conflict")
          : error.message || t("error")}
      </strong>
      {retry && (
        <button className="text-button" type="button" onClick={retry}>
          {error instanceof ApiError && error.status === 409 ? t("reload") : t("retry")}
        </button>
      )}
    </div>
  );
}

export function Loading() {
  const { t } = useTranslation();
  return (
    <div className="loading" role="status">
      <span className="spinner" />
      {t("loading")}
    </div>
  );
}

export function Status({ state }: { state: TicketSummary["state"] }) {
  const { t } = useTranslation();
  return (
    <span className={`status state-${state.toLowerCase().replaceAll(" ", "-")}`}>
      <span />
      {t(`states.${state}`)}
    </span>
  );
}

export function date(value: string, full = false) {
  return displayDate(value, full);
}

export function initials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function useSession() {
  return useOutletContext<SessionView>();
}

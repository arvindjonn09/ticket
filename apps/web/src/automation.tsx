import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  automationSettingsSchema,
  type AutomationSettingsView,
  type SessionView,
} from "@astrama/contracts";
import { api } from "./api";
import { ErrorNotice } from "./workspaces/approver/completion";
import i18n from "./i18n";

i18n.addResourceBundle(
  "en",
  "translation",
  {
    automation: {
      title: "Business calendar and automation",
      intro:
        "Automation is off until an administrator confirms and enables this calendar. Existing waiting and resolved tickets become eligible immediately when enabled. Saving makes you the responsible administrator; automation pauses if your account is disabled or loses administrator access.",
      enabled: "Enable approval reminders, escalation and automatic closure",
      timezone: "Organisation timezone: {{timezone}}. Change it in organisation settings.",
      weekdays: "Working weekdays",
      holidays: "Holiday dates (YYYY-MM-DD, one per line, up to 366)",
      reminder: "Approval reminder after business days",
      escalation: "Escalate to queue owner and administrators after business days",
      close: "Complete resolved incidents after business days",
      timing:
        "Days finish at the original local time on each working date. Weekends and listed holidays do not count. Approval timing starts when each stage becomes actionable; closure starts from the resolution transition. Thresholds must be 1–365 days, with escalation on or after the reminder.",
      save: "Save automation settings",
      saving: "Saving…",
      invalid: "Check the working days, valid holiday dates and timing limits.",
      saved: "Automation settings saved.",
    },
  },
  true,
  true,
);

export function AutomationPanel({ session }: { session: SessionView }) {
  const { t } = useTranslation();
  const settings = useQuery({
    queryKey: ["admin-automation"],
    queryFn: () => api<AutomationSettingsView>("/admin/automation"),
  });
  return (
    <section className="form-panel">
      <h2>{t("automation.title")}</h2>
      <p>{t("automation.intro")}</p>
      <ErrorNotice error={settings.error} />
      {settings.data && <AutomationForm initial={settings.data} session={session} />}
    </section>
  );
}

function AutomationForm({
  initial,
  session,
}: {
  initial: AutomationSettingsView;
  session: SessionView;
}) {
  const { t } = useTranslation(),
    cache = useQueryClient();
  const [settings, setSettings] = useState(initial),
    [holidays, setHolidays] = useState(initial.holidays.join("\n")),
    [invalid, setInvalid] = useState(false),
    [saved, setSaved] = useState(false);
  const mutation = useMutation({
    mutationFn: (input: unknown) =>
      api<AutomationSettingsView>(
        "/admin/automation",
        { method: "POST", body: JSON.stringify(input) },
        session.csrfToken,
      ),
    onSuccess: (data) => {
      cache.setQueryData(["admin-automation"], data);
      setSettings(data);
      setSaved(true);
    },
  });
  const weekdays = Array.from({ length: 7 }, (_, day) => ({
    day,
    label: new Intl.DateTimeFormat(session.tenant.locale ?? "en-AU", {
      weekday: "long",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(2026, 0, 4 + day))),
  }));
  return (
    <form
      className="config-form"
      onSubmit={(event) => {
        event.preventDefault();
        setSaved(false);
        const { timezone: _timezone, responsibleAdminId: _responsible, ...input } = settings;
        void _timezone;
        void _responsible;
        const parsed = automationSettingsSchema.safeParse({
          ...input,
          holidays: holidays
            .split(/\r?\n/)
            .map((day) => day.trim())
            .filter(Boolean),
        });
        setInvalid(!parsed.success);
        if (parsed.success) mutation.mutate(parsed.data);
      }}
    >
      <p className="muted">{t("automation.timezone", { timezone: initial.timezone })}</p>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={settings.enabled}
          disabled={mutation.isPending}
          onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })}
        />
        {t("automation.enabled")}
      </label>
      <fieldset disabled={mutation.isPending}>
        <legend>{t("automation.weekdays")}</legend>
        {weekdays.map(({ day, label }) => (
          <label key={day} className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.workingWeekdays.includes(day)}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  workingWeekdays: event.target.checked
                    ? [...settings.workingWeekdays, day]
                    : settings.workingWeekdays.filter((value) => value !== day),
                })
              }
            />
            {label}
          </label>
        ))}
      </fieldset>
      <label>
        {t("automation.holidays")}
        <textarea
          rows={5}
          value={holidays}
          disabled={mutation.isPending}
          onChange={(event) => setHolidays(event.target.value)}
        />
      </label>
      {(["reminderDays", "escalationDays", "autoCloseDays"] as const).map((field, index) => (
        <label key={field}>
          {t(`automation.${["reminder", "escalation", "close"][index]}`)}
          <input
            type="number"
            required
            min={1}
            max={365}
            step={1}
            value={settings[field]}
            disabled={mutation.isPending}
            onChange={(event) => setSettings({ ...settings, [field]: event.target.valueAsNumber })}
          />
        </label>
      ))}
      <p className="muted">{t("automation.timing")}</p>
      {invalid && <p role="alert">{t("automation.invalid")}</p>}
      <ErrorNotice error={mutation.error} />
      {saved && <p role="status">{t("automation.saved")}</p>}
      <button className="button primary" disabled={mutation.isPending}>
        {t(mutation.isPending ? "automation.saving" : "automation.save")}
      </button>
    </form>
  );
}

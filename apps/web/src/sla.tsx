import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  priorities,
  slaSettingsSchema,
  type SessionView,
  type SlaSettingsInput,
  type SlaSettingsView,
} from "@astrama/contracts";
import { api } from "./api";
import { ErrorNotice } from "./workspaces/approver/completion";

export function SlaPanel({ session }: { session: SessionView }) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["admin-sla"],
    queryFn: () => api<SlaSettingsView>("/admin/sla"),
  });
  return (
    <section className="form-panel">
      <h2>{t("sla.title")}</h2>
      <p>{t("sla.proposed")}</p>
      <p className="muted">
        {t("sla.timezone", { timezone: query.data?.timezone ?? session.tenant.timezone })}
      </p>
      <ErrorNotice error={query.error} />
      {query.data && <SlaForm key={query.data.revision} initial={query.data} session={session} />}
    </section>
  );
}

function SlaForm({ initial, session }: { initial: SlaSettingsView; session: SessionView }) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const [settings, setSettings] = useState<SlaSettingsInput>(initial);
  const [holidays, setHolidays] = useState(initial.holidays.join("\n"));
  const [invalid, setInvalid] = useState(false);
  const mutation = useMutation({
    mutationFn: (value: SlaSettingsInput) =>
      api<SlaSettingsView>(
        "/admin/sla",
        { method: "POST", body: JSON.stringify(value) },
        session.csrfToken,
      ),
    onSuccess: (value) => {
      cache.setQueryData(["admin-sla"], value);
      setSettings(value);
      setHolidays(value.holidays.join("\n"));
    },
  });
  const updateTarget = (
    priority: (typeof priorities)[number],
    key: "firstResponseMinutes" | "resolutionMinutes" | "calendar",
    value: number | "business" | "24x7",
  ) =>
    setSettings((current) => ({
      ...current,
      targets: { ...current.targets, [priority]: { ...current.targets[priority], [key]: value } },
    }));
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
        const parsed = slaSettingsSchema.safeParse({
          ...settings,
          holidays: holidays
            .split(/\r?\n/)
            .map((day) => day.trim())
            .filter(Boolean),
        });
        setInvalid(!parsed.success);
        if (parsed.success) mutation.mutate(parsed.data);
      }}
    >
      <label>
        {t("sla.triage")}
        <input
          type="number"
          min={1}
          max={525600}
          value={settings.triageFirstResponseMinutes}
          onChange={(event) =>
            setSettings({ ...settings, triageFirstResponseMinutes: Number(event.target.value) })
          }
        />
      </label>
      <label>
        {t("sla.workdayStart")}
        <input
          type="time"
          value={settings.workdayStart}
          onChange={(event) => setSettings({ ...settings, workdayStart: event.target.value })}
        />
      </label>
      <label>
        {t("sla.workdayEnd")}
        <input
          type="time"
          value={settings.workdayEnd}
          onChange={(event) => setSettings({ ...settings, workdayEnd: event.target.value })}
        />
      </label>
      <fieldset>
        <legend>{t("sla.weekdays")}</legend>
        {weekdays.map(({ day, label }) => (
          <label className="checkbox-label" key={day}>
            <input
              type="checkbox"
              checked={settings.workingWeekdays.includes(day)}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  workingWeekdays: event.target.checked
                    ? [...settings.workingWeekdays, day].sort()
                    : settings.workingWeekdays.filter((value) => value !== day),
                })
              }
            />
            {label}
          </label>
        ))}
      </fieldset>
      <label>
        {t("sla.holidays")}
        <textarea rows={4} value={holidays} onChange={(event) => setHolidays(event.target.value)} />
      </label>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t("priority")}</th>
              <th>{t("sla.firstResponseMinutes")}</th>
              <th>{t("sla.resolutionMinutes")}</th>
              <th>{t("sla.calendar")}</th>
            </tr>
          </thead>
          <tbody>
            {priorities.map((priority) => (
              <tr key={priority}>
                <th scope="row">{priority}</th>
                <td>
                  <input
                    aria-label={`${priority} ${t("sla.firstResponseMinutes")}`}
                    type="number"
                    min={1}
                    max={525600}
                    value={settings.targets[priority].firstResponseMinutes}
                    onChange={(event) =>
                      updateTarget(priority, "firstResponseMinutes", Number(event.target.value))
                    }
                  />
                </td>
                <td>
                  <input
                    aria-label={`${priority} ${t("sla.resolutionMinutes")}`}
                    type="number"
                    min={1}
                    max={525600}
                    value={settings.targets[priority].resolutionMinutes}
                    onChange={(event) =>
                      updateTarget(priority, "resolutionMinutes", Number(event.target.value))
                    }
                  />
                </td>
                <td>
                  <select
                    aria-label={`${priority} ${t("sla.calendar")}`}
                    value={settings.targets[priority].calendar}
                    onChange={(event) =>
                      updateTarget(priority, "calendar", event.target.value as "business" | "24x7")
                    }
                  >
                    <option value="business">{t("sla.business")}</option>
                    <option value="24x7">{t("sla.always")}</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {invalid && (
        <p className="error" role="alert">
          {t("sla.invalid")}
        </p>
      )}
      <ErrorNotice error={mutation.error} />
      {mutation.isSuccess && (
        <p role="status" className="config-saved">
          {t("sla.saved")}
        </p>
      )}
      <button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? t("saving") : t("sla.save")}
      </button>
    </form>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { AdminConfig, SessionView } from "@astrama/contracts";
import { api } from "./api";
import { majorCost, minorCost } from "./money";
import { ErrorNotice, type RequestItem } from "./completion";

export function RequestItems({
  session,
  config,
}: {
  session: SessionView;
  config: AdminConfig;
}) {
  const { t } = useTranslation();
  const catalog = useQuery({
    queryKey: ["admin-request-items"],
    queryFn: () =>
      api<{ items: RequestItem[]; approvers: { id: string; name: string }[] }>(
        "/admin/request-items",
      ),
  });
  return (
    <section className="form-panel">
      <h2>{t("requestCatalog")}</h2>
      <p className="muted">{t("catalogIntro")}</p>
      <ErrorNotice error={catalog.error} />
      {catalog.data && (
        <>
          <ItemForm
            session={session}
            config={config}
            approvers={catalog.data.approvers}
          />
          {catalog.data.items.map((item) => (
            <details
              key={`${item.id}-${item.revision}`}
              className="config-record"
            >
              <summary>
                {item.name}{" "}
                <span className="config-state">
                  {t(item.active ? "active" : "archived")}
                </span>
              </summary>
              <ItemForm
                session={session}
                config={config}
                approvers={catalog.data.approvers}
                item={item}
              />
            </details>
          ))}
        </>
      )}
    </section>
  );
}
function ItemForm({
  session,
  config,
  approvers,
  item,
}: {
  session: SessionView;
  config: AdminConfig;
  approvers: { id: string; name: string }[];
  item?: RequestItem;
}) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const save = useMutation({
    mutationFn: (body: object) =>
      api(
        `/admin/request-items${item ? `/${item.id}` : ""}`,
        { method: "POST", body: JSON.stringify(body) },
        session.csrfToken,
      ),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["admin-request-items"] });
      void cache.invalidateQueries({ queryKey: ["request-catalog"] });
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
            categoryId: f.get("categoryId"),
            unitCostMinor: minorCost(
              Number(f.get("unitCost")),
              String(f.get("currency")),
            ),
            currency: String(f.get("currency")).toUpperCase(),
            recurringPeriod: f.get("recurringPeriod") || null,
            requiresManager: f.has("requiresManager"),
            requiresVp: f.has("requiresVp"),
            vpThresholdMinor: f.get("vpThreshold")
              ? minorCost(
                  Number(f.get("vpThreshold")),
                  String(f.get("currency")),
                )
              : null,
            alternateApproverId: f.get("alternateApproverId") || null,
            vpApproverId: f.get("vpApproverId") || null,
            ...(item
              ? { revision: item.revision, active: f.has("active") }
              : {}),
          },
          {
            onSuccess: () => {
              if (!item) form.reset();
            },
          },
        );
      }}
    >
      <fieldset disabled={save.isPending}>
        <legend>{t(item ? "editItem" : "createItem")}</legend>
        <label>
          {t("itemName")}
          <input
            name="name"
            required
            maxLength={120}
            defaultValue={item?.name}
          />
        </label>
        <label>
          {t("category")}
          <select
            name="categoryId"
            required
            defaultValue={item?.categoryId || ""}
          >
            <option value="">{t("chooseCategory")}</option>
            {config.categories
              .filter((row) => (row.active && row.allowRequests !== false) || row.id === item?.categoryId)
              .map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
          </select>
        </label>
        <div className="field-grid">
          <label>
            {t("unitCost")}
            <input
              name="unitCost"
              type="number"
              required
              min={0}
              max={100000000}
              step="0.001"
              defaultValue={
                item ? majorCost(item.unitCostMinor, item.currency) : 0
              }
            />
          </label>
          <label>
            {t("currency")}
            <input
              name="currency"
              required
              minLength={3}
              maxLength={3}
              pattern="[A-Za-z]{3}"
              defaultValue={item?.currency}
              placeholder={t("currencyPlaceholder")}
            />
          </label>
          <label>
            {t("billingPeriod")}
            <select
              name="recurringPeriod"
              defaultValue={item?.recurringPeriod || ""}
            >
              <option value="">{t("oneTime")}</option>
              <option value="month">{t("monthly")}</option>
              <option value="year">{t("annual")}</option>
            </select>
          </label>
        </div>
        <label className="checkbox-label">
          <input
            type="checkbox"
            name="requiresManager"
            defaultChecked={item?.requiresManager}
          />
          {t("requiresManager")}
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            name="requiresVp"
            defaultChecked={item?.requiresVp}
          />
          {t("requiresVp")}
        </label>
        <label>
          {t("vpThreshold")}
          <input
            name="vpThreshold"
            type="number"
            min={0}
            max={100000000}
            step="0.001"
            defaultValue={
              item?.vpThresholdMinor === null ||
              item?.vpThresholdMinor === undefined
                ? ""
                : majorCost(item.vpThresholdMinor, item.currency)
            }
          />
          <span className="field-hint">{t("vpThresholdHint")}</span>
        </label>
        <div className="field-grid">
          {(["vpApproverId", "alternateApproverId"] as const).map((key) => (
            <label key={key}>
              {t(key)}
              <select name={key} defaultValue={item?.[key] || ""}>
                <option value="">{t("notConfigured")}</option>
                {approvers.map((user) => (
                  <option value={user.id} key={user.id}>
                    {user.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        {item && (
          <label className="checkbox-label">
            <input type="checkbox" name="active" defaultChecked={item.active} />
            {t("active")}
          </label>
        )}
        <ErrorNotice error={save.error} />
        <button className="button primary">
          {t(item ? "saveChanges" : "createItem")}
        </button>
      </fieldset>
    </form>
  );
}

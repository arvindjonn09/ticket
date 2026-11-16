import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, CircleHelp } from "lucide-react";
import { api } from "../../api";
import { ChannelField } from "../approver/completion";
import type { Catalog, TicketDetail } from "../../types";
import { Failure, Loading, useSession } from "./support-shared.js";

export function NewIncident() {
  const { t } = useTranslation();
  const session = useSession();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [categoryId, setCategoryId] = useState("");
  const [subcategoryId, setSubcategoryId] = useState("");
  const callers = useQuery({
    queryKey: ["request-catalog"],
    queryFn: () => api<{ users: { id: string; name: string }[] }>("/requests/catalog"),
    enabled: session.user.role === "agent",
  });
  const catalog = useQuery({
    queryKey: ["catalog"],
    queryFn: () => api<Catalog>("/catalog"),
  });
  const availableCategories =
    catalog.data?.categories.filter((category) => category.allowIncidents !== false) || [];
  const idempotencyKey = useRef(crypto.randomUUID());
  const create = useMutation({
    mutationFn: (body: {
      categoryId: string;
      subcategoryId?: string;
      summary: string;
      description: string;
      callerId?: string;
      channel: string;
    }) =>
      api<TicketDetail>(
        "/tickets",
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey.current },
          body: JSON.stringify(body),
        },
        session.csrfToken,
      ),
    onSuccess: (ticket) => {
      void cache.invalidateQueries({ queryKey: ["tickets"] });
      cache.setQueryData(["ticket", ticket.id], ticket);
      navigate(`/tickets/${ticket.id}`);
    },
  });
  return (
    <div className="page narrow-page">
      <Link className="back-link" to="/tickets">
        <ArrowLeft size={15} />
        {t("back")}
      </Link>
      <div className="page-heading">
        <div>
          <div className="eyebrow">{t("new")}</div>
          <h1>{t("createTitle")}</h1>
          <p>{t("createIntro")}</p>
        </div>
      </div>
      <div className="create-grid">
        <section className="form-panel">
          {catalog.isPending ? (
            <Loading />
          ) : catalog.error ? (
            <Failure
              error={catalog.error}
              retry={() => {
                void catalog.refetch();
              }}
            />
          ) : (
            <form
              onChange={() => {
                idempotencyKey.current = crypto.randomUUID();
              }}
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                create.mutate({
                  categoryId,
                  ...(subcategoryId ? { subcategoryId } : {}),
                  summary: String(form.get("summary")).trim(),
                  description: String(form.get("description")).trim(),
                  channel:
                    session.user.role === "agent" ? String(form.get("channel")) : "Self Service",
                  ...(session.user.role === "agent"
                    ? { callerId: String(form.get("callerId")) }
                    : {}),
                });
              }}
            >
              {session.user.role === "agent" && (
                <>
                  <label>
                    {t("caller")}
                    <select name="callerId" required defaultValue={session.user.id}>
                      <option value={session.user.id}>{session.user.name}</option>
                      {callers.data?.users
                        .filter((user) => user.id !== session.user.id)
                        .map((user) => (
                          <option key={user.id} value={user.id}>
                            {user.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  {callers.error && <Failure error={callers.error} />}
                  <ChannelField />
                </>
              )}
              <label>
                {t("category")}
                <select
                  required
                  value={categoryId}
                  onChange={(event) => {
                    setCategoryId(event.target.value);
                    setSubcategoryId("");
                    idempotencyKey.current = crypto.randomUUID();
                  }}
                >
                  <option value="">{t("chooseCategory")}</option>
                  {availableCategories.map((category) => (
                    <option value={category.id} key={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </label>
              {categoryId && (
                <>
                  <label>
                    {t("subcategory")}
                    <select
                      value={subcategoryId}
                      onChange={(event) => {
                        setSubcategoryId(event.target.value);
                        idempotencyKey.current = crypto.randomUUID();
                      }}
                    >
                      <option value="">{t("noSubcategory")}</option>
                      {availableCategories
                        .find((category) => category.id === categoryId)
                        ?.subcategories.map((subcategory) => (
                          <option key={subcategory.id} value={subcategory.id}>
                            {subcategory.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <p className="field-hint routing-preview" role="status">
                    {t("routedTo", {
                      team:
                        availableCategories
                          .find((category) => category.id === categoryId)
                          ?.subcategories.find((subcategory) => subcategory.id === subcategoryId)
                          ?.departmentName ||
                        availableCategories.find((category) => category.id === categoryId)
                          ?.departmentName,
                    })}
                  </p>
                </>
              )}
              {availableCategories.length === 0 && <p className="error">{t("noCategories")}</p>}
              <label>
                {t("summary")}
                <input
                  name="summary"
                  required
                  minLength={5}
                  maxLength={160}
                  placeholder={t("summaryPlaceholder")}
                  aria-describedby="summary-hint"
                  onChange={() => {
                    idempotencyKey.current = crypto.randomUUID();
                  }}
                />
                <span id="summary-hint" className="field-hint">
                  {t("summaryHint")}
                </span>
              </label>
              <label>
                {t("description")}
                <textarea
                  name="description"
                  required
                  minLength={10}
                  maxLength={5000}
                  rows={7}
                  placeholder={t("descriptionPlaceholder")}
                  aria-describedby="description-hint"
                  onChange={() => {
                    idempotencyKey.current = crypto.randomUUID();
                  }}
                />
                <span id="description-hint" className="field-hint">
                  {t("descriptionHint")}
                </span>
              </label>
              {create.error && <Failure error={create.error} />}
              <div className="form-actions">
                <Link className="button secondary" to="/tickets">
                  {t("cancel")}
                </Link>
                <button
                  className="button primary"
                  disabled={create.isPending || !availableCategories.length}
                >
                  {t(create.isPending ? "submitting" : "submit")}
                  <ArrowRight size={16} />
                </button>
              </div>
            </form>
          )}
        </section>
        <aside className="help-panel">
          <CircleHelp size={22} />
          <h2>{t("requestInfo")}</h2>
          <ol>
            {["requestStepOne", "requestStepTwo", "requestStepThree"].map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ol>
        </aside>
      </div>
    </div>
  );
}

import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { QRCodeCanvas } from "qrcode.react";
import type {
  AdminConfig,
  Group,
  AdminCategory,
  AdminSubcategory,
  SessionView,
} from "@astrama/contracts";
import { api, ApiError } from "../../api";
import { updateSession } from "../../session";
import { UsersPanel, SettingsPanel } from "../employee/people";
import { RequestItems } from "../../request-admin";
import { ApprovalCorrections } from "../approver/completion";
import { AutomationPanel } from "../../automation";
import { DataPolicyPanel } from "../../data-policy";
import { OperationsPanel } from "../../operations";

export function AuthenticatorSetup({ session }: { session: SessionView }) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const setup = useMutation({
    mutationFn: () =>
      api<{ secret: string; uri: string }>(
        "/auth/mfa/setup",
        { method: "POST", body: "{}" },
        session.csrfToken,
      ),
  });
  const verify = useMutation({
    mutationFn: (code: string) =>
      api<SessionView>(
        "/auth/mfa/verify",
        { method: "POST", body: JSON.stringify({ code }) },
        session.csrfToken,
      ),
    onSuccess: (next) => updateSession(cache, next),
  });
  return (
    <div className="page narrow-page">
      <div className="page-heading">
        <div>
          <h1>{t("mfaTitle")}</h1>
          <p>{t("mfaIntro")}</p>
        </div>
      </div>
      <section className="form-panel mfa-panel">
        {!setup.data ? (
          <button
            className="button primary"
            onClick={() => setup.mutate()}
            disabled={setup.isPending}
          >
            {t(setup.isPending ? "loading" : "mfaBegin")}
          </button>
        ) : (
          <>
            <p>{t("mfaInstructions")}</p>
            <QRCodeCanvas
              value={setup.data.uri}
              size={256}
              marginSize={4}
              level="M"
              bgColor="#ffffff"
              fgColor="#000000"
              role="img"
              aria-label={t("mfaQrCode")}
              className="mfa-qr"
              style={{ maxWidth: "100%", height: "auto" }}
            />
            <details className="mfa-manual">
              <summary>{t("mfaManual")}</summary>
              <label>
                {t("mfaSecret")}
                <input readOnly value={setup.data.secret} autoComplete="off" />
              </label>
              <label>
                {t("mfaUri")}
                <textarea readOnly rows={3} value={setup.data.uri} />
              </label>
            </details>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                verify.mutate(String(new FormData(event.currentTarget).get("code")));
              }}
            >
              <label>
                {t("authenticatorCode")}
                <input
                  name="code"
                  required
                  pattern="[0-9]{6}"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  minLength={6}
                  maxLength={6}
                />
              </label>
              <button className="button primary" disabled={verify.isPending}>
                {t(verify.isPending ? "sending" : "mfaVerify")}
              </button>
            </form>
          </>
        )}
        {(setup.error || verify.error) && (
          <p className="error" role="alert">
            {(setup.error || verify.error)?.message}
          </p>
        )}
      </section>
    </div>
  );
}

type RecordVersion = { id: string; revision: number; active: boolean };
function ConfigForm({
  session,
  path,
  record,
  title,
  children,
  values,
  deletable = false,
  onSaved,
}: {
  session: SessionView;
  path: string;
  record?: RecordVersion;
  title: string;
  children: ReactNode;
  values: (form: FormData) => object;
  deletable?: boolean;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = useMutation({
    mutationFn: ({ body, remove }: { body: object; remove: boolean }) =>
      api(
        `/admin/${path}${record ? `/${encodeURIComponent(record.id)}` : ""}${remove ? "/delete" : ""}`,
        { method: "POST", body: JSON.stringify(body) },
        session.csrfToken,
      ),
    onSuccess: async () => {
      onSaved();
      await cache.invalidateQueries({ queryKey: ["admin-config"] });
      await cache.invalidateQueries({ queryKey: ["catalog"] });
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const action = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value");
    const form = event.currentTarget;
    const remove = action === "delete";
    const body = remove
      ? { revision: record!.revision }
      : {
          ...values(new FormData(form)),
          ...(record
            ? {
                revision: record.revision,
                active: action === "archive" ? !record.active : record.active,
              }
            : {}),
        };
    save.mutate(
      { body, remove },
      {
        onSuccess: () => {
          if (!record) form.reset();
          setConfirmDelete(false);
        },
      },
    );
  };
  return (
    <form onSubmit={submit} className="config-form">
      <fieldset disabled={save.isPending}>
        <legend>{title}</legend>
        {children}
        <div className="form-actions">
          <button className="button primary">
            {t(save.isPending ? "sending" : record ? "saveChanges" : "create")}
          </button>
          {record && (
            <button className="button secondary" name="action" value="archive">
              {t(record.active ? "archive" : "restore")}
            </button>
          )}
          {record && deletable && !confirmDelete && (
            <button
              type="button"
              className="button secondary"
              onClick={() => setConfirmDelete(true)}
            >
              {t("deleteUnused")}
            </button>
          )}
        </div>
        {confirmDelete && (
          <div className="delete-confirm">
            <p>{t("deleteConfirm")}</p>
            <button className="button secondary" name="action" value="delete" formNoValidate>
              {t("confirmDelete")}
            </button>{" "}
            <button
              className="button secondary"
              type="button"
              onClick={() => setConfirmDelete(false)}
            >
              {t("cancel")}
            </button>
          </div>
        )}
      </fieldset>
      {save.error && (
        <div className="error" role="alert">
          <p>{save.error.message}</p>
          {save.error instanceof ApiError && save.error.status === 409 && (
            <p>{t("configConflict")}</p>
          )}
          <button
            type="button"
            className="text-button"
            onClick={() => {
              void cache.invalidateQueries({ queryKey: ["admin-config"] });
            }}
          >
            {t("reload")}
          </button>
        </div>
      )}
    </form>
  );
}
function GroupForm({
  config,
  session,
  group,
  onSaved,
}: {
  config: AdminConfig;
  session: SessionView;
  group?: Group;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [members, setMembers] = useState(group?.memberIds || []);
  return (
    <ConfigForm
      session={session}
      path="groups"
      record={group}
      title={group ? t("editGroup", { name: group.name }) : t("createGroup")}
      onSaved={() => {
        if (!group) setMembers([]);
        onSaved();
      }}
      values={(form) => ({
        name: String(form.get("name")).trim(),
        memberIds: form.getAll("memberIds"),
        queueOwnerId: form.get("queueOwnerId") || null,
        substituteId: form.get("substituteId") || null,
      })}
    >
      <label>
        {t("groupName")}
        <input name="name" required maxLength={100} defaultValue={group?.name} />
      </label>
      <fieldset className="member-options">
        <legend>{t("groupMembers")}</legend>
        {config.agents.length === 0 && <p className="muted">{t("noAgents")}</p>}
        {config.agents.map((agent) => (
          <label className="checkbox-label" key={agent.id}>
            <input
              type="checkbox"
              name="memberIds"
              value={agent.id}
              defaultChecked={group?.memberIds.includes(agent.id)}
              onChange={(event) =>
                setMembers((current) =>
                  event.target.checked
                    ? [...current, agent.id]
                    : current.filter((id) => id !== agent.id),
                )
              }
            />
            <span>
              {agent.name} <span className="muted">{agent.email}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="field-grid">
        {(["queueOwnerId", "substituteId"] as const).map((key) => (
          <label key={key}>
            {t(key)}
            <select name={key} defaultValue={group?.[key] || ""}>
              <option value="">{t("notConfigured")}</option>
              {config.agents
                .filter((agent) => members.includes(agent.id))
                .map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
            </select>
          </label>
        ))}
      </div>
      <p className="field-hint">{t("queueOwnerHint")}</p>
      {group?.isTriage && <p className="field-hint">{t("triageGroup")}</p>}
    </ConfigForm>
  );
}
function GroupOptions({ config, selectedId }: { config: AdminConfig; selectedId?: string | null }) {
  const { t } = useTranslation();
  return (
    <>
      {config.groups
        .filter((group) => group.active || group.id === selectedId)
        .map((group) => (
          <option key={group.id} value={group.id} disabled={!group.active}>
            {group.name}
            {group.active ? "" : ` (${t("archived")})`}
          </option>
        ))}
    </>
  );
}
function CategoryForm({
  config,
  session,
  category,
  onSaved,
}: {
  config: AdminConfig;
  session: SessionView;
  category?: AdminCategory;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ConfigForm
      session={session}
      path="categories"
      record={category}
      title={category ? t("editCategory", { name: category.name }) : t("createCategory")}
      deletable
      onSaved={onSaved}
      values={(form) => ({
        name: String(form.get("name")).trim(),
        departmentId: String(form.get("departmentId")),
        sensitive: form.has("sensitive"),
        allowIncidents: form.has("allowIncidents"),
        allowRequests: form.has("allowRequests"),
      })}
    >
      <label>
        {t("categoryName")}
        <input name="name" required maxLength={100} defaultValue={category?.name} />
      </label>
      <label>
        {t("supportGroup")}
        <select name="departmentId" required defaultValue={category?.departmentId || ""}>
          <option value="">{t("chooseGroup")}</option>
          <GroupOptions config={config} selectedId={category?.departmentId} />
        </select>
      </label>
      <label className="checkbox-label">
        <input type="checkbox" name="sensitive" defaultChecked={category?.sensitive} />
        {t("sensitiveCategory")}
      </label>
      <p className="field-hint">{t("sensitiveHint")}</p>
      <label className="checkbox-label">
        <input
          type="checkbox"
          name="allowIncidents"
          defaultChecked={category?.allowIncidents ?? true}
        />
        {t("allowIncidents")}
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          name="allowRequests"
          defaultChecked={category?.allowRequests ?? true}
        />
        {t("allowRequests")}
      </label>
    </ConfigForm>
  );
}
function SubcategoryForm({
  config,
  session,
  subcategory,
  onSaved,
}: {
  config: AdminConfig;
  session: SessionView;
  subcategory?: AdminSubcategory;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ConfigForm
      session={session}
      path="subcategories"
      record={subcategory}
      title={
        subcategory ? t("editSubcategory", { name: subcategory.name }) : t("createSubcategory")
      }
      deletable
      onSaved={onSaved}
      values={(form) => ({
        name: String(form.get("name")).trim(),
        departmentId: String(form.get("departmentId")) || null,
        ...(!subcategory ? { categoryId: String(form.get("categoryId")) } : {}),
      })}
    >
      {subcategory ? (
        <p className="field-hint">
          {t("parentCategory")}:{" "}
          {config.categories.find((category) => category.id === subcategory.categoryId)?.name}
        </p>
      ) : (
        <label>
          {t("parentCategory")}
          <select name="categoryId" required defaultValue="">
            <option value="">{t("chooseCategory")}</option>
            {config.categories
              .filter((category) => category.active)
              .map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
          </select>
        </label>
      )}
      <label>
        {t("subcategoryName")}
        <input name="name" required maxLength={100} defaultValue={subcategory?.name} />
      </label>
      <label>
        {t("routingGroup")}
        <select name="departmentId" defaultValue={subcategory?.departmentId || ""}>
          <option value="">{t("inheritGroup")}</option>
          <GroupOptions config={config} selectedId={subcategory?.departmentId} />
        </select>
      </label>
    </ConfigForm>
  );
}
function RoutingPreview({ config }: { config: AdminConfig }) {
  const { t } = useTranslation();
  const [categoryId, setCategoryId] = useState("");
  const [subcategoryId, setSubcategoryId] = useState("");
  const category = config.categories.find((item) => item.id === categoryId && item.active);
  const children = config.subcategories.filter(
    (item) => item.categoryId === category?.id && item.active,
  );
  const subcategory = children.find((item) => item.id === subcategoryId);
  const group = config.groups.find(
    (item) => item.id === (subcategory?.departmentId ?? category?.departmentId),
  );
  return (
    <section className="form-panel" aria-label={t("routingPreview")}>
      <h2>{t("routingPreview")}</h2>
      <label>
        {t("previewCategory")}
        <select
          value={category?.id || ""}
          onChange={(event) => {
            setCategoryId(event.target.value);
            setSubcategoryId("");
          }}
        >
          <option value="">{t("chooseCategory")}</option>
          {config.categories
            .filter((item) => item.active)
            .map((item) => (
              <option value={item.id} key={item.id}>
                {item.name}
              </option>
            ))}
        </select>
      </label>
      <label>
        {t("previewSubcategory")}
        <select
          value={subcategory?.id || ""}
          onChange={(event) => setSubcategoryId(event.target.value)}
          disabled={!category}
        >
          <option value="">{t("noSubcategory")}</option>
          {children.map((item) => (
            <option value={item.id} key={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      {group && (
        <p role="status" className="field-hint">
          {t("routedTo", { team: group.name })}
        </p>
      )}
      <p className="field-hint">{t("routingFallbackHint")}</p>
    </section>
  );
}
export function OrganisationSetup({ session }: { session: SessionView }) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState(false);
  const [section, setSection] = useState("groups");
  const config = useQuery({
    queryKey: ["admin-config", session.tenant.id],
    queryFn: () => api<AdminConfig>("/admin/config"),
  });
  const onSaved = () => setSaved(true);
  return (
    <div className="page organisation-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">{session.tenant.name}</div>
          <h1>{t("organisationSetup")}</h1>
          <p>{t("organisationIntro")}</p>
        </div>
      </div>
      {config.isPending ? (
        <p role="status">{t("loading")}</p>
      ) : config.error ? (
        <div className="error" role="alert">
          {config.error.message}
          <button
            className="text-button"
            onClick={() => {
              void config.refetch();
            }}
          >
            {t("retry")}
          </button>
        </div>
      ) : (
        <div className="config-sections">
          <div className="organisation-toolbar">
            <label>
              {t("setupSection")}
              <select
                value={section}
                onChange={(event) => {
                  setSection(event.target.value);
                  setSaved(false);
                }}
                aria-controls="organisation-panels"
              >
                <option value="groups">{t("supportGroups")}</option>
                <option value="categories">{t("categories")}</option>
                <option value="subcategories">{t("subcategories")}</option>
                <option value="preview">{t("routingPreview")}</option>
                <option value="users">{t("users")}</option>
                <option value="catalog">{t("requestCatalog")}</option>
                <option value="approvals">{t("approvalCorrections")}</option>
                <option value="settings">{t("settings")}</option>
                <option value="automation">{t("automationSettings")}</option>
                <option value="data-policy">{t("dataPolicySettings")}</option>
                <option value="operations">{t("serviceHealth")}</option>
              </select>
            </label>
            <p className="muted">{t("setupOrder")}</p>
          </div>
          {saved && (
            <p role="status" className="config-saved">
              {t("configSaved")}
            </p>
          )}
          <div id="organisation-panels">
            <div hidden={section !== "automation"}>
              <AutomationPanel session={session} />
            </div>
            <div hidden={section !== "data-policy"}>
              <DataPolicyPanel session={session} />
            </div>
            {section === "operations" && <OperationsPanel />}
            <div hidden={section !== "users"}>
              <UsersPanel session={session} />
            </div>
            <div hidden={section !== "catalog"}>
              <RequestItems session={session} config={config.data} />
            </div>
            <div hidden={section !== "approvals"}>
              <ApprovalCorrections session={session} />
            </div>
            <div hidden={section !== "settings"}>
              <SettingsPanel session={session} />
            </div>
            <div hidden={section !== "preview"}>
              <RoutingPreview config={config.data} />
            </div>
            <section
              hidden={section !== "groups"}
              className="form-panel"
              aria-label={t("supportGroups")}
            >
              <h2>{t("supportGroups")}</h2>
              <p className="muted">{t("groupsIntro")}</p>
              {config.data.groups.some(
                (group) => group.active && (!group.queueOwnerId || !group.substituteId),
              ) && (
                <p className="field-hint" role="status">
                  {t("queueReadinessWarning", {
                    groups: config.data.groups
                      .filter(
                        (group) => group.active && (!group.queueOwnerId || !group.substituteId),
                      )
                      .map((group) => group.name)
                      .join(", "),
                  })}
                </p>
              )}
              <GroupForm config={config.data} session={session} onSaved={onSaved} />
              {config.data.groups.map((group) => (
                <details className="config-record" key={`${group.id}-${group.revision}`}>
                  <summary>
                    {group.name}{" "}
                    <span className="config-state">{t(group.active ? "active" : "archived")}</span>
                  </summary>
                  <GroupForm
                    config={config.data}
                    session={session}
                    group={group}
                    onSaved={onSaved}
                  />
                </details>
              ))}
            </section>
            <section
              hidden={section !== "categories"}
              className="form-panel"
              aria-label={t("categories")}
            >
              <h2>{t("categories")}</h2>
              <CategoryForm config={config.data} session={session} onSaved={onSaved} />
              {config.data.categories.map((category) => (
                <details className="config-record" key={`${category.id}-${category.revision}`}>
                  <summary>
                    {category.name}{" "}
                    <span className="config-state">
                      {t(category.active ? "active" : "archived")}
                    </span>
                  </summary>
                  <CategoryForm
                    config={config.data}
                    session={session}
                    category={category}
                    onSaved={onSaved}
                  />
                </details>
              ))}
            </section>
            <section
              hidden={section !== "subcategories"}
              className="form-panel"
              aria-label={t("subcategories")}
            >
              <h2>{t("subcategories")}</h2>
              <SubcategoryForm config={config.data} session={session} onSaved={onSaved} />
              {config.data.subcategories.map((subcategory) => (
                <details
                  className="config-record"
                  key={`${subcategory.id}-${subcategory.revision}`}
                >
                  <summary>
                    {subcategory.name}{" "}
                    <span className="config-state">
                      {t(subcategory.active ? "active" : "archived")}
                    </span>
                  </summary>
                  <SubcategoryForm
                    config={config.data}
                    session={session}
                    subcategory={subcategory}
                    onSaved={onSaved}
                  />
                </details>
              ))}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

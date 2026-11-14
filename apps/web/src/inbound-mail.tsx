import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InboundMailView } from "@astrama/contracts";
import { api } from "./api";
import type { SessionView } from "./types";

export function InboundMailPanel({ session }: { session: SessionView }) {
  const cache = useQueryClient();
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const query = useQuery({
    queryKey: ["inbound-mail"],
    queryFn: () => api<InboundMailView>("/admin/inbound-mail"),
  });
  const saveSettings = useMutation({
    mutationFn: (body: object) =>
      api("/admin/inbound-mail", { method: "POST", body: JSON.stringify(body) }, session.csrfToken),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["inbound-mail"] }),
  });
  const rotate = useMutation({
    mutationFn: () =>
      api<{ secret: string }>(
        "/admin/inbound-mail/secret",
        { method: "POST", body: "{}" },
        session.csrfToken,
      ),
    onSuccess: (result) => {
      setSecret(result.secret);
      void cache.invalidateQueries({ queryKey: ["inbound-mail"] });
    },
  });
  const saveAddress = useMutation({
    mutationFn: (body: object) =>
      api(
        "/admin/inbound-mail/addresses",
        { method: "POST", body: JSON.stringify(body) },
        session.csrfToken,
      ),
    onSuccess: () => {
      setError("");
      void cache.invalidateQueries({ queryKey: ["inbound-mail"] });
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Could not save address"),
  });
  if (query.isPending)
    return (
      <section className="form-panel">
        <p role="status">Loading inbound mail settings…</p>
      </section>
    );
  if (query.error || !query.data)
    return (
      <section className="form-panel">
        <p role="alert" className="error">
          {query.error?.message ?? "Could not load settings"}
        </p>
      </section>
    );
  const config = query.data;
  return (
    <section className="form-panel" aria-label="Inbound email">
      <h2>Inbound email</h2>
      <p className="muted">
        Map reserved tenant addresses to staffed support queues. The webhook secret is shown once
        when rotated.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          saveSettings.mutate({
            revision: config.revision,
            triageDepartmentId: form.get("triageDepartmentId"),
            triageCategoryId: form.get("triageCategoryId"),
            allowUnverifiedSenders: form.has("allowUnverifiedSenders"),
          });
        }}
      >
        <label>
          Triage queue
          <select name="triageDepartmentId" required defaultValue={config.triageDepartmentId ?? ""}>
            {config.departments.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          General category
          <select name="triageCategoryId" required defaultValue={config.triageCategoryId ?? ""}>
            {config.categories.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            name="allowUnverifiedSenders"
            defaultChecked={config.allowUnverifiedSenders}
          />{" "}
          Allow unverified senders into triage
        </label>
        <button className="button primary" disabled={saveSettings.isPending}>
          Save email settings
        </button>
      </form>
      <button
        className="button secondary"
        onClick={() => {
          setSecret("");
          rotate.mutate();
        }}
        disabled={!config.configured || rotate.isPending}
      >
        Rotate webhook secret
      </button>
      {secret && (
        <label>
          Copy this secret now
          <input
            readOnly
            value={secret}
            autoComplete="off"
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      )}
      <h3>Department addresses</h3>
      {config.addresses.map((address) => (
        <div key={address.id} className="config-record">
          {address.address} →{" "}
          {config.departments.find((item) => item.id === address.departmentId)?.name ??
            "Unknown queue"}{" "}
          {address.isGeneral ? "(general)" : ""} {address.active ? "" : "(inactive)"}
          {address.active && (
            <button
              className="text-button"
              onClick={() => saveAddress.mutate({ ...address, active: false })}
            >
              Deactivate
            </button>
          )}
        </div>
      ))}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          saveAddress.mutate({
            address: form.get("address"),
            departmentId: form.get("departmentId"),
            categoryId: form.get("categoryId"),
            isGeneral: form.has("isGeneral"),
            active: true,
          });
          event.currentTarget.reset();
        }}
      >
        <label>
          Address
          <input
            name="address"
            type="email"
            required
            maxLength={254}
            placeholder="it@example.test"
          />
        </label>
        <label>
          Department
          <select name="departmentId" required>
            {config.departments.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Category
          <select name="categoryId" required>
            {config.categories.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="checkbox-label">
          <input type="checkbox" name="isGeneral" /> General address (routes to triage)
        </label>
        <button className="button secondary" disabled={saveAddress.isPending}>
          Add address
        </button>
      </form>
      {(error || saveSettings.error || rotate.error) && (
        <p className="error" role="alert">
          {error || saveSettings.error?.message || rotate.error?.message}
        </p>
      )}
    </section>
  );
}

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Check, LockKeyhole, MessageSquare } from "lucide-react";

type Audience = "customer" | "internal";
export function MessageComposer({
  isAgent,
  canMessage,
  closed,
  pending,
  onSend,
}: {
  isAgent: boolean;
  canMessage: boolean;
  closed: boolean;
  pending: boolean;
  onSend: (body: string, audience: Audience) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [body, setBody] = useState("");
  const [audience, setAudience] = useState<Audience>("customer");
  return (
    <>
      {canMessage && (
        <form
          className={`composer ${audience === "internal" ? "internal-composer" : ""}`}
          onSubmit={(event) => {
            event.preventDefault();
            void onSend(body.trim(), audience).then(
              () => setBody(""),
              () => undefined,
            );
          }}
        >
          <div className="composer-tabs">
            {(["customer", ...(isAgent ? (["internal"] as const) : [])] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={audience === value ? "selected" : ""}
                aria-pressed={audience === value}
                disabled={pending}
                onClick={() => setAudience(value)}
              >
                {value === "internal" ? <LockKeyhole size={14} /> : <MessageSquare size={14} />}{" "}
                {t(value === "internal" ? "internalNote" : "customerMessage")}
              </button>
            ))}
          </div>
          <label className="sr-only" htmlFor="message">
            {t("message")}
          </label>
          <textarea
            id="message"
            disabled={pending}
            required
            maxLength={5000}
            rows={4}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder={t(audience === "internal" ? "notePlaceholder" : "messagePlaceholder")}
          />
          <div className="composer-footer">
            <span>{t(audience === "internal" ? "internalHint" : "publicHint")}</span>
            <button className="button primary" disabled={pending || !body.trim()}>
              {t(pending ? "sending" : audience === "internal" ? "addNote" : "send")}
              <ArrowRight size={14} />
            </button>
          </div>
        </form>
      )}
      {closed && (
        <div className="closed-message">
          <Check size={16} />
          {t("closed")}
        </div>
      )}
    </>
  );
}

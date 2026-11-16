import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowRight, Check, LifeBuoy, LockKeyhole, Ticket } from "lucide-react";
import { api } from "../../api";
import { updateSession } from "../../session";
import type { SessionView } from "../../types";
import { ThemePicker, Failure } from "./support-shared.js";

export function Login() {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const login = useMutation({
    mutationFn: (body: {
      organisation: string;
      email: string;
      password: string;
      totpCode?: string;
    }) =>
      api<SessionView>("/auth/login", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (session) => {
      return updateSession(cache, session);
    },
  });
  return (
    <div className="login-page">
      <section className="login-story">
        <Link to="/" className="brand">
          <span className="brand-mark">
            <LifeBuoy size={23} />
          </span>
          <span>
            Astrama<span className="brand-caption">{t("serviceDesk")}</span>
          </span>
        </Link>
        <div className="story-copy">
          <span className="eyebrow">{t("loginEyebrow")}</span>
          <h1>{t("welcome")}</h1>
          <p>{t("loginIntro")}</p>
          <div className="story-art" aria-hidden="true">
            <span className="art-line" />
            <span className="art-dot one" />
            <span className="art-dot two" />
            <span className="art-dot three" />
            <div className="art-ticket">
              <Ticket size={26} />
              <span />
              <span />
            </div>
            <div className="art-check">
              <Check size={27} />
            </div>
          </div>
          <span className="story-foot">{t("loginDetail")}</span>
        </div>
        <span className="login-copyright">{t("connected")}</span>
      </section>
      <section className="login-form-side">
        <div className="login-theme">
          <ThemePicker />
        </div>
        <div className="login-form-wrap">
          <span className="form-icon">
            <LockKeyhole size={22} />
          </span>
          <h2>{t("loginTitle")}</h2>
          <p className="muted">{t("loginSubtitle")}</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              login.mutate({
                organisation: String(form.get("organisation")).trim(),
                email: String(form.get("email")).trim(),
                password: String(form.get("password")),
                ...(form.get("totpCode") ? { totpCode: String(form.get("totpCode")) } : {}),
              });
            }}
          >
            <label>
              {t("organisation")}
              <input
                name="organisation"
                autoComplete="organization"
                placeholder={t("organisationPlaceholder")}
                required
                maxLength={100}
              />
            </label>
            <label>
              {t("email")}
              <input
                name="email"
                type="email"
                autoComplete="username"
                placeholder={t("emailPlaceholder")}
                required
              />
            </label>
            <label>
              {t("password")}
              <input name="password" type="password" autoComplete="current-password" required />
            </label>
            <label>
              {t("authenticatorCodeOptional")}
              <input
                name="totpCode"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                minLength={6}
                maxLength={6}
              />
            </label>
            {login.error && <Failure error={login.error} />}
            <button className="button primary full" disabled={login.isPending}>
              {login.isPending ? t("signingIn") : t("signIn")}
              <ArrowRight size={17} />
            </button>
          </form>
          <p>
            <a href="/forgot-password">{t("forgotPassword")}</a>
          </p>
          <p className="login-privacy">
            <LockKeyhole size={13} />
            {t("loginFoot")}
          </p>
          {import.meta.env.DEV && (
            <details className="demo-help">
              <summary>{t("demoTitle")}</summary>
              <p>{t("demoOrgs")}</p>
              <p>{t("demoUsers")}</p>
              <p>{t("demoPassword")}</p>
            </details>
          )}
        </div>
      </section>
    </div>
  );
}

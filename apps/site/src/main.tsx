import React from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import i18n from "i18next";
import "./i18n";
import "./style.css";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(typeof body?.message === "string" ? body.message : i18n.t("requestError"));
  return body as T;
}

function Header() {
  const { t } = useTranslation();
  return (
    <header>
      <a className="brand" href="/" aria-label={t("homeAria")}>
        {t("brand")}
      </a>
      <nav aria-label={t("mainNavigation")}>
        <a href="/pricing">{t("pricing")}</a>
        <a href="/find-organisation">{t("find")}</a>
        <a className="button" href="/signup">
          {t("signUp")}
        </a>
      </nav>
    </header>
  );
}

function Home() {
  const { t } = useTranslation();
  return (
    <main className="hero">
      <p className="eyebrow">{t("homeEyebrow")}</p>
      <h1>
        {t("homeTitle")} <span>{t("homeTitleEmphasis")}</span>
      </h1>
      <p className="lead">{t("homeLead")}</p>
      <div className="actions">
        <a className="button primary" href="/signup">
          {t("signUp")}
        </a>
        <a className="button secondary" href="/pricing">
          {t("viewPlans")}
        </a>
      </div>
      <p className="quiet">{t("homePrivacy")}</p>
    </main>
  );
}

function Pricing() {
  const { t } = useTranslation();
  return (
    <main className="content">
      <p className="eyebrow">{t("plansEyebrow")}</p>
      <h1>{t("plansTitle")}</h1>
      <section className="panel">
        <h2>{t("plansHeading")}</h2>
        <p>{t("plansBody")}</p>
        <a className="button primary" href="/signup">
          {t("signUp")}
        </a>
      </section>
    </main>
  );
}

function Legal({ kind }: { kind: "terms" | "privacy" }) {
  const { t } = useTranslation();
  return (
    <main className="content">
      <p className="eyebrow">Astrama</p>
      <h1>{t(kind === "terms" ? "termsTitle" : "privacy")}</h1>
      <section className="panel">
        <p>{t("legalDraft")}</p>
        <p>{t("legalDisclaimer")}</p>
      </section>
    </main>
  );
}

function Captcha({ onValue }: { onValue: (captcha: string) => void }) {
  const { t } = useTranslation();
  const [status, setStatus] = React.useState(t("captchaChecking"));
  React.useEffect(() => {
    let current = true;
    void api<Record<string, unknown>>("/signup/captcha")
      .then(async (challenge) => {
        if (challenge.mode === "test") {
          if (current) {
            onValue(String(challenge.token));
            setStatus(t("captchaReady"));
          }
          return;
        }
        const { solveChallenge } = await import("altcha-lib/v1");
        const solved = solveChallenge(
          String(challenge.challenge),
          String(challenge.salt),
          String(challenge.algorithm),
          Number(challenge.maxnumber ?? challenge.maxNumber),
        );
        const solution = await solved.promise;
        if (current && solution) {
          onValue(btoa(JSON.stringify({ ...challenge, number: solution.number })));
          setStatus(t("captchaReady"));
        }
      })
      .catch(() => setStatus(t("captchaError")));
    return () => {
      current = false;
    };
  }, []);
  return (
    <p className="hint" role="status">
      {status}
    </p>
  );
}

function Signup() {
  const { t } = useTranslation();
  const [captcha, setCaptcha] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [available, setAvailable] = React.useState<boolean | null>(null);
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    let active = true;
    setAvailable(null);
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(slug)) return;
    const timer = window.setTimeout(() => {
      void api<{ available: boolean }>(`/signup/slug-availability?slug=${encodeURIComponent(slug)}`)
        .then(({ available: result }) => {
          if (active) setAvailable(result);
        })
        .catch(() => {
          if (active) setAvailable(false);
        });
    }, 300);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [slug]);
  return (
    <main className="content">
      <p className="eyebrow">{t("signupEyebrow")}</p>
      <h1>{t("signupTitle")}</h1>
      <section className="panel">
        <p>{t("signupIntro")}</p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setError("");
            const form = new FormData(event.currentTarget);
            try {
              const result = await api<{ accepted: boolean }>("/signup", {
                method: "POST",
                body: JSON.stringify({
                  slug,
                  companyName: form.get("companyName"),
                  adminName: form.get("adminName"),
                  adminEmail: form.get("adminEmail"),
                  timezone: form.get("timezone"),
                  captcha,
                  termsAccepted: form.get("terms") === "on",
                  privacyAccepted: form.get("privacy") === "on",
                }),
              });
              if (result.accepted) location.assign("/signup/success");
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : t("signupError"));
            }
          }}
        >
          <label>
            {t("addressLabel")}
            <input
              name="slug"
              required
              minLength={3}
              maxLength={63}
              pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
              autoCapitalize="none"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              aria-describedby="slug-status"
            />
          </label>
          <p id="slug-status" className="hint" role="status">
            {available === null
              ? t("slugHint")
              : available
                ? t("slugAvailable")
                : t("slugUnavailable")}
          </p>
          <label>
            {t("companyLabel")}
            <input name="companyName" required maxLength={120} autoComplete="organization" />
          </label>
          <label>
            {t("nameLabel")}
            <input name="adminName" required maxLength={120} autoComplete="name" />
          </label>
          <label>
            {t("emailLabel")}
            <input name="adminEmail" type="email" required maxLength={254} autoComplete="email" />
          </label>
          <label>
            {t("timezoneLabel")}
            <input
              name="timezone"
              required
              defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}
            />
          </label>
          <Captcha onValue={setCaptcha} />
          <label className="check">
            <input name="terms" type="checkbox" required /> {t("termsAgreement")}{" "}
            <a href="/terms">{t("termsLink")}</a>.
          </label>
          <label className="check">
            <input name="privacy" type="checkbox" required /> {t("privacyAgreement")}{" "}
            <a href="/privacy">{t("privacyLink")}</a>.
          </label>
          <button className="button primary" disabled={!captcha || available !== true}>
            {t("verificationSubmit")}
          </button>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </form>
      </section>
    </main>
  );
}

function FindOrganisation() {
  const { t } = useTranslation();
  const [captcha, setCaptcha] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState("");
  return (
    <main className="content">
      <p className="eyebrow">{t("accountHelp")}</p>
      <h1>{t("findTitle")}</h1>
      <section className="panel">
        <p>{t("findIntro")}</p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setError("");
            const form = new FormData(event.currentTarget);
            try {
              const result = await api<{ message: string }>("/signup/find-organisation", {
                method: "POST",
                body: JSON.stringify({ email: form.get("email"), captcha }),
              });
              setMessage(result.message);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : t("requestError"));
            }
          }}
        >
          <label>
            {t("emailAddress")}
            <input name="email" type="email" required maxLength={254} autoComplete="email" />
          </label>
          <Captcha onValue={setCaptcha} />
          <button className="button primary" disabled={!captcha}>
            {t("emailLinks")}
          </button>
          {message && <p role="status">{message}</p>}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </form>
      </section>
    </main>
  );
}

function SignupSuccess() {
  const { t } = useTranslation();
  return (
    <main className="content">
      <p className="eyebrow">{t("checkInbox")}</p>
      <h1>{t("verifyEmail")}</h1>
      <section className="panel">
        <p>{t("verifyIntro")}</p>
        <a className="button primary" href="/">
          {t("returnAstrama")}
        </a>
      </section>
    </main>
  );
}

function VerifySignup() {
  const { t } = useTranslation();
  const token = new URLSearchParams(location.search).get("token");
  const [result, setResult] = React.useState<{ tenantUrl: string; message: string } | null>(null);
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    if (!token) {
      setError(t("invalidVerification"));
      return;
    }
    void api<{ tenantUrl: string; message: string }>("/signup/verify", {
      method: "POST",
      body: JSON.stringify({ token }),
    })
      .then(setResult)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : t("verifyError")),
      );
  }, [token]);
  return (
    <main className="content">
      <p className="eyebrow">{t("verificationEyebrow")}</p>
      <h1>{t("prepareOrganisation")}</h1>
      <section className="panel">
        {!result && !error && <p role="status">{t("verifying")}</p>}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {result && (
          <>
            <p role="status">{result.message}</p>
            <a className="button primary" href={result.tenantUrl}>
              {t("openOrganisation")}
            </a>
          </>
        )}
      </section>
    </main>
  );
}

function App() {
  const { t } = useTranslation();
  const path = location.pathname.replace(/\/$/, "") || "/";
  return (
    <>
      <Header />
      {path === "/" ? (
        <Home />
      ) : path === "/pricing" ? (
        <Pricing />
      ) : path === "/signup" ? (
        <Signup />
      ) : path === "/signup/success" ? (
        <SignupSuccess />
      ) : path === "/signup/verify" ? (
        <VerifySignup />
      ) : path === "/find-organisation" ? (
        <FindOrganisation />
      ) : path === "/terms" ? (
        <Legal kind="terms" />
      ) : path === "/privacy" ? (
        <Legal kind="privacy" />
      ) : (
        <main className="content">
          <h1>{t("notFound")}</h1>
          <a href="/">{t("returnHome")}</a>
        </main>
      )}
      <footer>
        <span>© Astrama</span>
        <nav aria-label={t("legalNavigation")}>
          <a href="/terms">{t("terms")}</a>
          <a href="/privacy">{t("privacy")}</a>
        </nav>
      </footer>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

type MailHandoff = string | "invalid" | null;
let inspected = false;
let pending: MailHandoff = null;

export function captureMailHandoff() {
  if (inspected || typeof location === "undefined" || typeof history === "undefined") return;
  inspected = true;
  const url = new URL(location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const queryToken = url.searchParams.has("mailHandoff");
  const confirming = url.searchParams.get("mailConnect") === "confirm";
  if (!fragment.has("mailHandoff") && !queryToken && !confirming) return;
  const token = fragment.get("mailHandoff");
  const emailRoute =
    url.pathname === "/organisation" && url.searchParams.get("section") === "email";
  if (emailRoute && confirming) {
    pending =
      !queryToken &&
      fragment.getAll("mailHandoff").length === 1 &&
      token &&
      /^[A-Za-z0-9_-]{43}$/.test(token)
        ? token
        : "invalid";
  }
  fragment.delete("mailHandoff");
  url.hash = fragment.toString();
  url.searchParams.delete("mailHandoff");
  url.searchParams.delete("mailConnect");
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export function takeMailHandoff(): MailHandoff {
  const result = pending;
  pending = null;
  return result;
}

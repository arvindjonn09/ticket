import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { updateSession } from "./session";
import type { SessionView } from "./types";

it("keeps the active session observer connected on login and logout while removing account data", async () => {
  const cache = new QueryClient();
  cache.setQueryData(["session"], null);
  cache.setQueryData(["tickets"], { tickets: ["previous-account"] });
  let finishPreviousRequest!: (data: string[]) => void;
  const previousRequest = cache
    .fetchQuery({
      queryKey: ["tickets", "pending"],
      queryFn: () =>
        new Promise<string[]>((resolve) => {
          finishPreviousRequest = resolve;
        }),
    })
    .catch(() => undefined);
  const observer = new QueryObserver<SessionView | null>(cache, {
    queryKey: ["session"],
    enabled: false,
  });
  const observed: (SessionView | null | undefined)[] = [];
  const unsubscribe = observer.subscribe((result) =>
    observed.push(result.data),
  );
  const session: SessionView = {
    user: {
      id: "u1",
      name: "Demo",
      email: "employee@demo.test",
      role: "employee",
      departmentIds: [],
    },
    tenant: {
      id: "t1",
      name: "Harbour",
      slug: "harbour",
      brandName: "Astrama",
    },
    csrfToken: "csrf",
  };
  await updateSession(cache, session);
  expect(observed.at(-1)).toEqual(session);
  expect(cache.getQueryData(["tickets"])).toBeUndefined();
  finishPreviousRequest(["late-previous-account"]);
  await previousRequest;
  expect(cache.getQueryData(["tickets", "pending"])).toBeUndefined();
  cache.setQueryData(["catalog"], { categories: ["previous-account"] });
  await updateSession(cache, null);
  expect(observed.at(-1)).toBeNull();
  expect(cache.getQueryData(["catalog"])).toBeUndefined();
  unsubscribe();
  cache.clear();
});

it("replaces the restricted admin session and removes cached enrollment data after MFA verification", async () => {
  const cache = new QueryClient();
  const restricted: SessionView = {
    user: {
      id: "admin",
      name: "Admin",
      email: "admin@demo.test",
      role: "admin",
      departmentIds: [],
    },
    tenant: { id: "tenant", name: "Demo", slug: "demo", brandName: "Demo" },
    csrfToken: "restricted-csrf",
    mfaVerified: false,
  };
  cache.setQueryData(["session"], restricted);
  cache.setQueryData(["mfa-setup"], { secret: "private" });
  const verified = {
    ...restricted,
    csrfToken: "verified-csrf",
    mfaVerified: true,
  };
  await updateSession(cache, verified);
  expect(cache.getQueryData(["session"])).toEqual(verified);
  expect(cache.getQueryData(["mfa-setup"])).toBeUndefined();
  cache.clear();
});

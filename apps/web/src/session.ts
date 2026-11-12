import type { QueryClient } from "@tanstack/react-query";
import type { SessionView } from "./types";

export async function updateSession(cache: QueryClient, session: SessionView | null) {
  // Keep the observed session query alive while removing the previous account's data.
  const accountQueries = {
    predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[0] !== "session",
  };
  await cache.cancelQueries(accountQueries);
  cache.removeQueries(accountQueries);
  cache.setQueryData(["session"], session);
}

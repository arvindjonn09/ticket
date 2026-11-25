export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}
export type Call = <T>(path: string, body?: unknown, key?: string) => Promise<T>;
export async function api<T>(
  path: string,
  csrf?: string,
  body?: unknown,
  key?: string,
): Promise<T> {
  const response = await fetch(`/api/operator${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(csrf ? { "x-csrf-token": csrf } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(key ? { "idempotency-key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      typeof value?.message === "string" ? value.message : `${response.status}`,
      response.status,
    );
  return value as T;
}
export type Organisation = {
  id: string;
  slug: string;
  name: string;
  status: string;
  active: boolean;
  revision: number;
  planId: string | null;
  seatLimit: number;
  seatsUsed: number;
  createdAt: string | null;
  lastActivity: string | null;
  trialEndsAt: string | null;
  deleteAfter: string | null;
  adminContacts?: {
    id: string;
    name: string;
    email: string;
    active: boolean;
    mfaEnrolled: boolean;
  }[];
  health?: Record<string, number | string | null>;
  timeline?: { action: string; at: string }[];
};
export type Plan = {
  id: string;
  name: string;
  stripePriceId: string;
  seatLimit: number;
  billingInterval: "month" | "year";
  active: boolean;
  revision: number;
};
export type Failure = (error: unknown) => void;
export const date = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString() : "—";

import { afterEach, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";

afterEach(() => vi.unstubAllGlobals());

it("sends same-origin credentials and CSRF on mutations and preserves revision conflict errors", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ message: "Revision changed" }), {
        status: 409,
      }),
    );
  vi.stubGlobal("fetch", fetch);
  const result = api(
    "/tickets/example/messages",
    {
      method: "POST",
      body: JSON.stringify({
        revision: 1,
        body: "An update",
        audience: "customer",
      }),
    },
    "csrf-example",
  );
  await expect(result).rejects.toMatchObject({
    status: 409,
    message: "Revision changed",
  });
  expect(fetch).toHaveBeenCalledWith(
    "/api/tickets/example/messages",
    expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      headers: expect.objectContaining({ "x-csrf-token": "csrf-example" }),
    }),
  );
  expect(new ApiError(409, "Conflict")).toBeInstanceOf(Error);
});

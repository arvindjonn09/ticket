import { z } from "zod";
const explanation = z.string().trim().min(10).max(1000);
const base = { reason: explanation, revision: z.number().int().nonnegative() };
export const operatorActionSchema = z.discriminatedUnion("action", [
  z.object({ ...base, action: z.literal("resend-invite"), userId: z.string().uuid() }).strict(),
  z
    .object({
      ...base,
      action: z.literal("mfa-recovery"),
      userId: z.string().uuid(),
      verificationEvidence: explanation,
      verified: z.literal(true),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("extend-trial"),
      trialEndsAt: z
        .string()
        .datetime({ offset: true })
        .transform((value) => new Date(value)),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("set-plan"),
      planId: z.string().trim().min(1).max(80),
      seatLimit: z.number().int().positive().max(2147483647),
      prorationBehavior: z.enum(["none", "create_prorations"]),
    })
    .strict(),
  z.object({ ...base, action: z.literal("suspend") }).strict(),
  z.object({ ...base, action: z.literal("reactivate") }).strict(),
  z.object({ ...base, action: z.literal("export") }).strict(),
  z
    .object({
      ...base,
      action: z.literal("extend-retention"),
      deleteAfter: z
        .string()
        .datetime({ offset: true })
        .transform((value) => new Date(value)),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("schedule-deletion"),
      deleteAfter: z
        .string()
        .datetime({ offset: true })
        .transform((value) => new Date(value)),
      expectedSlug: z.string(),
      confirmed: z.literal(true),
    })
    .strict(),
]);
export const operatorPlanSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    id: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(120),
    stripePriceId: z
      .string()
      .regex(/^price_[A-Za-z0-9_]+$/)
      .max(255),
    seatLimit: z.number().int().positive().max(2147483647),
    billingInterval: z.enum(["month", "year"]),
    active: z.boolean(),
    reason: explanation,
  })
  .strict();

export type OperatorActionInput = z.input<typeof operatorActionSchema>;
export type OperatorPlanInput = z.input<typeof operatorPlanSchema>;
export type OperatorSessionView = {
  operator: { id: string; name: string; email: string; role: "support" | "owner" };
  csrfToken: string;
  mfaVerified: boolean;
  mfaEnrolled: boolean;
};

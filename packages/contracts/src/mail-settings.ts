import { z } from "zod";

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
export const platformMailProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    provider: z.enum(["mox", "ses", "postmark", "mailgun", "smtp"]),
    host: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9.:-]*[a-zA-Z0-9])?$/),
    port: z.union([z.literal(465), z.literal(587), z.literal(25), z.literal(2525)]),
    security: z.enum(["tls", "starttls"]),
    username: z
      .string()
      .trim()
      .min(1)
      .max(254)
      .refine((value) => !/[\r\n\0]/.test(value)),
    password: z.string().min(1).max(2000),
    fromAddress: z.string().trim().email().max(254),
    fromDomain: domain,
    dkimSelector: z
      .string()
      .trim()
      .min(1)
      .max(63)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional(),
    dkimRecord: z.string().trim().max(4000).optional(),
    spfRecord: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine((input) => input.fromAddress.split("@")[1]?.toLowerCase() === input.fromDomain, {
    message: "From address must use the From domain",
    path: ["fromAddress"],
  });
export const platformMailSwitchSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    totpCode: z.string().regex(/^\d{6}$/),
    reason: z.string().trim().min(10).max(1000),
  })
  .strict();
export const platformMailActivateSchema = platformMailSwitchSchema.extend({
  profileId: z.string().uuid(),
});
export type PlatformMailProfileInput = z.infer<typeof platformMailProfileSchema>;
export type PlatformMailProfile = Omit<PlatformMailProfileInput, "password"> & {
  id: string;
  revision: number;
  passwordSet: boolean;
  testedAt: string | null;
  active: boolean;
};
export type PlatformMailDnsView = {
  records: { type: string; name: string; expected: string; actual: string[]; ok: boolean }[];
};
export type PlatformMailView = {
  revision: number;
  activeProfileId: string | null;
  previousProfileId: string | null;
  profiles: PlatformMailProfile[];
  health: { sent: number; failed: number; bounceRate: number | null; junkRisk: boolean };
  receiving: {
    domain: string | null;
    mxOk: boolean;
    lastReceivedAt: string | null;
    queueDepth: number;
    rejected: number;
    testStatus?: "pending" | "working" | "problem" | null;
  };
};

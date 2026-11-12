import { z } from "zod";

export const retentionClasses = ["tickets", "attachments", "audits"] as const;
const retentionRule = z
  .object({ days: z.number().int().min(1).max(36500).nullable(), legalHold: z.boolean() })
  .strict();
export const dataPolicySchema = z
  .object({
    revision: z.number().int().nonnegative(),
    legalHold: z.boolean(),
    attachments: z
      .object({
        maxFileBytes: z
          .number()
          .int()
          .min(1)
          .max(5 * 1024 * 1024),
        maxFilesPerTicket: z.number().int().min(1).max(100),
        maxTotalBytes: z
          .number()
          .int()
          .min(1)
          .max(500 * 1024 * 1024),
        allowedExtensions: z
          .array(z.string().regex(/^[a-z0-9]{1,20}$/))
          .max(100)
          .refine((v) => new Set(v).size === v.length, "Duplicate extensions"),
      })
      .strict(),
    retention: z
      .object({ tickets: retentionRule, attachments: retentionRule, audits: retentionRule })
      .strict(),
  })
  .strict();
export type DataPolicy = z.infer<typeof dataPolicySchema>;
export const defaultDataPolicy: DataPolicy = {
  revision: 0,
  legalHold: false,
  attachments: {
    maxFileBytes: 5 * 1024 * 1024,
    maxFilesPerTicket: 10,
    maxTotalBytes: 50 * 1024 * 1024,
    allowedExtensions: [],
  },
  retention: {
    tickets: { days: null, legalHold: false },
    attachments: { days: null, legalHold: false },
    audits: { days: null, legalHold: false },
  },
};

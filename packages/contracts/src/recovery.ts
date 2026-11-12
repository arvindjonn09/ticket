import { z } from "zod";

const organisation = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .transform((value) => value.toLowerCase());
export const forgotPasswordSchema = z
  .object({
    organisation,
    email: z
      .string()
      .trim()
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
  })
  .strict();
export const resetPasswordSchema = z
  .object({
    organisation,
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    password: z.string().min(12).max(256),
  })
  .strict();

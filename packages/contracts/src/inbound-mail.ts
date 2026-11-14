import { z } from "zod";

export const inboundMailSettingsSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    triageDepartmentId: z.string().uuid(),
    triageCategoryId: z.string().uuid(),
    allowUnverifiedSenders: z.boolean(),
  })
  .strict();
export const inboundMailAddressSchema = z
  .object({
    id: z.string().uuid().optional(),
    revision: z.number().int().nonnegative().optional(),
    address: z
      .string()
      .trim()
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
    departmentId: z.string().uuid(),
    categoryId: z.string().uuid(),
    isGeneral: z.boolean(),
    active: z.boolean().default(true),
  })
  .strict();
export const inboundMailViewSchema = z.object({
  revision: z.number().int().nonnegative(),
  configured: z.boolean(),
  secretConfigured: z.boolean(),
  triageDepartmentId: z.string().uuid().nullable(),
  triageCategoryId: z.string().uuid().nullable(),
  allowUnverifiedSenders: z.boolean(),
  addresses: z.array(
    z.object({
      id: z.string().uuid(),
      address: z.string().email(),
      departmentId: z.string().uuid(),
      categoryId: z.string().uuid(),
      isGeneral: z.boolean(),
      active: z.boolean(),
      revision: z.number().int().nonnegative(),
    }),
  ),
  departments: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
  categories: z.array(
    z.object({ id: z.string().uuid(), name: z.string(), departmentId: z.string().uuid() }),
  ),
});
export const emailCategorySelectionSchema = z
  .object({ revision: z.number().int().nonnegative(), categoryId: z.string().uuid() })
  .strict();
export const emailCategoryViewSchema = z.object({
  categories: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
});

export type InboundMailSettings = z.infer<typeof inboundMailSettingsSchema>;
export type InboundMailAddress = z.infer<typeof inboundMailAddressSchema>;
export type InboundMailView = z.infer<typeof inboundMailViewSchema>;

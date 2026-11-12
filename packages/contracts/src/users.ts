import { z } from 'zod';

const text = (max: number) => z.string().trim().max(max);
export const createUserSchema = z.object({
  name: text(120).min(1), email: text(254).email().transform(value => value.toLowerCase()),
  role: z.enum(['employee', 'agent', 'admin']), approverEligible: z.boolean(), isVp: z.boolean().default(false),
  managerId: z.string().uuid().nullable(), homeDepartment: text(120), phone: text(80), jobTitle: text(120)
}).strict().refine(value => !value.isVp || value.approverEligible, 'VP must be eligible to approve');
export const updateUserSchema = createUserSchema.safeExtend({ active: z.boolean(), revision: z.number().int().nonnegative() });
export const invitationActivationSchema = z.object({ organisation: text(80).min(1), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), password: z.string().min(12).max(256) }).strict();
export const passwordChangeSchema = z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(12).max(256) }).strict();
export const userImportSchema = z.object({ csv: z.string().min(1).max(100000) }).strict();
export const userImportCommitSchema = z.object({ previewToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export const organisationSettingsSchema = z.object({
  name: text(120).min(1), brandName: text(120).min(1), timezone: text(80).min(1), locale: text(40).min(1),
  primaryColour: z.string().regex(/^#[0-9a-f]{6}$/i), incidentPrefix: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/),
  requestPrefix: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/), defaultPriority: z.enum(['P1', 'P2', 'P3', 'P4', 'P5']),
  defaultSeverity: z.enum(['S1', 'S2', 'S3', 'S4']), revision: z.number().int().nonnegative()
}).strict().refine(value => value.incidentPrefix !== value.requestPrefix, 'Incident and request prefixes must differ');
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UserProfile = CreateUserInput & { id: string; active: boolean; revision: number; createdAt: string; updatedAt: string; invitedAt: string | null; invitationPending: boolean };
export type UserInvitation = { user: UserProfile; invitation: { url: string; expiresAt: string }; emailQueued?: boolean };
export type UserImportPreview = { rows: { row: number; user: CreateUserInput | null; errors: string[] }[]; valid: boolean; previewToken: string | null; expiresAt: string | null };
export type OrganisationSettings = z.infer<typeof organisationSettingsSchema> & { id: string };
export type ProfileHistory = UserProfile & { tickets: { id: string; number: string; summary: string; state: string; createdAt: string; updatedAt: string }[]; limitReached: boolean };

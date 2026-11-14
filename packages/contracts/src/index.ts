import { z } from "zod";
export {
  proposedSlaSettings,
  slaSettingsSchema,
  slaSettingsViewSchema,
  type SlaSettingsInput,
  type SlaSettingsView,
} from "./sla.js";
export {
  emailCategorySelectionSchema,
  emailCategoryViewSchema,
  inboundMailAddressSchema,
  inboundMailSettingsSchema,
  inboundMailViewSchema,
  type InboundMailAddress,
  type InboundMailSettings,
  type InboundMailView,
} from "./inbound-mail.js";

export const ticketStates = [
  "Open",
  "Pending Approval",
  "In Progress",
  "On Hold",
  "Resolved",
  "Complete",
  "Cancelled",
  "Rejected",
] as const;
export const priorities = ["P1", "P2", "P3", "P4", "P5"] as const;
export const loginSchema = z
  .object({
    organisation: z.string().trim().min(1).max(80),
    email: z.string().trim().email().max(254),
    password: z.string().min(1).max(256),
    totpCode: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
  })
  .strict();
export const channels = ["Email", "Phone", "Self Service", "Walk In"] as const;
export const createTicketSchema = z
  .object({
    categoryId: z.string().uuid(),
    subcategoryId: z.string().uuid().optional(),
    callerId: z.string().uuid().optional(),
    summary: z.string().trim().min(5).max(160),
    description: z.string().trim().min(10).max(5000),
    channel: z.enum(channels).default("Self Service"),
  })
  .strict();
export const revisionSchema = z.object({ revision: z.number().int().nonnegative() }).strict();
export const messageSchema = revisionSchema.extend({
  body: z.string().trim().min(1).max(5000),
  audience: z.enum(["customer", "internal"]),
});
export const stateSchema = revisionSchema.extend({
  state: z.enum(ticketStates),
  resolution: z.string().trim().min(1).max(5000).optional(),
  customerSummary: z.string().trim().min(1).max(5000).optional(),
  reason: z.string().trim().min(1).max(2000).optional(),
  holdReason: z.string().trim().min(1).max(2000).optional(),
  duplicateOfId: z.string().uuid().optional(),
});
export const ticketQuerySchema = z
  .object({
    search: z.string().trim().max(160).optional(),
    state: z.enum(ticketStates).optional(),
    priority: z.enum(priorities).optional(),
    scope: z.enum(["all", "mine"]).optional(),
    type: z.enum(["incident", "request"]).optional(),
    departmentId: z.string().uuid().optional(),
    categoryId: z.string().uuid().optional(),
    channel: z.enum(channels).optional(),
    assignedToId: z.string().uuid().optional(),
    assigned: z.enum(["unassigned", "me"]).optional(),
    untriaged: z.enum(["true", "false"]).optional(),
    cursor: z.string().max(256).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine(
    (input) => !input.assigned || !input.assignedToId,
    "Choose either assigned or assignedToId",
  );
export const notificationPreferenceSchema = z
  .object({ mode: z.enum(["immediate", "daily", "off"]) })
  .strict();
export const notificationPreferenceViewSchema = notificationPreferenceSchema;
export const sessionViewSchema = z.object({
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    role: z.enum(["employee", "agent", "admin"]),
    departmentIds: z.array(z.string()),
  }),
  tenant: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    brandName: z.string(),
    timezone: z.string().optional(),
    locale: z.string().optional(),
    primaryColour: z.string().optional(),
  }),
  csrfToken: z.string(),
  mfaVerified: z.boolean().optional(),
});
export const ticketSummarySchema = z.object({
  id: z.string(),
  number: z.string(),
  summary: z.string(),
  description: z.string(),
  state: z.enum(ticketStates),
  priority: z.enum(priorities),
  severity: z.string(),
  categoryId: z.string(),
  categoryName: z.string(),
  subcategoryId: z.string().nullable(),
  subcategoryName: z.string().nullable(),
  departmentId: z.string(),
  departmentName: z.string(),
  callerId: z.string(),
  callerName: z.string(),
  assignedToId: z.string().nullable(),
  assignedToName: z.string().nullable(),
  revision: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  type: z.enum(["incident", "request"]),
  requestedForId: z.string().nullable(),
  requestedForName: z.string().nullable(),
  itemId: z.string().nullable(),
  itemName: z.string().nullable(),
  quantity: z.number().nullable(),
  unitCostMinor: z.number().nullable(),
  totalCostMinor: z.number().nullable(),
  currency: z.string().nullable(),
  justification: z.string().nullable(),
  approvalVersion: z.number(),
  approvalCorrectionReason: z.string().nullable(),
  untriaged: z.boolean(),
  channel: z.string(),
  holdReason: z.string().nullable(),
  previousState: z.string().nullable(),
  submittedById: z.string(),
  submittedByName: z.string(),
  duplicateOfId: z.string().nullable(),
  slaFirstResponseDueAt: z.string().nullable(),
  slaResolutionDueAt: z.string().nullable(),
  slaFirstRespondedAt: z.string().nullable(),
  inboundUnverified: z.boolean(),
});
export const approvalViewSchema = z.object({
  id: z.string(),
  stage: z.enum(["manager", "vp"]),
  status: z.enum(["Pending", "Approved", "Rejected", "Invalidated"]),
  version: z.number(),
  approverId: z.string().nullable(),
  approverName: z.string().nullable(),
  decidedById: z.string().nullable(),
  decidedByName: z.string().nullable(),
  comment: z.string().nullable(),
  decidedAt: z.string().nullable(),
  correctionReason: z.string().nullable(),
});
export const ticketDetailSchema = ticketSummarySchema.extend({
  activities: z.array(
    z.object({
      id: z.string(),
      body: z.string(),
      audience: z.enum(["customer", "internal"]),
      authorName: z.string(),
      createdAt: z.string(),
    }),
  ),
  approvals: z.array(approvalViewSchema),
  inboundSenderEmail: z.string().email().nullable(),
});
export type SessionView = z.infer<typeof sessionViewSchema>;
export type TicketSummary = z.infer<typeof ticketSummarySchema>;
export type TicketDetail = z.infer<typeof ticketDetailSchema>;
export type TicketState = (typeof ticketStates)[number];
export type Priority = (typeof priorities)[number];

const nameSchema = z.string().trim().min(1).max(120);
const memberIdsSchema = z
  .array(z.string().uuid())
  .max(1000)
  .refine((ids) => new Set(ids).size === ids.length, "Duplicate members");
export const mfaVerifySchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
export const createGroupSchema = z
  .object({
    name: nameSchema,
    memberIds: memberIdsSchema,
    queueOwnerId: z.string().uuid().nullable().optional(),
    substituteId: z.string().uuid().nullable().optional(),
  })
  .strict();
export const updateGroupSchema = createGroupSchema.extend({
  revision: z.number().int().nonnegative(),
  active: z.boolean(),
});
export const createCategorySchema = z
  .object({
    name: nameSchema,
    departmentId: z.string().uuid(),
    sensitive: z.boolean(),
    allowIncidents: z.boolean().default(true),
    allowRequests: z.boolean().default(true),
  })
  .strict();
export const updateCategorySchema = createCategorySchema.extend({
  revision: z.number().int().nonnegative(),
  active: z.boolean(),
  allowIncidents: z.boolean().optional(),
  allowRequests: z.boolean().optional(),
});
export const createSubcategorySchema = z
  .object({
    categoryId: z.string().uuid(),
    name: nameSchema,
    departmentId: z.string().uuid().nullable(),
  })
  .strict();
export const updateSubcategorySchema = createSubcategorySchema
  .omit({ categoryId: true })
  .extend({ revision: z.number().int().nonnegative(), active: z.boolean() });
export type Group = {
  id: string;
  name: string;
  active: boolean;
  isTriage: boolean;
  revision: number;
  memberIds: string[];
  queueOwnerId?: string | null;
  substituteId?: string | null;
};
export type AdminCategory = {
  id: string;
  name: string;
  departmentId: string;
  active: boolean;
  sensitive: boolean;
  revision: number;
  allowIncidents?: boolean;
  allowRequests?: boolean;
};
export type AdminSubcategory = {
  id: string;
  categoryId: string;
  name: string;
  departmentId: string | null;
  active: boolean;
  revision: number;
};
export type AdminConfig = {
  organisation: { id: string; name: string; brandName: string };
  groups: Group[];
  agents: { id: string; name: string; email: string }[];
  categories: AdminCategory[];
  subcategories: AdminSubcategory[];
};

const moneySchema = z.number().int().min(0).max(2_000_000_000);
export const createRequestItemSchema = z
  .object({
    name: nameSchema,
    categoryId: z.string().uuid(),
    unitCostMinor: moneySchema,
    currency: z.string().regex(/^[A-Z]{3}$/),
    recurringPeriod: z.enum(["month", "year"]).nullable().default(null),
    requiresManager: z.boolean(),
    requiresVp: z.boolean(),
    vpThresholdMinor: moneySchema.nullable(),
    vpApproverId: z.string().uuid().nullable(),
    alternateApproverId: z.string().uuid().nullable(),
    active: z.boolean().default(true),
  })
  .strict();
export const updateRequestItemSchema = createRequestItemSchema.extend({
  revision: z.number().int().nonnegative(),
});
export type CatalogItem = z.infer<typeof createRequestItemSchema> & {
  id: string;
  revision: number;
};
export const createRequestSchema = z
  .object({
    itemId: z.string().uuid(),
    requestedForId: z.string().uuid(),
    quantity: z.number().int().min(1).max(10000),
    summary: z.string().trim().min(5).max(160),
    description: z.string().trim().min(10).max(5000),
    justification: z.string().trim().max(5000).optional(),
    subcategoryId: z.string().uuid().optional(),
    channel: z.enum(channels).default("Self Service"),
  })
  .strict();
export const changeRequestSchema = revisionSchema.extend({
  reason: z.string().trim().min(1).max(2000),
  itemId: z.string().uuid(),
  requestedForId: z.string().uuid(),
  quantity: z.number().int().min(1).max(10000),
  unitCostMinor: moneySchema.optional(),
});
export const correctionSchema = revisionSchema.extend({
  reason: z.string().trim().min(1).max(2000),
});
export const approvalDecisionSchema = revisionSchema
  .extend({
    version: z.number().int().positive(),
    decision: z.enum(["Approved", "Rejected"]),
    comment: z.string().trim().min(1).max(2000).optional(),
  })
  .refine((v) => v.decision !== "Rejected" || !!v.comment, "Rejection requires a reason");
export const delegationSchema = z
  .object({
    delegateId: z.string().uuid(),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((v) => Date.parse(v.startsAt) < Date.parse(v.endsAt), "Delegation end must follow start");
export const manageTicketSchema = revisionSchema.extend({
  action: z.enum(["triage", "transfer", "category", "assign"]),
  reason: z.string().trim().min(1).max(2000),
  priority: z.enum(priorities).optional(),
  severity: z.enum(["S1", "S2", "S3", "S4"]).optional(),
  departmentId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  subcategoryId: z.string().uuid().optional(),
  assignedToId: z.string().uuid().nullable().optional(),
});
export type ApprovalView = z.infer<typeof approvalViewSchema>;
export type ApprovalQueueEntry = ApprovalView & {
  ticketId: string;
  number: string;
  summary: string;
  revision: number;
  requestedForName: string;
  totalCostMinor: number;
  currency: string;
  createdAt: string;
  callerName: string;
  itemName: string;
  justification: string | null;
};
export * from "./users.js";
export * from "./data-policy.js";
export * from "./recovery.js";
export * from "./automation.js";

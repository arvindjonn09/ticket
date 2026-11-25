import type { Tx } from "./database.js";

const translations = { en: { emailFooter: "Sent by Astrama ticketing" } };

export function brandingUrl(slug: string) {
  const origin = process.env.PUBLIC_SITE_ORIGIN ?? process.env.APP_ORIGIN;
  if (!origin) return undefined;
  const url = new URL("/", origin);
  if (slug) url.searchParams.set("ref", slug);
  return url.toString();
}

export async function tenantBranding(tx: Tx, tenantId: string) {
  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { slug: true, locale: true, billingPlan: { select: { hideBranding: true } } },
  });
  return {
    hideBranding: tenant.billingPlan?.hideBranding === true,
    brandingUrl: brandingUrl(tenant.slug),
    locale: tenant.locale,
  };
}

export async function brandedMailText(tx: Tx, tenantId: string, text: string) {
  return brandedText(text, await tenantBranding(tx, tenantId));
}

export function brandedText(
  text: string,
  branding: {
    hideBranding: boolean;
    brandingUrl?: string;
    locale: string;
  },
) {
  if (branding.hideBranding) return text;
  const language = branding.locale.split("-")[0] as keyof typeof translations;
  const message = (translations[language] ?? translations.en).emailFooter;
  return `${text}\n\n${message}${branding.brandingUrl ? `: ${branding.brandingUrl}` : ""}`;
}

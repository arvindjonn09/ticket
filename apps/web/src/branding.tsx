import { useTranslation } from "react-i18next";
import type { SessionView } from "./types";

export type BrandingProps = Pick<SessionView["tenant"], "hideBranding" | "brandingUrl">;

export function PoweredByAstrama({ hideBranding, brandingUrl }: BrandingProps) {
  const { t } = useTranslation();
  if (hideBranding === true) return null;
  return (
    <span className="powered-by-astrama">
      {brandingUrl ? <a href={brandingUrl}>{t("poweredByAstrama")}</a> : t("poweredByAstrama")}
    </span>
  );
}

function currencyScale(currency: string) {
  return (
    10 **
    new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits!
  );
}
export function majorCost(minor: number, currency: string) {
  return minor / currencyScale(currency);
}
export function minorCost(major: number, currency: string) {
  return Math.round(major * currencyScale(currency));
}
export function money(minor: number, currency: string) {
  return new Intl.NumberFormat("en", { style: "currency", currency }).format(
    majorCost(minor, currency),
  );
}

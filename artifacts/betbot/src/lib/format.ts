export function formatCurrency(amount: number | null | undefined, currency = "GBP"): string {
  if (amount === null || amount === undefined) return "£0.00";
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatNumber(num: number | null | undefined, decimals = 2): string {
  if (num === null || num === undefined) return "0.00";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(num);
}

export function formatPercent(num: number | null | undefined): string {
  if (num === null || num === undefined) return "0.00%";
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
}

export function formatDate(dateString: string | null | undefined): string {
  if (!dateString) return "-";
  return new Date(dateString).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatShortDate(dateString: string | null | undefined): string {
  if (!dateString) return "-";
  return new Date(dateString).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

// Currency metadata and the one money formatter (client and server).
//
// v1 stores money in 2-decimal columns only, so only 2-decimal currencies are
// selectable; 3-decimal and 0-decimal codes are listed but refused (the
// database refuses them too). A cafe has one currency; its branches mirror it.

export type CurrencyMeta = { code: string; nameAr: string; symbol: string; decimals: 0 | 2 | 3; supported: boolean };

export const CURRENCIES: readonly CurrencyMeta[] = [
  { code: "EGP", nameAr: "جنيه مصري", symbol: "ج.م", decimals: 2, supported: true },
  { code: "SAR", nameAr: "ريال سعودي", symbol: "ر.س", decimals: 2, supported: true },
  { code: "AED", nameAr: "درهم إماراتي", symbol: "د.إ", decimals: 2, supported: true },
  { code: "QAR", nameAr: "ريال قطري", symbol: "ر.ق", decimals: 2, supported: true },
  { code: "MAD", nameAr: "درهم مغربي", symbol: "د.م.", decimals: 2, supported: true },
  { code: "TRY", nameAr: "ليرة تركية", symbol: "₺", decimals: 2, supported: true },
  { code: "LBP", nameAr: "ليرة لبنانية", symbol: "ل.ل", decimals: 2, supported: true },
  { code: "USD", nameAr: "دولار أمريكي", symbol: "$", decimals: 2, supported: true },
  { code: "EUR", nameAr: "يورو", symbol: "€", decimals: 2, supported: true },
  { code: "GBP", nameAr: "جنيه إسترليني", symbol: "£", decimals: 2, supported: true },
  { code: "KWD", nameAr: "دينار كويتي", symbol: "د.ك", decimals: 3, supported: false },
  { code: "BHD", nameAr: "دينار بحريني", symbol: "د.ب", decimals: 3, supported: false },
  { code: "OMR", nameAr: "ريال عماني", symbol: "ر.ع", decimals: 3, supported: false },
  { code: "JOD", nameAr: "دينار أردني", symbol: "د.أ", decimals: 3, supported: false },
  { code: "TND", nameAr: "دينار تونسي", symbol: "د.ت", decimals: 3, supported: false },
  { code: "LYD", nameAr: "دينار ليبي", symbol: "د.ل", decimals: 3, supported: false },
  { code: "IQD", nameAr: "دينار عراقي", symbol: "د.ع", decimals: 3, supported: false },
  { code: "JPY", nameAr: "ين ياباني", symbol: "¥", decimals: 0, supported: false },
];

export const SUPPORTED_CURRENCY_CODES = CURRENCIES.filter(c => c.supported).map(c => c.code);

/** The tables whose rows lock a cafe's currency. Mirrors `currency_lock_has_records` in the
 * `branch_currency` migration (a test keeps the two identical). */
export const CURRENCY_LOCK_TABLES = [
  "Shift", "Order", "Payment", "OrderRevision", "AmendmentSettlement", "TableSession",
  "OperatingExpense", "OperatingExpenseReturn",
  "PurchaseInvoice", "PurchasePayment",
  "MoneyAccount", "MoneyTransfer", "MoneyMovement",
  "AccountingEntity", "JournalLine",
  "InventoryTransaction",
  "CashStorage", "CashDeliveryDeclaration", "OpeningCashReceipt", "CustodyPeriod", "ShiftCashDisposition", "HandoverSession",
  "LoyaltyTransaction", "HistoricalSaleLine",
] as const;

export function currencyMeta(code: string | null | undefined): CurrencyMeta | undefined {
  return CURRENCIES.find(c => c.code === code);
}

/** The Arabic symbol for labels («ج.م»), or the code itself for a legacy/unknown currency. */
export function currencySymbol(code: string | null | undefined): string {
  const meta = currencyMeta(code);
  return meta?.supported ? meta.symbol : code ?? "";
}

export function isSupportedCurrency(code: unknown): code is string {
  return typeof code === "string" && SUPPORTED_CURRENCY_CODES.includes(code);
}

/** Arabic symbol after the number: `1,234.5 ر.س`. Whole amounts drop the decimals on screen (the
 * rule EGP has always followed, so EGP output is unchanged); `fixed` always shows two decimals. */
export function formatMoney(
  value: number | string,
  code = "EGP",
  opts: { fixed?: boolean; iso?: boolean } = {},
): string {
  const n = Number(value);
  const meta = currencyMeta(code);
  if (!meta || !meta.supported) {
    // Legacy or unknown code: never throw while rendering a screen.
    try {
      return new Intl.NumberFormat("en", { style: "currency", currency: code }).format(n);
    } catch {
      return `${Number.isFinite(n) ? n.toFixed(2) : String(value)} ${code}`;
    }
  }
  const formatted = new Intl.NumberFormat("en-EG", {
    minimumFractionDigits: opts.fixed ? 2 : n % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(n);
  return `${formatted} ${opts.iso ? meta.code : meta.symbol}`;
}

/** The 80mm receipt's amount style: whole numbers bare, otherwise two decimals, symbol after. For EGP this is
 * exactly the string the receipt printed before currencies existed. */
export function receiptMoney(code: string): (v: number | string | { toString(): string }) => string {
  const meta = currencyMeta(code);
  const symbol = meta?.supported ? meta.symbol : code;
  return (v) => {
    const n = Number(v);
    const s = Number.isInteger(n) ? String(n) : n.toFixed(2);
    return `${s} ${symbol}`;
  };
}

/** The single currency of a set of cafes, or null when they differ: amounts of different currencies must
 * never be added or ranked together, so platform-wide totals are only shown for a single currency. */
export function platformCurrency(currencies: readonly string[]): string | null {
  const distinct = [...new Set(currencies)];
  return distinct.length === 0 ? "EGP" : distinct.length === 1 ? distinct[0] : null;
}

/** Export column header: «المبلغ (SAR)». EGP keeps the «(ج.م)» header every existing export already has, so
 * EGP files stay byte-identical; every other currency is labelled with its ISO code. */
export function moneyHeader(label: string, code: string): string {
  return `${label} (${code === "EGP" ? "ج.م" : code})`;
}

/** Summing money across rows is only meaningful inside one currency; fail loudly otherwise. */
export function assertSameCurrency(rows: readonly { currency?: string | null }[], expected?: string): string | undefined {
  let seen = expected;
  for (const row of rows) {
    if (!row.currency) continue;
    if (seen === undefined) seen = row.currency;
    else if (row.currency !== seen) throw new Error(`Refusing to sum amounts in different currencies (${seen} and ${row.currency})`);
  }
  return seen;
}

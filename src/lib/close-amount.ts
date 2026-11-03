// HND-UX-004 close screen input rule, kept pure so it can be tested directly.
//
// A typed amount, or null. Blank is NOT zero — `Number("") || 0` would turn an
// untouched drawer field into an affirmative "0 in the drawer". Two decimals
// at most (the money columns are Decimal(10,2)); card and wallet settlements
// may be negative after refunds, cash may not.
const UNSIGNED = /^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/;
const SIGNED = /^-?(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/;

export function parseAmount(value: string, signed: boolean): number | null {
  const text = value.trim();
  if (text === "") return null;
  if (!(signed ? SIGNED : UNSIGNED).test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

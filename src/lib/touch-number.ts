/** Normalize Arabic digits without guessing separators or rounding entered money. */
export function normalizeTouchNumber(value: string): string {
  return value.replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 0x6f0)).replace(/٫/g, ".");
}

export function touchNumberError(value: string, {min, max, integer = false, required = false, signed = false}: {
  min?: number; max?: number; integer?: boolean; required?: boolean; signed?: boolean;
} = {}): string | null {
  const normalized = normalizeTouchNumber(value).trim();
  if (!normalized) return required ? "أدخل قيمة" : null;
  if (!(signed ? /^-?\d+(\.\d{1,2})?$/ : /^\d+(\.\d{1,2})?$/).test(normalized)) return "أدخل رقمًا صالحًا (منزلتان عشريتان بحد أقصى)";
  const number = Number(normalized);
  if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER) return "القيمة كبيرة جدًا";
  if (integer && !Number.isInteger(number)) return "أدخل عددًا صحيحًا";
  if (min !== undefined && number < min) return `أقل قيمة مسموحة ${min}`;
  if (max !== undefined && number > max) return `أكبر قيمة مسموحة ${max}`;
  return null;
}

// Egyptian phone normalization — the identity key for customer profiles.
// All of these map to the same canonical local form 01012345678:
//   "010 1234 5678", "+201012345678", "00201012345678", "201012345678"
// Returns null when the input can't be a valid Egyptian mobile number.
export function normalizeEgyptianPhone(raw: string): string | null {
  let digits = raw.replace(/[\s\-()]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (!/^\d+$/.test(digits)) return null;

  // Strip country prefixes: 0020… / 20…
  if (digits.startsWith("0020")) digits = digits.slice(4);
  else if (digits.startsWith("002")) digits = digits.slice(3);
  else if (digits.startsWith("20") && digits.length > 10) digits = digits.slice(2);

  // Re-add the local leading zero if the prefix strip removed it.
  if (digits.length === 10 && digits.startsWith("1")) digits = "0" + digits;

  // Egyptian mobiles: 01[0125] + 8 digits.
  if (/^01[0125]\d{8}$/.test(digits)) return digits;
  return null;
}

// Loose validity check for input fields (server rejects anything that
// doesn't normalize).
export function isValidEgyptianPhone(raw: string): boolean {
  return normalizeEgyptianPhone(raw) !== null;
}

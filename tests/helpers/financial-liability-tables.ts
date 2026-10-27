/**
 * Discover the financial surfaces excluded by the variance milestone.
 * Recipe consumption also uses "deduction", so that word needs an employee
 * or money qualifier. Explicit payroll, debt and liability classes always
 * match, even when an identifier also mentions stock or orders.
 */
export function isFinancialLiabilityTable(tableName: string): boolean {
  const words = tableName
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  if (words.some((word) => /^(payroll|salary|salaries|wages?|compensation|debts?|liability|liabilities)$/.test(word))) {
    return true;
  }

  const obligation = words.some((word) => /^(deductions?|penalt(y|ies))$/.test(word));
  const financialSubject = words.some((word) => /^(employees?|staff|personnel|workers?|users?|hr|financial|money|cash|pay)$/.test(word));
  return obligation && financialSubject;
}

/** Prisma wraps PostgreSQL errors differently for raw and model queries. */
export function sqlState(error: unknown): string | undefined {
  const seen = new Set<object>();
  function visit(value: unknown): string | undefined {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const row = value as Record<string, unknown>;
    for (const key of ["code", "sqlState", "sqlstate", "originalCode"]) {
      if (typeof row[key] === "string" && /^[0-9A-Z]{5}$/.test(row[key] as string) && !(row[key] as string).startsWith("P")) return row[key] as string;
    }
    for (const key of ["meta", "cause", "originalError", "driverAdapterError", "error"]) {
      const code = visit(row[key]); if (code) return code;
    }
  }
  return visit(error);
}

export function isDatabaseContention(error: unknown): boolean {
  return ["55P03", "57014", "40P01", "40001"].includes(sqlState(error) ?? "") ||
    !!(error && typeof error === "object" && "code" in error && error.code === "P2034");
}

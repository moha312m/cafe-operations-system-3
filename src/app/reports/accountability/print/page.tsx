import { ApiError } from "@/lib/api";
import { accountabilityFromParams } from "@/lib/reports/handover-accountability-request";
import { PRINT_CSS, reportPrintBody } from "@/lib/reports/handover-accountability-output";
import { PrintButton } from "@/components/reports/print-button";

export const dynamic = "force-dynamic";

const FONT = "var(--font-plex-arabic), 'Segoe UI', Tahoma, sans-serif";

/** The printable HTML, or the reason the viewer may not have it. */
async function load(params: URLSearchParams): Promise<{ html: string } | { error: string }> {
  try {
    return { html: reportPrintBody(await accountabilityFromParams(params, { export: true })) };
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : "تعذر تحميل التقرير" };
  }
}

// The A4 print of the accountability report. It sits outside the app shell so
// nothing but the report prints, and inside the root layout so it prints in
// the app's own font. The 80mm receipts are separate pages and untouched.
export default async function AccountabilityPrintPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string") params.set(k, v);
  const result = await load(params);
  if ("error" in result) {
    return <main dir="rtl" style={{ padding: 24, fontFamily: FONT }}><p role="alert">{result.error}</p></main>;
  }
  return (
    <main dir="rtl" className="acc-print" style={{ fontFamily: FONT }}>
      <style>{PRINT_CSS}</style>
      <div className="bar"><PrintButton /></div>
      <div dangerouslySetInnerHTML={{ __html: result.html }} />
    </main>
  );
}

import { NextResponse, type NextRequest } from "next/server";
import { handleApiError } from "@/lib/api";
import { accountabilityFromParams, accountabilityOptions } from "@/lib/reports/handover-accountability-request";

export async function GET(request: NextRequest) {
  try {
    const p = request.nextUrl.searchParams;
    const report = await accountabilityFromParams(p);
    return NextResponse.json({ ...report, options: await accountabilityOptions(p) });
  } catch (error) {
    return handleApiError(error);
  }
}

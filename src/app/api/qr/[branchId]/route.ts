import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handleApiError, ApiError } from "@/lib/api";
import { loadCustomerMenu } from "@/lib/customer-menu";

type Params = { params: Promise<{ branchId: string }> };

// Public QR menu API: same loader as the /menu pages, so prices,
// visibility, and availability rules are identical everywhere.
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const { branchId } = await params;
    const branch = await db.branch.findUnique({
      where: { id: branchId },
      include: { cafe: true },
    });

    const result = await loadCustomerMenu(branch);
    if (result.status === "not-found") throw new ApiError(404, "المنيو ده مش متاح");
    if (result.status === "disabled" || result.status === "suspended") {
      throw new ApiError(403, "المنيو غير متاح حاليًا");
    }

    return NextResponse.json(result.menu);
  } catch (error) {
    return handleApiError(error);
  }
}

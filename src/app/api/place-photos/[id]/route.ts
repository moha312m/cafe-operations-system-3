import { NextResponse } from "next/server";
import { requireKey, handleApiError } from "@/lib/api";
import { readPlacePhoto } from "@/lib/place-media";
type Params = { params: Promise<{ id: string }> };
export async function GET(_request: Request, { params }: Params) {
  try {
    const actor = await requireKey("handover.view");
    const { id } = await params;
    const photo = await readPlacePhoto({ photoId: id, actor });
    return new NextResponse(new Uint8Array(photo.bytes), { headers: { "Content-Type": photo.mime, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return handleApiError(error); }
}

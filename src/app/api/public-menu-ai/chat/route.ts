import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getPublicMenuForAI, askMenuAssistant, aiAssistantAvailable } from "@/lib/menu-ai";
import { audit } from "@/lib/audit";
import { getCafeSettings } from "@/lib/cafe-settings";

export const dynamic = "force-dynamic";

// Public (unauthenticated) customer endpoint. Everything is resolved and
// scoped server-side: the branch is looked up from the branchId, its cafe
// is derived from the DB, and the model only ever sees that branch's
// public menu. No cafeId is trusted from the request body.
const bodySchema = z.object({
  branchId: z.string().min(1),
  message: z.string().min(1).max(500),
  cart: z.array(z.string()).max(50).optional(),
});

// Best-effort in-memory rate limit (per-instance): 15 requests / minute / IP.
const HITS = new Map<string, { count: number; resetAt: number }>();
const LIMIT = 15;
const WINDOW = 60_000;

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = HITS.get(ip);
  if (!entry || now > entry.resetAt) {
    HITS.set(ip, { count: 1, resetAt: now + WINDOW });
    return false;
  }
  entry.count += 1;
  return entry.count > LIMIT;
}

export async function POST(request: NextRequest) {
  try {
    // Availability check first — keep the QR menu working without a key.
    if (!aiAssistantAvailable()) {
      return NextResponse.json(
        { reply: "المساعد الذكي غير متاح حاليًا", productIds: [], unavailable: true },
        { status: 200 }
      );
    }

    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      "unknown";
    if (rateLimited(ip)) {
      return NextResponse.json(
        { reply: "استنى شوية وجرّب تاني 🙏", productIds: [] },
        { status: 429 }
      );
    }

    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: "طلب غير صحيح" }, { status: 400 });
    }
    const { branchId, message, cart } = parsed.data;

    const menuResult = await getPublicMenuForAI(branchId);
    if (menuResult.status !== "ok") {
      return NextResponse.json(
        { reply: "المنيو غير متاح حاليًا", productIds: [] },
        { status: 200 }
      );
    }

    // Cafe-level feature gate: the assistant may be turned off for this cafe.
    const settings = await getCafeSettings(menuResult.cafeId);
    if (!settings.aiAssistantEnabled) {
      return NextResponse.json(
        { reply: "المساعد الذكي غير متاح حاليًا", productIds: [], unavailable: true },
        { status: 200 }
      );
    }

    const result = await askMenuAssistant(menuResult.menu, message, cart);
    if (result.status === "unavailable") {
      return NextResponse.json(
        { reply: "المساعد الذكي غير متاح حاليًا", productIds: [], unavailable: true },
        { status: 200 }
      );
    }
    if (result.status === "error") {
      return NextResponse.json(
        { reply: "حصلت مشكلة، جرب تاني", productIds: [] },
        { status: 200 }
      );
    }

    // Minimal audit (no PII): the message + recommended ids, scoped to the
    // resolved cafe/branch, with userId null (public customer).
    await audit({
      cafeId: menuResult.cafeId,
      userId: null,
      action: "AI_MENU_ASSISTANT_MESSAGE",
      entity: "Branch",
      entityId: menuResult.branchDbId,
      details: { branchId: menuResult.branchDbId, message: message.slice(0, 500) },
    });
    if (result.productIds.length > 0) {
      await audit({
        cafeId: menuResult.cafeId,
        userId: null,
        action: "AI_MENU_ASSISTANT_RECOMMENDATION",
        entity: "Branch",
        entityId: menuResult.branchDbId,
        details: { branchId: menuResult.branchDbId, productIds: result.productIds },
      });
    }

    return NextResponse.json({ reply: result.reply, productIds: result.productIds });
  } catch (error) {
    console.error("menu-ai chat error", error);
    return NextResponse.json({ reply: "حصلت مشكلة، جرب تاني", productIds: [] }, { status: 200 });
  }
}

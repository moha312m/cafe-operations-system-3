import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireKey, handleApiError, ApiError } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { normalizeEgyptianPhone } from "@/lib/phone";
import { sealSecret } from "@/lib/secret-box";
import { maskPhone, SHIFT_REPORT_PARAM_COUNT, SHIFT_REPORT_TEMPLATE_BODY } from "@/lib/whatsapp";

// The café's WhatsApp Business connection for the shift close report.
// Owner only (settings.edit), scoped to the session's café. The access token
// is write-only: it is sealed on the way in and no response ever contains it,
// in any form — the screen is told only whether one is stored.

function cafeIdOf(session: { cafeId: string | null }) {
  if (!session.cafeId) throw new ApiError(400, "المستخدم غير مرتبط بكافيه");
  return session.cafeId;
}

async function view(cafeId: string) {
  const [row, logs] = await Promise.all([
    db.whatsAppIntegration.findUnique({ where: { cafeId } }),
    db.whatsAppMessageLog.findMany({
      where: { cafeId },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { createdAt: true, status: true, trigger: true, error: true, recipientMasked: true, shiftId: true },
    }),
  ]);
  return {
    enabled: row?.enabled ?? false,
    phoneNumberId: row?.phoneNumberId ?? "",
    templateName: row?.templateName ?? "",
    templateLanguage: row?.templateLanguage ?? "ar",
    recipientPhone: row?.recipientPhone ?? "",
    tokenSet: !!row?.accessTokenCipher,
    templateBody: SHIFT_REPORT_TEMPLATE_BODY,
    paramCount: SHIFT_REPORT_PARAM_COUNT,
    recentLogs: logs,
  };
}

export async function GET() {
  try {
    const session = await requireKey("settings.edit");
    return NextResponse.json(await view(cafeIdOf(session)));
  } catch (error) {
    return handleApiError(error);
  }
}

/** Egyptian local numbers become 20…; anything else must already be international. */
function toInternational(raw: string): string | null {
  const egyptian = normalizeEgyptianPhone(raw);
  if (egyptian) return `20${egyptian.slice(1)}`;
  const digits = raw.replace(/[\s\-()]/g, "").replace(/^\+/, "").replace(/^00/, "");
  return /^[1-9]\d{9,14}$/.test(digits) ? digits : null;
}

const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    phoneNumberId: z.string().trim().regex(/^\d{5,30}$/, "Phone Number ID أرقام بس").optional(),
    accessToken: z.string().trim().min(20, "مفتاح الوصول قصير").max(2000).regex(/^\S+$/, "مفتاح الوصول فيه مسافات").optional(),
    templateName: z.string().trim().regex(/^[a-z0-9_]{1,512}$/, "اسم القالب حروف إنجليزي صغيرة وأرقام و _ بس").optional(),
    templateLanguage: z.string().trim().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, "كود اللغة زي ar أو en_US").optional(),
    recipientPhone: z.string().trim().max(30).optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "مفيش تغيير متبعت" });

export async function PATCH(request: NextRequest) {
  try {
    const session = await requireKey("settings.edit");
    const cafeId = cafeIdOf(session);
    const input = patchSchema.parse(await request.json());

    let recipientPhone: string | undefined;
    if (input.recipientPhone !== undefined) {
      const intl = toInternational(input.recipientPhone);
      if (!intl) throw new ApiError(400, "رقم المستلم غير صحيح — اكتبه بالصيغة الدولية أو رقم مصري");
      recipientPhone = intl;
    }

    await db.$transaction(async (tx) => {
      const prev = await tx.whatsAppIntegration.findUnique({ where: { cafeId } });
      const data = {
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.phoneNumberId !== undefined ? { phoneNumberId: input.phoneNumberId } : {}),
        ...(input.accessToken !== undefined ? { accessTokenCipher: sealSecret(input.accessToken) } : {}),
        ...(input.templateName !== undefined ? { templateName: input.templateName } : {}),
        ...(input.templateLanguage !== undefined ? { templateLanguage: input.templateLanguage } : {}),
        ...(recipientPhone !== undefined ? { recipientPhone } : {}),
        updatedById: session.id,
      };
      const next = {
        enabled: data.enabled ?? prev?.enabled ?? false,
        phoneNumberId: data.phoneNumberId ?? prev?.phoneNumberId,
        accessTokenCipher: data.accessTokenCipher ?? prev?.accessTokenCipher,
        templateName: data.templateName ?? prev?.templateName,
        recipientPhone: data.recipientPhone ?? prev?.recipientPhone,
      };
      if (next.enabled && !(next.phoneNumberId && next.accessTokenCipher && next.templateName && next.recipientPhone)) {
        throw new ApiError(400, "كمّل كل البيانات (Phone Number ID، مفتاح الوصول، اسم القالب، رقم المستلم) قبل التفعيل");
      }
      const row = await tx.whatsAppIntegration.upsert({
        where: { cafeId },
        create: { cafeId, ...data },
        update: data,
      });
      const changed = (Object.keys(input) as (keyof typeof input)[]).filter((k) => input[k] !== undefined);
      await auditInTransaction(tx, {
        cafeId,
        userId: session.id,
        action: "WHATSAPP_SETTINGS_CHANGED",
        entity: "WhatsAppIntegration",
        entityId: row.id,
        details: {
          byName: session.name,
          changed,
          enabled: { oldValue: prev?.enabled ?? false, newValue: row.enabled },
          ...(row.recipientPhone ? { recipientMasked: maskPhone(row.recipientPhone) } : {}),
        },
      });
    });

    return NextResponse.json(await view(cafeId));
  } catch (error) {
    return handleApiError(error);
  }
}

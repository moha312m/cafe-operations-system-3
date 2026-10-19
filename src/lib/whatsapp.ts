import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { openSecret } from "@/lib/secret-box";
import { buildShiftReport, shiftReportTemplateParams } from "@/lib/shift-report";

// WhatsApp Business Cloud API: sending the owner the shift close report.
//
// Business-initiated WhatsApp messages must use a template Meta has approved,
// so the café registers one with eight body variables (see
// SHIFT_REPORT_TEMPLATE_BODY) and enters its name here. The access token is
// opened only at send time, never logged, and scrubbed from any error text.

export const GRAPH_API_VERSION = "v21.0";
export const SHIFT_REPORT_KIND = "SHIFT_REPORT";
export const SHIFT_REPORT_PARAM_COUNT = 8;

/** Suggested body for the template the café submits to Meta for approval. */
export const SHIFT_REPORT_TEMPLATE_BODY = [
  "تقرير قفل شيفت 📋",
  "الفرع: {{1}}",
  "الشيفت: {{2}}",
  "وقت القفل: {{3}}",
  "المبيعات: {{4}}",
  "النقدية (متوقع / فعلي): {{5}}",
  "الفرق: {{6}}",
  "أوردرات مرحّلة: {{7}}",
  "التقرير: {{8}}",
].join("\n");

export type SendTrigger = "AUTO" | "MANUAL" | "TEST";
export type SendOutcome =
  | { status: "SENT"; messageId: string | null }
  | { status: "FAILED"; error: string }
  | { status: "SKIPPED"; reason: "DISABLED" | "ALREADY_SENT" | "NOT_SETTLED" };

/** 201012345678 → 2010*****678 — enough to recognise, not to dial. */
export function maskPhone(phone: string): string {
  if (phone.length <= 7) return "*".repeat(phone.length);
  return `${phone.slice(0, 4)}${"*".repeat(phone.length - 7)}${phone.slice(-3)}`;
}

function graphBase(): string {
  return (process.env.WHATSAPP_GRAPH_BASE_URL || "https://graph.facebook.com").replace(/\/+$/, "");
}

function reportUrl(shiftId: string): string | null {
  const base = process.env.APP_BASE_URL?.replace(/\/+$/, "");
  return base ? `${base}/reports/shift/${shiftId}` : null;
}

async function sendTemplate(args: {
  phoneNumberId: string;
  token: string;
  to: string;
  templateName: string;
  language: string;
  params: string[];
}): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`${graphBase()}/${GRAPH_API_VERSION}/${encodeURIComponent(args.phoneNumberId)}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${args.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: args.to,
        type: "template",
        template: {
          name: args.templateName,
          language: { code: args.language },
          components: [{ type: "body", parameters: args.params.map((text) => ({ type: "text", text })) }],
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new Error(e instanceof Error && e.name === "TimeoutError" ? "انتهت مهلة الاتصال بواتساب" : "تعذر الاتصال بواتساب");
  }
  const body = (await res.json().catch(() => null)) as
    | { messages?: { id?: string }[]; error?: { message?: string; code?: number } }
    | null;
  if (!res.ok) {
    const detail = body?.error ? `Meta ${body.error.code ?? res.status}: ${body.error.message ?? ""}` : `HTTP ${res.status}`;
    throw new Error(detail.split(args.token).join("***").slice(0, 300));
  }
  return body?.messages?.[0]?.id ?? null;
}

/**
 * Sends one shift's report and records the attempt. Never throws: the caller
 * is a close that has already committed, and a WhatsApp outage must not turn
 * a successful close into an error. AUTO sends at most once per shift.
 */
export async function sendShiftReport(args: {
  shiftId: string;
  cafeId: string;
  trigger: SendTrigger;
  actorId: string | null;
}): Promise<SendOutcome> {
  const integration = await db.whatsAppIntegration.findUnique({ where: { cafeId: args.cafeId } });
  if (
    !integration?.enabled ||
    !integration.phoneNumberId || !integration.accessTokenCipher ||
    !integration.templateName || !integration.recipientPhone
  ) {
    return { status: "SKIPPED", reason: "DISABLED" };
  }
  if (args.trigger === "AUTO") {
    const sent = await db.whatsAppMessageLog.findFirst({
      where: { shiftId: args.shiftId, kind: SHIFT_REPORT_KIND, status: "SENT" },
      select: { id: true },
    });
    if (sent) return { status: "SKIPPED", reason: "ALREADY_SENT" };
  }
  const report = await buildShiftReport(args.shiftId, args.cafeId);
  if (!report) return { status: "SKIPPED", reason: "NOT_SETTLED" };

  let outcome: SendOutcome;
  try {
    const messageId = await sendTemplate({
      phoneNumberId: integration.phoneNumberId,
      token: openSecret(integration.accessTokenCipher),
      to: integration.recipientPhone,
      templateName: integration.templateName,
      language: integration.templateLanguage,
      params: shiftReportTemplateParams(report, reportUrl(report.shiftId)),
    });
    outcome = { status: "SENT", messageId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "فشل الإرسال";
    outcome = {
      status: "FAILED",
      error: msg === "SECRET_UNREADABLE" ? "مفتاح الوصول المحفوظ مش قابل للقراءة — أدخله تاني من الإعدادات" : msg,
    };
  }

  const recipientMasked = maskPhone(integration.recipientPhone);
  try {
    await db.whatsAppMessageLog.create({
      data: {
        cafeId: args.cafeId,
        branchId: report.branch.id,
        shiftId: report.shiftId,
        kind: SHIFT_REPORT_KIND,
        trigger: args.trigger,
        status: outcome.status,
        providerMessageId: outcome.status === "SENT" ? outcome.messageId : null,
        error: outcome.status === "FAILED" ? outcome.error : null,
        recipientMasked,
        triggeredById: args.actorId,
      },
    });
  } catch (e) {
    console.error("[whatsapp] could not record the delivery attempt", e instanceof Error ? e.message : e);
  }
  await audit({
    cafeId: args.cafeId,
    userId: args.actorId,
    action: outcome.status === "SENT" ? "WHATSAPP_SHIFT_REPORT_SENT" : "WHATSAPP_SHIFT_REPORT_FAILED",
    entity: "Shift",
    entityId: report.shiftId,
    details: {
      shiftId: report.shiftId,
      shiftNumber: report.shiftNumber,
      trigger: args.trigger,
      recipientMasked,
      ...(outcome.status === "FAILED" ? { error: outcome.error } : {}),
    },
  });
  return outcome;
}

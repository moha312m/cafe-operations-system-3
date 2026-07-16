// Server-only module: imports the Prisma client and reads server env vars.
// Never import this from a client component.
import { db } from "@/lib/db";
import { loadCustomerMenu } from "@/lib/customer-menu";
import type { MenuData } from "@/components/customer-menu/types";

// ── AI menu assistant (server-only) ──────────────────────────────────
// Recommends products ONLY from the current branch's PUBLIC menu. All the
// customer-safe fields (name, public price, category, availability,
// variants, add-ons) come from the same loader the QR menu uses — so no
// cost price, no profit, no inventory, no staff/reports/audit data ever
// reaches the model. API keys stay here on the server; nothing is exposed
// to the client.

export type AIRecommendation = { productId: string; reason?: string };
export type AIResult =
  | { status: "ok"; reply: string; productIds: string[] }
  | { status: "unavailable" } // no API key configured
  | { status: "error" };

const ANTHROPIC_MODEL = process.env.AI_MENU_MODEL ?? "claude-haiku-4-5";
const OPENAI_MODEL = process.env.AI_MENU_MODEL ?? "gpt-4o-mini";
const MAX_MESSAGE_LEN = 500;

type Provider = "anthropic" | "openai" | null;

function pickProvider(): Provider {
  // Prefer Anthropic when both are set (this is a Claude-first app).
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  return null;
}

export function aiAssistantAvailable(): boolean {
  return pickProvider() !== null;
}

// Resolve the branch + its cafe SERVER-SIDE from the branchId the client
// sends — we never trust a cafeId from the request. Returns the safe menu
// plus tenant ids for scoped auditing.
export async function getPublicMenuForAI(branchId: string): Promise<
  | { status: "ok"; menu: MenuData; cafeId: string; branchDbId: string }
  | { status: "unavailable-menu" }
> {
  const branch = await db.branch.findUnique({
    where: { id: branchId },
    include: { cafe: true },
  });
  const result = await loadCustomerMenu(branch);
  if (result.status !== "ok" || !branch) return { status: "unavailable-menu" };
  return { status: "ok", menu: result.menu, cafeId: branch.cafeId, branchDbId: branch.id };
}

// Compact, model-friendly view of the menu. Available products only are
// offered as recommendable; unavailable ones are omitted entirely so the
// model can never suggest something out of stock.
function menuForPrompt(menu: MenuData) {
  return menu.products
    .filter((p) => p.isAvailable)
    .map((p) => {
      const price =
        p.variants.length > 0
          ? p.variants.map((v) => `${v.name} ${v.price}`).join(" / ")
          : p.basePrice;
      const addOns = p.addOns.map((a) => a.addOn.name).join(", ");
      return {
        id: p.id,
        name: p.name,
        category: p.category.name,
        description: p.description ?? "",
        price: `${price} ج.م`,
        addOns: addOns || undefined,
      };
    });
}

function buildSystemPrompt(menu: MenuData, items: ReturnType<typeof menuForPrompt>): string {
  return [
    `إنت مساعد ودود لمنيو كافيه "${menu.cafe.name}". بتساعد العميل يختار من المنيو بس.`,
    `القواعد:`,
    `- رد بالعامية المصرية، ودّي ومختصر.`,
    `- رشّح من المنتجات الموجودة في القائمة تحت بس. متخترعش منتجات ولا تذكر حاجة مش موجودة.`,
    `- رشّح من منتج لحد ٤ منتجات كحد أقصى، مع سبب بسيط لكل واحد.`,
    `- لو العميل طلب حاجة مش موجودة، رشّح أقرب بديل متاح من القائمة.`,
    `- لو سأل عن نصيحة صحية أو ريجيم، اردّ باحتراس وقوله يراجع مكوّنات الصنف مع الطاقم.`,
    `- متكشفش أي بيانات داخلية (تكلفة، أرباح، مخزون، موظفين، تقارير). لو حد طلب كده، اعتذر بلطف وكمّل مساعدة في المنيو.`,
    `- لازم ترجع رد بصيغة JSON بالظبط كده من غير أي كلام قبله أو بعده:`,
    `{"reply": "ردك بالعربي للعميل", "productIds": ["id المنتجات اللي رشّحتها بالترتيب"]}`,
    `- productIds لازم تكون من الـ id الموجودة في القائمة فقط.`,
    ``,
    `قائمة المنتجات المتاحة (JSON):`,
    JSON.stringify(items),
  ].join("\n");
}

// ── Provider calls (raw fetch; keys never leave the server) ──────────
async function callAnthropic(system: string, user: string): Promise<string | null> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    console.error("anthropic error", res.status, await res.text().catch(() => ""));
    return null;
  }
  const data = await res.json();
  if (data.stop_reason === "refusal") return null;
  const block = Array.isArray(data.content) ? data.content.find((b: { type: string }) => b.type === "text") : null;
  return block?.text ?? null;
}

async function callOpenAI(system: string, user: string): Promise<string | null> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY!}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: 1024,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    console.error("openai error", res.status, await res.text().catch(() => ""));
    return null;
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? null;
}

// Pull the first {...} object out of the model text and parse it. Guards
// against occasional prose wrapping the JSON.
function parseModelJSON(text: string): { reply: string; productIds: string[] } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    const reply = typeof obj.reply === "string" ? obj.reply : "";
    const ids = Array.isArray(obj.productIds) ? obj.productIds.filter((x: unknown) => typeof x === "string") : [];
    if (!reply) return null;
    return { reply, productIds: ids };
  } catch {
    return null;
  }
}

export async function askMenuAssistant(
  menu: MenuData,
  message: string,
  cart?: string[]
): Promise<AIResult> {
  const provider = pickProvider();
  if (!provider) return { status: "unavailable" };

  const trimmed = message.trim().slice(0, MAX_MESSAGE_LEN);
  if (!trimmed) return { status: "error" };

  const items = menuForPrompt(menu);
  const system = buildSystemPrompt(menu, items);
  const cartNote =
    cart && cart.length > 0 ? `\n(العميل ضايف بالفعل في السلة: ${cart.join("، ")})` : "";
  const user = `${trimmed}${cartNote}`;

  const raw =
    provider === "anthropic" ? await callAnthropic(system, user) : await callOpenAI(system, user);
  if (!raw) return { status: "error" };

  const parsed = parseModelJSON(raw);
  if (!parsed) return { status: "error" };

  // Only keep ids that exist in the AVAILABLE menu — the model can never
  // recommend an invented, hidden, or unavailable product.
  const validIds = new Set(items.map((i) => i.id));
  const productIds = parsed.productIds.filter((id) => validIds.has(id)).slice(0, 4);

  return { status: "ok", reply: parsed.reply, productIds };
}

// Pure guidance for closing a shift. No React, no database, no network, no clock: everything here is a function of what the SERVER said, so it can
// be unit-tested and so the UI cannot invent a state.
//
// What this module does NOT do: decide whether a close may proceed (the server does, on its own figures), fill any figure, or claim that anybody
// was notified — there is no notification capability behind these messages, and the wording says so.

import { COUNT_STATUS_LABEL, COUNT_TYPE_LABEL, type CountStatus, type CountType } from "../components/stock-counts/stock-count-labels";

export type GuidanceBlocker = { code: string; count: number; messageAr: string; ids: string[]; refs?: string[] };

/**
 * What this account can actually OPEN, per destination — not what it can do there. Every field is required: an action is drawn only for a
 * destination the account may reach, and the account is never sent somewhere that refuses it. `NO_ACCESS` is the fail-closed default.
 */
export type GuidanceAccess = {
  /** `stock_count.configure` AND the settings page itself (it loads the branch's financial settings first, so a config-only role never reaches the panel). */
  settingsConfig: boolean;
  /** Orders list (`orders:read`). */
  orders: boolean;
  /** QR approvals screen (`qr_orders.view` with the QR module on). */
  approvals: boolean;
  /** Purchases screen (`purchases.view` with the purchases module on). */
  purchases: boolean;
  /** Stock-counts screen (`stock_count.view` with inventory on). */
  counts: boolean;
  /** May approve a count correction (`stock_count.approve_correction`); changes the wording only, never reveals an action. */
  approveCorrections: boolean;
  /** Handovers screen (`handover.view` with inventory on). */
  handovers: boolean;
};
export const NO_ACCESS: GuidanceAccess = { settingsConfig: false, orders: false, approvals: false, purchases: false, counts: false, approveCorrections: false, handovers: false };

/** Records behind a blocker, as the readiness read verified them server-side (branch- and cafe-scoped queries; ids never come from the client). */
export type CountSessionRecord = { id: string; status: string; type: string; pendingCorrections: number };
export type ReadinessRecords = { countSessions: CountSessionRecord[] };

export type GuidanceContext = { branchId: string; access: GuidanceAccess; records?: ReadinessRecords | null };

export type GuidanceAction = { label: string; href: string };

export type GuidanceItem = {
  key: string;
  code: string;
  title: string;
  /** What is actually standing in the way, specifically. */
  cause: string;
  /** Who can resolve it. */
  role: string;
  /** Real destinations for the person looking at it — one per verified record, so several records are never collapsed into one guess. Empty when this account cannot act. */
  actions: GuidanceAction[];
  /** Extra honesty for accounts that cannot act, or when the exact record could not be identified. */
  note?: string;
  count: number;
  refs: string[];
};

/** Blockers a café may waive by carrying open orders to the incoming shift (mirrors the server's CARRYABLE_BLOCKER_CODES; the server still decides). */
export const CARRYABLE_CODES: ReadonlySet<string> = new Set(["UNSERVED_ORDERS", "PENDING_APPROVAL_ORDERS"]);

const NO_AUTO_NOTICE = "لا يوجد إشعار تلقائي للمالك من التطبيق — أبلغه بنفسك.";
/** More than this many per-record links would bury the dialog; the rest are reached through the branch list, said plainly. */
const MAX_RECORD_LINKS = 5;

const CONFIG_ERRORS: Record<string, { cause: string; role: string; action: string }> = {
  SELECTED_WITH_NO_ITEMS: {
    cause: "وضع جرد التسليم «أصناف محددة» مفعّل في الفرع لكن لم يُختر أي صنف للجرد.",
    role: "المالك (أو من لديه صلاحية إعدادات الجرد)",
    action: "اختيار أصناف الجرد",
  },
  WEEKLY_WITHOUT_WEEKDAY: {
    cause: "الجرد الدوري «أسبوعي» مفعّل بدون تحديد يوم من الأسبوع.",
    role: "المالك (أو من لديه صلاحية إعدادات الجرد)",
    action: "تحديد يوم الجرد الأسبوعي",
  },
};

const q = (v: string) => encodeURIComponent(v);
/** The branch is carried in the link: settings used to pick its own branch, so the link could land on a different one. The `#id` is the panel's anchor. */
export const settingsHref = (branchId: string) => `/settings?branchId=${q(branchId)}#handover-config`;
export const handoverHref = (branchId: string, handoverId?: string) => `/handovers?branchId=${q(branchId)}${handoverId ? `&handoverId=${q(handoverId)}` : ""}`;
/** `sessionId` is a STOCK COUNT SESSION id (the only id type that screen's deep link accepts); a correction id is never passed here. */
export const countsHref = (branchId: string, sessionId?: string) => `/stock-counts?branchId=${q(branchId)}${sessionId ? `&sessionId=${q(sessionId)}` : ""}`;

export function isGuidanceBlocker(value: unknown): value is GuidanceBlocker {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return typeof o.code === "string" && typeof o.messageAr === "string" && typeof o.count === "number"
    && Array.isArray(o.ids) && o.ids.every((i) => typeof i === "string")
    && (o.refs === undefined || (Array.isArray(o.refs) && o.refs.every((r) => typeof r === "string")));
}

/** The structured blockers of a refused close. Plain-string or malformed entries are ignored rather than half-rendered (a refusal is not a success claim). */
export function structuredBlockers(payload: unknown): GuidanceBlocker[] {
  const list = (payload as { blockers?: unknown } | null | undefined)?.blockers;
  return Array.isArray(list) ? list.filter(isGuidanceBlocker) : [];
}

// ── The readiness read: five distinct states, one of which may say "clear" ─────────────────────────────────────────────────────────────────────
export type ReadinessData = {
  checkedAt: string; enabled: boolean; mode: string; configError: { code: string } | null; carryOpenOrders: boolean;
  blockers: GuidanceBlocker[]; requiredItems: { id: string; name: string; unit: string }[]; records: ReadinessRecords;
};

/**
 * STRICT parse of `GET close-readiness`. Anything unexpected returns null — in particular a malformed blocker entry must NOT be dropped silently
 * (dropping it would turn a real obstacle into a clear result), so one bad entry fails the whole read.
 */
export function parseReadiness(payload: unknown): ReadinessData | null {
  const r = (payload as { readiness?: unknown } | null | undefined)?.readiness;
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  if (typeof o.checkedAt !== "string" || Number.isNaN(Date.parse(o.checkedAt))) return null;
  if (typeof o.enabled !== "boolean" || typeof o.mode !== "string" || typeof o.carryOpenOrders !== "boolean") return null;
  const ce = o.configError;
  if (ce !== null && !(ce && typeof ce === "object" && typeof (ce as { code?: unknown }).code === "string")) return null;
  if (!Array.isArray(o.blockers) || !o.blockers.every(isGuidanceBlocker)) return null;
  if (!Array.isArray(o.requiredItems) || !o.requiredItems.every((i) => !!i && typeof i === "object" && typeof (i as Record<string, unknown>).id === "string" && typeof (i as Record<string, unknown>).name === "string" && typeof (i as Record<string, unknown>).unit === "string")) return null;
  let records: ReadinessRecords = { countSessions: [] };
  if (o.records !== undefined) {
    const rec = o.records as { countSessions?: unknown } | null;
    if (!rec || !Array.isArray(rec.countSessions)) return null;
    const sessions = rec.countSessions;
    if (!sessions.every((c) => !!c && typeof c === "object" && typeof (c as Record<string, unknown>).id === "string" && typeof (c as Record<string, unknown>).status === "string" && typeof (c as Record<string, unknown>).type === "string" && typeof (c as Record<string, unknown>).pendingCorrections === "number")) return null;
    records = { countSessions: sessions as CountSessionRecord[] };
  }
  return {
    checkedAt: o.checkedAt, enabled: o.enabled, mode: o.mode, carryOpenOrders: o.carryOpenOrders,
    configError: ce === null ? null : { code: (ce as { code: string }).code },
    blockers: o.blockers as GuidanceBlocker[],
    requiredItems: (o.requiredItems as { id: string; name: string; unit: string }[]).map((i) => ({ id: i.id, name: i.name, unit: i.unit })),
    records,
  };
}

/** One value, so "loading with old data" or "failed with a stale clear" cannot exist. Only `checked` carries data, and only a fresh successful parse gets there. */
export type ReadinessState =
  | { status: "unchecked" }
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "checked"; data: ReadinessData };
export const READINESS_UNCHECKED: ReadinessState = { status: "unchecked" };

/**
 * Runs the readiness read with a sequence guard: only the most recent request may publish, so an older, slower answer can never overwrite a newer
 * one (stale data), and a request that is superseded or cancelled publishes nothing.
 */
export function createReadinessLoader(read: () => Promise<unknown>, publish: (state: ReadinessState) => void) {
  let sequence = 0;
  return {
    async load(): Promise<void> {
      const mine = ++sequence;
      publish({ status: "loading" });
      try {
        const parsed = parseReadiness(await read());
        if (mine !== sequence) return;
        publish(parsed ? { status: "checked", data: parsed } : { status: "failed", message: "رد الخادم غير مفهوم — لم يتم التأكد من الجاهزية" });
      } catch (e) {
        if (mine !== sequence) return;
        publish({ status: "failed", message: e instanceof Error && e.message ? e.message : "تعذّر الاتصال بالخادم" });
      }
    },
    cancel(): void { sequence += 1; },
  };
}

export type ReadinessViewStatus = "unchecked" | "loading" | "failed" | "not_applicable" | "blockers" | "clear";
export type ReadinessView = { status: ReadinessViewStatus; items: GuidanceItem[]; checkedAt: string | null; message: string | null };

/**
 * What the dialog may say about readiness. `clear` is reachable ONLY from a fresh successful check of an enabled handover that found no
 * operational blockers; loading / failed / unchecked never produce it. `fallbackConfigError` (from the ordinary config read) is shown only as a
 * labelled, unconfirmed cause while the readiness read is unavailable.
 */
export function readinessView(state: ReadinessState, ctx: GuidanceContext, fallbackConfigError: { code: string } | null): ReadinessView {
  switch (state.status) {
    case "unchecked": return { status: "unchecked", items: [], checkedAt: null, message: null };
    case "loading": return { status: "loading", items: [], checkedAt: null, message: null };
    case "failed": return { status: "failed", items: configGuidance(fallbackConfigError, ctx), checkedAt: null, message: state.message };
    case "checked": {
      const d = state.data;
      if (!d.enabled) return { status: "not_applicable", items: [], checkedAt: d.checkedAt, message: null };
      const withRecords: GuidanceContext = { ...ctx, records: d.records };
      const kept = d.blockers
        .filter((b) => !(d.carryOpenOrders && CARRYABLE_CODES.has(b.code)))
        .map((b) => (b.code === "HANDOVER_CONFIG_ERROR" ? { ...b, ids: b.ids.filter((c) => c !== "CYCLE_POLICY_UNSUPPORTED") } : b))
        .filter((b) => b.code !== "HANDOVER_CONFIG_ERROR" || b.ids.length > 0);
      const items = explainBlockers(kept, withRecords);
      return { status: items.length > 0 ? "blockers" : "clear", items, checkedAt: d.checkedAt, message: null };
    }
  }
}

// ── Explaining one blocker ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const labelCount = (r: CountSessionRecord | undefined, n: number, of: number): string => {
  if (!r) return `جرد ${n} من ${of}`;
  const type = COUNT_TYPE_LABEL[r.type as CountType] ?? r.type;
  const status = COUNT_STATUS_LABEL[r.status as CountStatus] ?? r.status;
  return `${type} — ${status}${of > 1 ? ` (${n} من ${of})` : ""}`;
};

function recordActions<T>(ids: T[], total: number, label: (id: T, n: number) => GuidanceAction, listAction: GuidanceAction | null): { actions: GuidanceAction[]; partial: string | null } {
  const shown = ids.slice(0, MAX_RECORD_LINKS);
  const actions = shown.map((id, i) => label(id, i + 1));
  const hidden = Math.max(total, ids.length) - shown.length;
  if (hidden > 0 && listAction) actions.push(listAction);
  return { actions, partial: hidden > 0 ? `المعروض ${shown.length} من ${Math.max(total, ids.length)} — الباقي من القائمة العامة للفرع (مش سجل بعينه).` : null };
}

export function explainBlocker(b: GuidanceBlocker, ctx: GuidanceContext): GuidanceItem[] {
  const base = { count: b.count, refs: b.refs ?? [] };
  const { access, branchId } = ctx;
  const none = (note: string) => ({ actions: [] as GuidanceAction[], note });
  switch (b.code) {
    case "HANDOVER_CONFIG_ERROR": {
      // `ids` carries the config error codes; each one is its own cause with its own fix.
      return (b.ids.length ? b.ids : ["UNKNOWN"]).map((code) => {
        const known = CONFIG_ERRORS[code];
        return {
          key: `${b.code}:${code}`, code, ...base, count: 1, refs: [],
          title: "إعداد تسليم العهدة غير مكتمل",
          cause: known?.cause ?? `خطأ في إعدادات تسليم العهدة (${code}).`,
          role: known?.role ?? "المالك (أو من لديه صلاحية إعدادات الجرد)",
          ...(access.settingsConfig
            ? { actions: [{ label: known?.action ?? "فتح إعدادات الجرد", href: settingsHref(branchId) }] }
            : none(`هذا الإعداد لا تملك صلاحية تغييره. اطلب من المالك اختيار أصناف الجرد ثم أعد المحاولة. ${NO_AUTO_NOTICE}`)),
        };
      });
    }
    case "UNSERVED_ORDERS":
      return [{ key: b.code, code: b.code, ...base, title: "أوردرات لم تُقدَّم", cause: "في أوردرات مؤكدة أو بتتحضر أو جاهزة لسه ما اتسلّمتش للعميل.", role: "الكاشير أو الويتر أو المدير",
        ...(access.orders ? { actions: [{ label: "فتح الطلبات", href: "/orders" }] } : none("حسابك لا يملك صلاحية فتح الطلبات؛ اطلب من المدير أو الويتر.")) }];
    case "PENDING_APPROVAL_ORDERS": {
      // Approval happens on the approvals screen; the orders list is only a fallback for people who can see orders but not approve.
      const actions = access.approvals ? [{ label: "فتح موافقات الطلبات", href: "/approvals" }] : access.orders ? [{ label: "فتح الطلبات", href: "/orders" }] : [];
      return [{ key: b.code, code: b.code, ...base, title: "أوردرات مستنية موافقة", cause: "أوردرات QR مستنية موافقة الويتر.", role: "الويتر أو المدير", actions,
        ...(actions.length === 0 ? { note: "حسابك لا يملك صلاحية فتح موافقات الطلبات؛ اطلب من الويتر أو المدير." } : {}) }];
    }
    case "DRAFT_PURCHASE_INVOICES":
      return [{ key: b.code, code: b.code, ...base, title: "فواتير مشتريات مسودة", cause: "فواتير مشتريات لسه مسودة ويمكن أن تُدخل مخزون.", role: "مسؤول المشتريات أو المدير",
        ...(access.purchases ? { actions: [{ label: "فتح المشتريات", href: "/purchases" }] } : none("حسابك لا يملك صلاحية فتح المشتريات؛ اطلب من مسؤول المشتريات أو المدير.")) }];
    case "PENDING_CORRECTIONS": {
      // The ids are CORRECTION ids, which the count screen cannot open. The exact destination is the count SESSION that holds them, and that mapping
      // comes only from the readiness read (resolved server-side). Without it the account gets the branch list, labelled as a list.
      const common = { key: b.code, code: b.code, ...base, title: "تصحيحات جرد مستنية موافقة", cause: "تصحيحات جرد مستنية موافقة المدير.", role: "المدير (صلاحية اعتماد الجرد)" };
      if (!access.counts) return [{ ...common, ...none("حسابك لا يملك صلاحية فتح الجرد؛ اطلب من المدير اعتماد التصحيحات.") }];
      const sessions = (ctx.records?.countSessions ?? []).filter((s) => s.pendingCorrections > 0);
      const approver = access.approveCorrections ? {} : { note: "حسابك يستطيع الاطلاع فقط — اعتماد التصحيح يحتاج صلاحية اعتماد التصحيح." };
      if (sessions.length === 0) {
        return [{ ...common, actions: [{ label: "قائمة جرد الفرع (مش سجل بعينه)", href: countsHref(branchId) }], note: `تعذّر تحديد جلسة الجرد المقصودة بدقة؛ ابحث عن الجلسة اللي فيها تصحيحات. ${access.approveCorrections ? "" : "اعتماد التصحيح يحتاج صلاحية اعتماد التصحيح."}`.trim() }];
      }
      // Corrections are counted in corrections, sessions in sessions: the list link is added only when some correction is not covered by a listed
      // session (the server samples at most 20 ids) or there are more sessions than links shown.
      const covered = sessions.reduce((n, x) => n + x.pendingCorrections, 0);
      const { actions, partial } = recordActions(sessions, covered < b.count ? sessions.length + 1 : sessions.length,
        (s, n) => ({ label: `${labelCount(s, n, sessions.length)} — ${s.pendingCorrections} تصحيح`, href: countsHref(branchId, s.id) }),
        { label: "قائمة جرد الفرع (مش سجل بعينه)", href: countsHref(branchId) });
      const note = [partial, "note" in approver ? approver.note : null].filter(Boolean).join(" ");
      return [{ ...common, actions, ...(note ? { note } : {}) }];
    }
    case "FOREIGN_ACTIVE_COUNT": {
      // Here the ids ARE count-session ids (from a branch/cafe-scoped query), so each can be opened exactly.
      const common = { key: b.code, code: b.code, ...base, title: "جرد مفتوح في الفرع", cause: "في جرد مفتوح في الفرع لازم يخلص أو يتلغي الأول.", role: "مسؤول المخزون أو المدير" };
      if (!access.counts) return [{ ...common, ...none("حسابك لا يملك صلاحية فتح الجرد؛ اطلب من مسؤول المخزون أو المدير.") }];
      const byId = new Map((ctx.records?.countSessions ?? []).map((s) => [s.id, s]));
      if (b.ids.length === 0) return [{ ...common, actions: [{ label: "قائمة جرد الفرع (مش سجل بعينه)", href: countsHref(branchId) }], note: "تعذّر تحديد الجلسة بدقة." }];
      const { actions, partial } = recordActions(b.ids, b.count,
        (id, n) => ({ label: `افتح ${labelCount(byId.get(id), n, Math.max(b.count, b.ids.length))}`, href: countsHref(branchId, id) }),
        { label: "قائمة جرد الفرع (مش سجل بعينه)", href: countsHref(branchId) });
      return [{ ...common, actions, ...(partial ? { note: partial } : {}) }];
    }
    case "EXISTING_ACTIVE_HANDOVER": {
      const common = { key: b.code, code: b.code, ...base, title: "في تسليم عهدة مفتوح", cause: "في تسليم عهدة مفتوح بالفعل في الفرع ولازم يكتمل أو يترفض.", role: "المُسلّم أو المستلم أو المدير" };
      if (!access.handovers) return [{ ...common, ...none("حسابك لا يملك صلاحية عرض التسليم؛ اطلب من المدير متابعته.") }];
      if (b.ids.length === 0) return [{ ...common, actions: [{ label: "قائمة تسليمات الفرع (مش سجل بعينه)", href: handoverHref(branchId) }], note: "تعذّر تحديد التسليم بدقة." }];
      const total = Math.max(b.count, b.ids.length);
      const { actions, partial } = recordActions(b.ids, b.count,
        (id, n) => ({ label: total > 1 ? `فتح التسليم ${n} من ${total}` : "فتح هذا التسليم", href: handoverHref(branchId, id) }),
        { label: "قائمة تسليمات الفرع (مش سجل بعينه)", href: handoverHref(branchId) });
      return [{ ...common, actions, ...(partial ? { note: partial } : {}) }];
    }
    default:
      return [{ key: b.code, code: b.code, ...base, title: "عائق من الخادم", cause: b.messageAr, role: "المدير", actions: [] }];
  }
}

export function explainBlockers(list: GuidanceBlocker[], ctx: GuidanceContext): GuidanceItem[] {
  return list.flatMap((b) => explainBlocker(b, ctx));
}

/** A handover-config error as the existing `GET handover-config` reports it (read-only) — the same causes, without needing a close attempt. */
export function configGuidance(configError: { code: string } | null | undefined, ctx: GuidanceContext): GuidanceItem[] {
  if (!configError || configError.code === "CYCLE_POLICY_UNSUPPORTED") return []; // CYCLE is stepped around by the server, not a blocker
  return explainBlocker({ code: "HANDOVER_CONFIG_ERROR", count: 1, messageAr: "", ids: [configError.code] }, ctx);
}

export type ShiftPhase = "OPEN" | "AWAITING_HANDOVER" | "CLOSED";
export const SHIFT_PHASE_LABEL: Record<ShiftPhase, { label: string; detail: string }> = {
  OPEN: { label: "مفتوح", detail: "الشيفت شغال ولم يُسجَّل قفله." },
  AWAITING_HANDOVER: { label: "تم الإقفال المالي — في انتظار التسليم", detail: "العدّ المالي اتسجّل، لكن الشيفت لم يُقفل بالكامل: عهدة المخزون لسه معاك لحد ما التسليم يكتمل." },
  CLOSED: { label: "مقفول", detail: "الإقفال والتسليم اكتملوا." },
};
export function shiftPhase(status: string | null | undefined): ShiftPhase | null {
  return status === "OPEN" || status === "AWAITING_HANDOVER" || status === "CLOSED" ? status : null;
}

export type HandoverLike = { status: string; count: { sessionId: string; status: string } | null };
/** The one call to action for a handover the viewer is about to work on. `canWork` = the viewer is the outgoing custodian with the submit grant. */
export function countAction(branchId: string, handoverId: string, view: HandoverLike | null, canWork: boolean): GuidanceAction | null {
  const href = handoverHref(branchId, handoverId);
  if (!view) return { label: "متابعة التسليم", href };
  const open = ["DRAFT", "REJECTED"].includes(view.status);
  if (open && canWork) {
    if (!view.count) return { label: "ابدأ الجرد", href };
    if (view.count.status !== "CONFIRMED") return { label: "استكمل الجرد", href };
    return { label: "راجع الجرد وقدّم التسليم", href };
  }
  return { label: "متابعة التسليم", href };
}

export function handoverPhaseLabel(status: string | null | undefined): { label: string; complete: boolean } {
  if (status === "ACCEPTED" || status === "COMPLETED") return { label: "التسليم اكتمل", complete: true };
  if (status === "REJECTED") return { label: "التسليم اترفض — محتاج إعادة جرد", complete: false };
  if (status === "OUTGOING_SUBMITTED" || status === "INCOMING_REVIEW") return { label: "التسليم اتقدّم — مستني المستلم", complete: false };
  if (status === "MANAGER_EXCEPTION") return { label: "التسليم عند المدير (استثناء)", complete: false };
  return { label: "التسليم لم يكتمل — الجرد لسه مطلوب", complete: false };
}

// ── Browser-tab storage scope ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// sessionStorage is shared by everyone who uses this tab, so a draft or note is only ever read back for the SAME café, user, branch and shift
// that wrote it. (v1 keys — shift-only for the draft, branch-only for the note — are never read.)
export type StorageScope = { cafeId: string; userId: string; branchId: string };
export type DraftScope = StorageScope & { shiftId: string };
const scopeKey = (s: StorageScope) => [s.cafeId, s.userId, s.branchId].map(encodeURIComponent).join(":");
const sameScope = (a: StorageScope, b: Partial<StorageScope>) => a.cafeId === b.cafeId && a.userId === b.userId && a.branchId === b.branchId;
const validScope = (s: StorageScope) => !!s.cafeId && !!s.userId && !!s.branchId;

// ── Close-form draft (user-entered values only; sessionStorage, same tab) ──────────────────────────────────────────────────────────────────────
export type CloseDraft = {
  actualCash: string; notes: string; varianceReason: string; actualCard: string; cardReason: string; actualWallet: string; walletReason: string;
  handoverTarget: "" | "SHIFT_TO_SHIFT" | "BRANCH_CUSTODY"; leftInDrawer: string; toTreasury: string;
};
export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const DRAFT_VERSION = 2;
const DRAFT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
export const closeDraftKey = (scope: DraftScope) => `nextcup:close-draft:v${DRAFT_VERSION}:${scopeKey(scope)}:${encodeURIComponent(scope.shiftId)}`;
const TARGETS = ["", "SHIFT_TO_SHIFT", "BRANCH_CUSTODY"];
const STRING_FIELDS: (keyof CloseDraft)[] = ["actualCash", "notes", "varianceReason", "actualCard", "cardReason", "actualWallet", "walletReason", "leftInDrawer", "toTreasury"];

export function saveCloseDraft(storage: StorageLike | null, scope: DraftScope, draft: CloseDraft, now: number): void {
  if (!storage || !validScope(scope) || !scope.shiftId) return;
  const empty = STRING_FIELDS.every((k) => draft[k] === "") && draft.handoverTarget === "";
  try {
    if (empty) storage.removeItem(closeDraftKey(scope));
    else storage.setItem(closeDraftKey(scope), JSON.stringify({ v: DRAFT_VERSION, scope, savedAt: now, draft }));
  } catch { /* storage unavailable: the form simply is not preserved */ }
}

export function loadCloseDraft(storage: StorageLike | null, scope: DraftScope, now: number): CloseDraft | null {
  if (!storage || !validScope(scope) || !scope.shiftId) return null;
  try {
    const raw = storage.getItem(closeDraftKey(scope));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { v?: number; scope?: Partial<DraftScope>; savedAt?: number; draft?: Record<string, unknown> };
    // The key already encodes the scope; the payload is checked too so a copied or hand-edited entry cannot cross a boundary.
    if (parsed.v !== DRAFT_VERSION || !parsed.scope || !sameScope(scope, parsed.scope) || parsed.scope.shiftId !== scope.shiftId) return null;
    if (typeof parsed.savedAt !== "number" || now - parsed.savedAt > DRAFT_MAX_AGE_MS || !parsed.draft) return null;
    const d = parsed.draft;
    if (!STRING_FIELDS.every((k) => typeof d[k] === "string") || typeof d.handoverTarget !== "string" || !TARGETS.includes(d.handoverTarget)) return null;
    return Object.fromEntries([...STRING_FIELDS.map((k) => [k, d[k] as string]), ["handoverTarget", d.handoverTarget]]) as CloseDraft;
  } catch { return null; }
}

export function clearCloseDraft(storage: StorageLike | null, scope: DraftScope): void {
  try { storage?.removeItem(closeDraftKey(scope)); } catch { /* nothing to clear */ }
}

// ── Pending-close outcome (so a settled-but-not-discharged shift stays visible after the dialog closes) ──────────────────────────────────────
export type CloseOutcomeNote = { handoverId: string; shiftNumber: number | null; savedAt: number };
const OUTCOME_VERSION = 2;
export const closeOutcomeKey = (scope: StorageScope) => `nextcup:close-outcome:v${OUTCOME_VERSION}:${scopeKey(scope)}`;
export function saveCloseOutcome(storage: StorageLike | null, scope: StorageScope, note: CloseOutcomeNote): void {
  if (!storage || !validScope(scope)) return;
  try { storage.setItem(closeOutcomeKey(scope), JSON.stringify({ v: OUTCOME_VERSION, scope, ...note })); } catch { /* ignore */ }
}
export function clearCloseOutcome(storage: StorageLike | null, scope: StorageScope): void { try { storage?.removeItem(closeOutcomeKey(scope)); } catch { /* ignore */ } }
export function loadCloseOutcome(storage: StorageLike | null, scope: StorageScope, now: number): CloseOutcomeNote | null {
  if (!storage || !validScope(scope)) return null;
  try {
    const raw = storage.getItem(closeOutcomeKey(scope));
    if (!raw) return null;
    const n = JSON.parse(raw) as { v?: number; scope?: Partial<StorageScope> } & Partial<CloseOutcomeNote>;
    if (n.v !== OUTCOME_VERSION || !n.scope || !sameScope(scope, n.scope)) return null;
    if (typeof n.handoverId !== "string" || typeof n.savedAt !== "number" || now - n.savedAt > 3 * DRAFT_MAX_AGE_MS) return null;
    return { handoverId: n.handoverId, shiftNumber: typeof n.shiftNumber === "number" ? n.shiftNumber : null, savedAt: n.savedAt };
  } catch { return null; }
}

// ── Report metric contracts ──────────────────────────────────────────
// What each figure on the daily report means, in one place. The API ships
// the version with every report so an exported figure can be traced back to
// the definition it was computed under; the screen reads labels from here.
//
// basis:
//   period  computed over the selected business days / hours.
//   now     live state when the report was generated (meta.generatedAt),
//           whatever period is selected. Never sum it across days.
//
// Bump METRIC_DEFINITIONS_VERSION whenever a definition changes meaning. A
// new metric alone does not need a bump.

export const METRIC_DEFINITIONS_VERSION = 1;

export type MetricBasis = "period" | "now";
export type MetricDefinition = { label: string; basis: MetricBasis; definition: string };

export const DAILY_REPORT_METRICS = {
  grossSales: { label: "المبيعات قبل المرتجعات", basis: "period", definition: "إجمالي الطلبات المقدَّمة (SERVED) بقيمة الفاتورة شاملة الضريبة والخدمة، مع فروق التعديلات في فترتها." },
  salesRefunds: { label: "مرتجعات المبيعات", basis: "period", definition: "المرتجعات على طلبات اتقدّمت فعلاً، بتاريخ المرتجع مش تاريخ البيع." },
  netSales: { label: "صافي المبيعات", basis: "period", definition: "المبيعات قبل المرتجعات ناقص مرتجعات المبيعات." },
  collections: { label: "اللي اتحصّل فعليًا", basis: "period", definition: "الفلوس اللي دخلت (تحصيلات)، بتاريخ الدفع. مش هي صافي المبيعات." },
  refunds: { label: "كل المبالغ المرتجعة", basis: "period", definition: "كل الفلوس اللي رجعت، ومنها طلبات ماتقدّمتش." },
  unservedRefunds: { label: "مرتجعات قبل التسليم", basis: "period", definition: "مرتجعات على طلبات ماتقدّمتش، فمش بتقلل المبيعات." },
  netMoneyMovement: { label: "صافي حركة الأموال", basis: "period", definition: "التحصيلات ناقص كل المرتجعات." },
  revenueExTax: { label: "المبيعات بدون ضريبة", basis: "period", definition: "قيمة الطلبات المعترف بيها ناقص الضريبة المسجلة على الفاتورة. الخدمة لسه جواها وبتظهر لوحدها في إجمالي السيرفيس." },
  orders: { label: "عدد الطلبات", basis: "period", definition: "عدد الطلبات المقدَّمة في الفترة. التعديلات مش بتتعد طلبات جديدة." },
  avgOrderValue: { label: "متوسط قيمة الطلب", basis: "period", definition: "قيمة الطلبات المعترف بيها ÷ عددها." },
  discounts: { label: "الخصومات", basis: "period", definition: "خصومات الطلبات المعترف بيها." },
  service: { label: "إجمالي السيرفيس", basis: "period", definition: "رسوم الخدمة على الطلبات المعترف بيها." },
  tax: { label: "إجمالي الضريبة", basis: "period", definition: "الضريبة المسجلة على الطلبات المعترف بيها، بالنسبة اللي كانت متسجلة وقت الطلب." },
  openShifts: { label: "الشيفتات المفتوحة", basis: "period", definition: "شيفتات اتفتحت في الفترة ولسه مفتوحة." },
  closedShifts: { label: "الشيفتات المقفولة", basis: "period", definition: "شيفتات اتفتحت في الفترة واتقفلت." },
  cashDifferenceTotal: { label: "فروقات الكاش", basis: "period", definition: "مجموع فروق العد في الشيفتات اللي اتقفلت في الفترة." },
  pendingCount: { label: "طلبات في انتظار التحصيل", basis: "period", definition: "طلبات الفترة اللي لسه متحصلتش خالص." },
  uncollectedTotal: { label: "إجمالي المبالغ غير المحصلة", basis: "period", definition: "الباقي على طلبات الفترة اللي متحصلتش أو اتحصلت جزئيًا." },
  partialRemaining: { label: "إجمالي المدفوع جزئيًا", basis: "period", definition: "الباقي على طلبات الفترة المدفوعة جزئيًا." },
  openTables: { label: "الترابيزات المفتوحة حاليًا", basis: "now", definition: "الترابيزات المفتوحة وقت إنشاء التقرير." },
  closedTables: { label: "الترابيزات المقفولة في الفترة", basis: "period", definition: "جلسات ترابيزات اتقفلت في الفترة." },
  avgSittingMinutes: { label: "متوسط مدة الجلوس", basis: "period", definition: "متوسط مدة جلسات الترابيزات اللي اتقفلت في الفترة." },
  tableCollections: { label: "إجمالي تحصيل الترابيزات", basis: "period", definition: "تحصيلات اتعملت من شاشة الترابيزات في الفترة." },
  tableUncollected: { label: "مبالغ غير محصلة على الترابيزات حاليًا", basis: "now", definition: "الباقي على الترابيزات المفتوحة وقت إنشاء التقرير." },
  purchases: { label: "إجمالي المشتريات المؤكدة", basis: "period", definition: "فواتير شراء مؤكدة بتاريخ الفاتورة في الفترة. المسودات والملغية برّه." },
  supplierPayments: { label: "مدفوعات الموردين", basis: "period", definition: "دفعات للموردين بتاريخ الدفع، ومنها دفعات على مسودات." },
  supplierUnpaid: { label: "مستحق للموردين حاليًا", basis: "now", definition: "الباقي على الفواتير المؤكدة وقت إنشاء التقرير، مهما كانت الفترة." },
  purchaseDrafts: { label: "مسودات مشتريات غير مؤكدة", basis: "period", definition: "فواتير لسه مسودة بتاريخ الفاتورة في الفترة. التزام مش مشتريات ولا دين." },
} as const satisfies Record<string, MetricDefinition>;

export type DailyMetricKey = keyof typeof DAILY_REPORT_METRICS;

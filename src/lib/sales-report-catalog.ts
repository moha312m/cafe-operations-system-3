import type {SalesReportKind} from './sales-report-contract';
import type {CafeFeatures} from './cafe-settings';
const common=['reports.view','finance.view_revenue','sales.view'];
export const SALES_REPORT_CATALOG:{id:SalesReportKind;title:string;description:string;keys:string[];features?:(keyof CafeFeatures)[]}[]=[
 {id:'purchase-sales',title:'المشتريات والمبيعات',description:'اعتراف المبيعات والمشتريات المؤكدة والتحصيل وسداد المورد منفصلة؛ ليست قائمة أرباح.',keys:[...common,'purchases.view','purchases.view_cost'],features:['inventoryEnabled','purchasesEnabled']},
 {id:'product-sales',title:'مبيعات الأصناف والأحجام',description:'هوية الصنف والحجم، المساهمة ومقامها الثابت، وجسر المصالحة.',keys:common},
 {id:'sales-payments',title:'تحصيلات المبيعات',description:'حركات الدفع والاسترداد الفعلية بتاريخها ووردية المحصل.',keys:common},
 {id:'shift-sales',title:'الورديات والكاشير',description:'دورة الوردية وروابط البيع والتحصيل وتسوية الدرج.',keys:[...common,'shifts.view_reports'],features:['shiftManagementEnabled']},
 {id:'sales-staff',title:'موظفو المبيعات',description:'منشئ البيع أو المحصل أو مقدم الطلب؛ إسناد صريح لكل أساس.',keys:common},
 {id:'tables',title:'تقرير الطاولات',description:'جلسات مستقلة وأحداث الفترة والمتبقي الحالي دون مضاعفة.',keys:[...common,'tables.view'],features:['enableTables']},
];
export const SALES_WORKSPACE_LINKS=[
 {href:'/sales',label:'كل المبيعات',key:'sales.view'},
 {href:'/sales?source=CASHIER_POS',label:'فواتير الكاشير',key:'sales.view'},
 {href:'/pos',label:'الكاشير',key:'pos.view'},
 {href:'/sales?returns=1',label:'مرتجعات المبيعات',key:'sales.view'},
];

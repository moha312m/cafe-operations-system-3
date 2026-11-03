/** Read-only analytical reports. Money/quantities cross JSON as exact decimal strings. */
export type SalesReportKind = 'product-sales'|'shift-sales'|'sales-payments'|'purchase-sales'|'sales-staff'|'tables';
export type SalesReportColumn = {key:string;label:string};
export type SalesReportRow = {id:string;cells:Record<string,string|null>;href?:string;details?:Record<string,string|null>;links?:{label:string;href:string}[]};
export type SalesReportResponse = {kind:SalesReportKind;title:string;generatedAt:string;columns:SalesReportColumn[];rows:SalesReportRow[];summaries:{key:string;label:string;value:string|null}[];coverage:string[];total:number;page:number;pageSize:number;pages:number;metricBasis:string;outputSnapshot?:string;[key:string]:unknown};

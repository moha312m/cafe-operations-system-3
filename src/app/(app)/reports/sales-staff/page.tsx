import {Suspense} from 'react';
import {SalesReportWorkspace} from '@/components/reports/sales-report-workspace';
export default function Page(){return <Suspense fallback={<p role="status">جارٍ تحميل التقرير…</p>}><SalesReportWorkspace kind="sales-staff"/></Suspense>;}

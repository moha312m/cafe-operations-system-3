import type {ReportWindow} from './business-day';
export type EventWindow=Pick<ReportWindow,'branchId'|'from'|'to'>;
/** OR keeps a matching row unique even if adjacent windows share a boundary.
 * Payments inherit branch through their order, including legacy nullable branch IDs.
 */
export function reportEventWhere(windows:EventWindow[],field='createdAt',viaOrder=false):Record<string,unknown>{
 return {OR:windows.map(w=>({...(w.branchId?(viaOrder?{order:{branchId:w.branchId}}:{branchId:w.branchId}):{}),[field]:{gte:w.from,lt:w.to}}))};
}

export type WaitObservation={pid:number;query:string;wait_event:string;blocking_pids:number[]};
export function matchingAdvisoryWait(rows:WaitObservation[],relation:string,blockerPid:number):WaitObservation|undefined{return rows.find(row=>row.wait_event==="advisory"&&row.blocking_pids.includes(blockerPid)&&row.query.toLowerCase().includes(relation.toLowerCase()));}

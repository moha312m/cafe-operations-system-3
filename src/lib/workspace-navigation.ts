/** Resolve one current leaf, including its declared query constraints. */
export function currentWorkspaceHref(location:string,hrefs:readonly string[]):string|undefined{
 const current=new URL(location,'http://workspace.local');
 return hrefs.filter(href=>{const link=new URL(href,'http://workspace.local');return (current.pathname===link.pathname||current.pathname.startsWith(link.pathname+'/'))&&[...link.searchParams].every(([key,value])=>current.searchParams.get(key)===value);}).sort((a,b)=>b.length-a.length)[0];
}

/** Resolve one current leaf; less specific matching links are ancestors. */
export function currentWorkspaceHref(pathname: string, hrefs: readonly string[]): string | undefined {
  return hrefs.filter(href => pathname === href || pathname.startsWith(href + "/"))
    .sort((a, b) => b.length - a.length)[0];
}

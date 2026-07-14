"use client";

import * as XLSX from "xlsx";
import { Button } from "@/components/ui/button";
import { TEMPLATE_HEADERS, TEMPLATE_EXAMPLE_ROWS } from "@/lib/menu-import";

// تحميل قالب المنيو — an .xlsx with Arabic headers and example rows.
export function DownloadMenuTemplateButton() {
  function download() {
    const sheet = XLSX.utils.aoa_to_sheet([
      [...TEMPLATE_HEADERS],
      ...TEMPLATE_EXAMPLE_ROWS,
    ]);
    sheet["!cols"] = TEMPLATE_HEADERS.map(() => ({ wch: 18 }));
    if (!sheet["!views"]) sheet["!views"] = [];
    sheet["!views"].push({ rightToLeft: true });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "المنيو");
    XLSX.writeFile(workbook, "قالب-المنيو.xlsx");
  }

  return (
    <Button variant="outline" onClick={download}>
      ⬇️ تحميل قالب المنيو
    </Button>
  );
}

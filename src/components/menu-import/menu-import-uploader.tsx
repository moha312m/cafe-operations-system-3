"use client";

import { useRef, useState } from "react";
import * as XLSX from "xlsx";
import { Button } from "@/components/ui/button";
import { mapRowHeaders, MAX_IMPORT_ROWS, type RawImportRow } from "@/lib/menu-import";

const ACCEPTED = [".xlsx", ".xls", ".csv"];

// رفع ملف Excel — parses the sheet in the browser and hands the mapped
// rows up. Prices/flags are validated on the server afterwards.
export function MenuImportUploader({
  onParsed,
}: {
  onParsed: (rows: RawImportRow[], fileName: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);

  async function handleFile(file: File) {
    setError(null);
    const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (!ACCEPTED.includes(extension)) {
      setError("صيغة الملف غير مدعومة — ارفع ملف ‎.xlsx أو ‎.xls أو ‎.csv");
      return;
    }
    setParsing(true);
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: "",
      });
      const rows = rawRows
        .map(mapRowHeaders)
        .filter((r) => Object.keys(r).length > 0);
      if (rows.length === 0) {
        setError("الملف فارغ");
        return;
      }
      if (rows.length > MAX_IMPORT_ROWS) {
        setError(`الحد الأقصى ${MAX_IMPORT_ROWS} صف في الملف الواحد`);
        return;
      }
      onParsed(rows, file.name);
    } catch {
      setError("مش قادرين نقرأ الملف — اتأكد إنه ملف Excel سليم");
    } finally {
      setParsing(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED.join(",")}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed p-8 text-center transition-colors hover:border-primary/50 hover:bg-accent/50"
      >
        <span className="text-4xl">📄</span>
        <span className="font-semibold">
          {parsing ? "جاري قراءة الملف…" : "رفع ملف Excel"}
        </span>
        <span className="text-xs text-muted-foreground">
          ‎.xlsx أو ‎.xls أو ‎.csv — بحد أقصى {MAX_IMPORT_ROWS} صف
        </span>
      </button>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button
        variant="ghost"
        size="sm"
        className="w-full text-xs text-muted-foreground"
        onClick={() => inputRef.current?.click()}
      >
        أو اضغط هنا لاختيار الملف
      </Button>
    </div>
  );
}

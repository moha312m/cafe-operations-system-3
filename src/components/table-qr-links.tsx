"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import QRCode from "qrcode";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function publicMenuUrl(
  cafeSlug: string,
  branch: { id: string; menuSlug: string | null },
  table?: number | string
): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const base = branch.menuSlug
    ? `${origin}/menu/${cafeSlug}/${branch.menuSlug}`
    : `${origin}/qr/${branch.id}`;
  return table !== undefined ? `${base}?table=${table}` : base;
}

type ConfTable = { id: string; tableNumber: string };

// روابط QR للترابيزات — per-table links from the branch's configured tables.
export function TableQrLinks({
  cafeSlug,
  branch,
}: {
  cafeSlug: string;
  branch: { id: string; name: string; menuSlug: string | null };
}) {
  const [tables, setTables] = useState<ConfTable[] | null>(null);
  const [qrPreview, setQrPreview] = useState<{ table: string; dataUrl: string } | null>(null);

  useEffect(() => {
    let stale = false;
    api<{ tables: ConfTable[] }>(`/api/tables/selector?branchId=${branch.id}`)
      .then((r) => { if (!stale) setTables(r.tables); })
      .catch(() => { if (!stale) setTables([]); });
    return () => { stale = true; };
  }, [branch.id]);

  async function copyLink(table: string) {
    const url = publicMenuUrl(cafeSlug, branch, table);
    try {
      await navigator.clipboard.writeText(url);
      toast.success(`اتنسخ رابط ترابيزة ${table}`);
    } catch {
      toast.error("النسخ فشل — انسخ الرابط يدوي");
    }
  }

  async function downloadQr(table: string) {
    try {
      const url = publicMenuUrl(cafeSlug, branch, table);
      const dataUrl = await QRCode.toDataURL(url, { width: 512, margin: 2, errorCorrectionLevel: "M" });
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `qr-${branch.menuSlug ?? branch.id}-table-${table}.png`;
      a.click();
      setQrPreview({ table, dataUrl });
    } catch {
      toast.error("توليد الـ QR فشل");
    }
  }

  if (tables === null) {
    return <p className="text-sm text-muted-foreground">جاري التحميل…</p>;
  }

  if (tables.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-4 text-center">
        <p className="text-sm text-muted-foreground">لم يتم إنشاء ترابيزات لهذا الفرع بعد</p>
        <Link href="/tables/setup" className="mt-2 inline-block text-sm font-semibold text-primary underline">
          إنشاء ترابيزات الآن
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        امسح أي كود بموبايلك وهتفتح منيو {branch.name} بالترابيزة المحددة. (الترابيزات المفعّلة فقط)
      </p>

      <div className="max-h-72 overflow-y-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>رقم الترابيزة</TableHead>
              <TableHead className="text-end">الإجراءات</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tables.map((tbl) => (
              <TableRow key={tbl.id}>
                <TableCell className="font-medium tabular-nums">ترابيزة {tbl.tableNumber}</TableCell>
                <TableCell className="text-end [&>button]:ms-1">
                  <Button size="sm" variant="outline" onClick={() => copyLink(tbl.tableNumber)}>نسخ الرابط</Button>
                  <Button size="sm" variant="outline" onClick={() => window.open(publicMenuUrl(cafeSlug, branch, tbl.tableNumber), "_blank")}>فتح المنيو</Button>
                  <Button size="sm" onClick={() => downloadQr(tbl.tableNumber)}>تحميل QR</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {qrPreview && (
        <div className="flex items-center gap-3 rounded-md border p-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qrPreview.dataUrl} alt={`QR ترابيزة ${qrPreview.table}`} className="size-24 rounded-md border" />
          <p className="text-sm text-muted-foreground">
            ده كود ترابيزة {qrPreview.table} — اتحمّل كصورة PNG، اطبعه وحطه على الترابيزة.
          </p>
        </div>
      )}
    </div>
  );
}

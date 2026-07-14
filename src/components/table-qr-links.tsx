"use client";

import { useState } from "react";
import QRCode from "qrcode";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

// روابط QR للترابيزات — per-table links with copy / open / QR download.
export function TableQrLinks({
  cafeSlug,
  branch,
}: {
  cafeSlug: string;
  branch: { id: string; name: string; menuSlug: string | null };
}) {
  const [tableCount, setTableCount] = useState(10);
  const [qrPreview, setQrPreview] = useState<{ table: number; dataUrl: string } | null>(
    null
  );

  async function copyLink(table: number) {
    const url = publicMenuUrl(cafeSlug, branch, table);
    try {
      await navigator.clipboard.writeText(url);
      toast.success(`اتنسخ رابط ترابيزة ${table}`);
    } catch {
      toast.error("النسخ فشل — انسخ الرابط يدوي");
    }
  }

  async function downloadQr(table: number) {
    try {
      const url = publicMenuUrl(cafeSlug, branch, table);
      const dataUrl = await QRCode.toDataURL(url, {
        width: 512,
        margin: 2,
        errorCorrectionLevel: "M",
      });
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `qr-${branch.menuSlug ?? branch.id}-table-${table}.png`;
      a.click();
      setQrPreview({ table, dataUrl });
    } catch {
      toast.error("توليد الـ QR فشل");
    }
  }

  const tables = Array.from({ length: Math.max(1, Math.min(tableCount, 100)) }, (_, i) => i + 1);

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-2">
        <div className="space-y-1">
          <Label className="text-xs">عدد الترابيزات</Label>
          <Input
            type="number"
            min="1"
            max="100"
            className="w-24"
            value={tableCount}
            onChange={(e) => setTableCount(Number(e.target.value) || 1)}
          />
        </div>
        <p className="pb-2 text-xs text-muted-foreground">
          امسح أي كود بموبايلك وهتفتح منيو {branch.name} بالترابيزة المحددة.
        </p>
      </div>

      <div className="max-h-72 overflow-y-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>رقم الترابيزة</TableHead>
              <TableHead className="text-end">الإجراءات</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tables.map((table) => (
              <TableRow key={table}>
                <TableCell className="font-medium tabular-nums">
                  ترابيزة {table}
                </TableCell>
                <TableCell className="text-end [&>button]:ms-1">
                  <Button size="sm" variant="outline" onClick={() => copyLink(table)}>
                    نسخ الرابط
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      window.open(publicMenuUrl(cafeSlug, branch, table), "_blank")
                    }
                  >
                    فتح المنيو
                  </Button>
                  <Button size="sm" onClick={() => downloadQr(table)}>
                    تحميل QR
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {qrPreview && (
        <div className="flex items-center gap-3 rounded-md border p-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={qrPreview.dataUrl}
            alt={`QR ترابيزة ${qrPreview.table}`}
            className="size-24 rounded-md border"
          />
          <p className="text-sm text-muted-foreground">
            ده كود ترابيزة {qrPreview.table} — اتحمّل كصورة PNG، اطبعه وحطه على
            الترابيزة.
          </p>
        </div>
      )}
    </div>
  );
}

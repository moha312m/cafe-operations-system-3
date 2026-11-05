import fs from "fs";
import path from "path";

const WORKTREE = "C:/Users/Acer/.codex/worktrees/nextcup-workspace-redesign/cafe-operations-system-3";

function patchFile(relPath, replacer) {
  const fullPath = path.join(WORKTREE, relPath);
  let content = fs.readFileSync(fullPath, "utf8");
  const isCrlf = content.includes("\r\n");
  const normalized = content.replace(/\r\n/g, "\n");
  const updated = replacer(normalized);
  if (updated === normalized) {
    console.warn(`No changes applied to ${relPath}`);
  } else {
    const finalContent = isCrlf ? updated.replace(/\n/g, "\r\n") : updated;
    fs.writeFileSync(fullPath, finalContent, "utf8");
    console.log(`Successfully patched ${relPath}`);
  }
}

// 1. Patch shift-close-flow.tsx
patchFile("src/components/pos/shift-close-flow.tsx", (s) => {
  const oldCode = `    {flow.handover.enabled && exceptionAllowed && <details className="rounded-lg border p-3 text-sm" open={branchCustody || undefined}>
      <summary className="cursor-pointer text-muted-foreground">آخر شيفت في اليوم؟</summary>
      <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={branchCustody} onChange={(e) => setBranchCustody(e.target.checked)} />تسليم المخزون لعهدة الفرع بدل الشيفت الجاي</label>
      {needsDisposition && <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="space-y-1"><span className="text-xs">المتروك في الدرج</span><TouchNumberInput aria-label="كاش متروك في الدرج" type="number" min="0" step="0.01" value={leftInDrawer} onValueChange={setLeftInDrawer} /></label>
        <label className="space-y-1"><span className="text-xs">المحوّل للخزنة</span><TouchNumberInput aria-label="كاش محول للخزنة" type="number" min="0" step="0.01" value={toTreasury} onValueChange={setToTreasury} /></label>
      </div>}
    </details>}`;

  const newCode = `    {flow.handover.enabled && exceptionAllowed && (
      <div className="rounded-xl border bg-muted/20 p-3 text-sm space-y-2">
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            id="branch-custody-toggle"
            type="checkbox"
            className="mt-1 h-4 w-4 rounded border-gray-300"
            checked={branchCustody}
            onChange={(e) => setBranchCustody(e.target.checked)}
          />
          <div className="space-y-1">
            <span className="font-semibold text-foreground block">
              آخر شيفت في اليوم؟ (تسليم المخزون لعهدة الفرع)
            </span>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {branchCustody ? (
                <span className="text-amber-800 dark:text-amber-300 font-medium block">
                  ⚠️ مفعل: إغلاق نهائي للمبيت وعزل العهدة للفرع. يتطلب اعتماد مدير الفرع وتأكيد سطور الجرد بالزر الإلكتروني. (إذا كان هناك شيفت قادم، اترك الخيار غير محدد).
                </span>
              ) : (
                <span className="block">
                  الوضع الطبيعي الموصى به: تسليم مباشر للشيفت التالي — يستلم الكاشير بضغطة زر واحدة دون الحاجة لتوقيع أو اعتماد سطور.
                </span>
              )}
            </p>
          </div>
        </label>
        {branchCustody && needsDisposition && (
          <div className="mt-3 grid gap-2 sm:grid-cols-2 pt-2 border-t">
            <label className="space-y-1"><span className="text-xs">المتروك في الدرج</span><TouchNumberInput aria-label="كاش متروك في الدرج" type="number" min="0" step="0.01" value={leftInDrawer} onValueChange={setLeftInDrawer} /></label>
            <label className="space-y-1"><span className="text-xs">المحوّل للخزنة</span><TouchNumberInput aria-label="كاش محول للخزنة" type="number" min="0" step="0.01" value={toTreasury} onValueChange={setToTreasury} /></label>
          </div>
        )}
      </div>
    )}`;

  return s.replace(oldCode, newCode);
});

// 2. Patch handover-journey.ts
patchFile("src/components/handovers/handover-journey.ts", (s) => {
  const oldCode = `      return { ...base, title: i.unreviewedLines > 0 ? \`وقّع \${i.unreviewedLines} سطر جرد باسم الفرع ثم حوّل العهدة لعهدة الفرع\` : "سطور الجرد موقّعة — حوّل العهدة لعهدة الفرع", actor: "مسؤول بصلاحية الاستثناء (باسم الفرع)", panel: "inventory", actionLabel: i.unreviewedLines > 0 ? "توقيع السطور" : "تحويل لعهدة الفرع", blocker: mayAct ? null : "التوقيع والتحويل لعهدة الفرع لمسؤول بصلاحية الاستثناء." };`;

  const newCode = `      return { ...base, title: i.unreviewedLines > 0 ? \`وقّع \${i.unreviewedLines} سطر جرد باسم الفرع (بالضغط على زر الاعتماد بالأسفل) ثم حوّل العهدة لعهدة الفرع\` : "سطور الجرد موقّعة — حوّل العهدة لعهدة الفرع", actor: "مسؤول بصلاحية الاستثناء (باسم الفرع)", panel: "inventory", actionLabel: i.unreviewedLines > 0 ? "تأكيد السطور بالزر" : "تحويل لعهدة الفرع", blocker: mayAct ? null : "التوقيع والتحويل لعهدة الفرع لمسؤول بصلاحية الاستثناء." };`;

  return s.replace(oldCode, newCode);
});

// 3. Patch branch-signing-panel.tsx
patchFile("src/components/handovers/branch-signing-panel.tsx", (s) => {
  const oldCode = `  return (
    <section className="space-y-3 rounded-xl border p-3" data-testid="branch-custody-sign" aria-label="توقيع سطور الجرد لعهدة الفرع">
      <div>
        <p className="font-medium">توقيع سطور الجرد باسم الفرع</p>
        <p className="text-xs text-muted-foreground">مفيش موظف مستلم في عهدة الفرع، فمسؤول بصلاحية الاستثناء بيوقّع باسم الفرع. التوقيع مابيغيّرش الكميات المعدودة، ومش عدًّا مستقلًا.</p>
      </div>`;

  const newCode = `  return (
    <section className="space-y-3 rounded-xl border p-3" data-testid="branch-custody-sign" aria-label="توقيع سطور الجرد لعهدة الفرع">
      <div className="rounded-lg bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 p-3 text-sm text-blue-900 dark:text-blue-100">
        <p className="font-semibold flex items-center gap-1.5 mb-1 text-blue-900 dark:text-blue-200">
          <span>💡</span>
          <span>كيف يتم توقيع السطور؟ (لا توجد خانة لكتابة توقيع أو نص)</span>
        </p>
        <p className="text-xs leading-relaxed text-blue-800 dark:text-blue-300">
          المقصود بـ «التوقيع» هنا ليس كتابة اسمك أو توقيع يدوي بالقلم، بل <strong>مجرد الضغط على الزر بالأسفل</strong> («اضغط هنا: تأكيد واعتماد السطور باسم الفرع»). عند الضغط عليه، يقوم النظام بتسجيل اعتماد السطور المعدودة إلكترونياً باسمك فوراً.
        </p>
      </div>
      <div>
        <p className="font-medium">تأكيد واعتماد سطور الجرد باسم الفرع</p>
        <p className="text-xs text-muted-foreground">مفيش موظف مستلم في عهدة الفرع (إغلاق مبيت)، فمسؤول بصلاحية الاستثناء بيعتمد السطور بالزر باسم الفرع. الإجراء مابيغيّرش الكميات المعدودة، ومش عدًّا مستقلًا.</p>
      </div>`;

  let updated = s.replace(oldCode, newCode);

  const oldBtn = `      <Button size="sm" disabled={running} onClick={() => setConfirm(true)} data-testid="branch-custody-sign-all">
        {running ? "جارٍ التوقيع…" : progress.phase === "stopped" ? "متابعة التوقيع" : "توقيع السطور باسم الفرع"}
      </Button>`;

  const newBtn = `      <Button size="sm" disabled={running} onClick={() => setConfirm(true)} data-testid="branch-custody-sign-all" className="font-medium">
        {running ? "جارٍ الاعتماد والتوقيع…" : progress.phase === "stopped" ? "متابعة التوقيع" : "اضغط هنا: تأكيد واعتماد السطور باسم الفرع (زر إلكتروني)"}
      </Button>`;

  return updated.replace(oldBtn, newBtn);
});

// 4. Patch handover-action-bar.tsx
patchFile("src/components/handovers/handover-action-bar.tsx", (s) => {
  const oldCode = `title={target === "BRANCH_CUSTODY" && !stockReviewReady ? "وقّع سطور الجرد باسم الفرع الأول" : undefined}`;
  const newCode = `title={target === "BRANCH_CUSTODY" && !stockReviewReady ? "اضغط على زر تأكيد سطور الجرد بالأعلى أولاً" : undefined}`;
  return s.replace(oldCode, newCode);
});

// 5. Patch handover-detail.tsx
patchFile("src/components/handovers/handover-detail.tsx", (s) => {
  let updated = s.replace(
    `<TableHead className="text-end">{branchCustody ? "توقيع الفرع" : "استلام"}</TableHead>`,
    `<TableHead className="text-end">{branchCustody ? "اعتماد الفرع" : "استلام"}</TableHead>`
  );
  updated = updated.replace(
    `{row.state === "pending" ? <span className="text-muted-foreground">{line.disposition === "PENDING" ? "—" : branchCustody ? "لم يُوقّع بعد" : "لم يُسجّل استلام بعد"}</span> : <>`,
    `{row.state === "pending" ? <span className="text-muted-foreground">{line.disposition === "PENDING" ? "—" : branchCustody ? "بانتظار الضغط على زر الاعتماد" : "لم يُسجّل استلام بعد"}</span> : <>`
  );
  return updated;
});

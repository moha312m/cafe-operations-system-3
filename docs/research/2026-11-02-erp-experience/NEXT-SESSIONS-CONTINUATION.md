# NEXT CUP — توجيهات استكمال الجلسات وخريطة الطريق الكاملة
تاريخ التحديث: 2026-11-04 (Africa/Cairo)

---

## 1. نص الإرسال المباشر لـ Argon (الجلسة الحالية / القادمة)

```text
Continue the NEXT CUP direct-handover final closeout.

First read the complete project context and updated roadmap:
C:/Dev/cafe-operations-system-3/docs/research/2026-11-02-erp-experience/ARGON-PROJECT-HANDOFF-20261104.md

Then execute this bounded continuation prompt:
C:/Dev/cafe-operations-system-3/docs/research/2026-11-02-erp-experience/prompts/05-direct-handover-final-closeout-argon.md

Implementation worktree:
C:/Users/Acer/.codex/worktrees/nextcup-workspace-redesign/cafe-operations-system-3

Expected branch:
codex/nextcup-workspace-redesign-20261102

Verify current source and existing evidence first. Complete the preview,
report verification and closeout requirements in the prompt.
The roadmap provides context; do not start its other stages automatically.
```

---

## 2. روابط ومسارات الملفات الرسمية المعتمدة

- **برومبت الاستكمال:**
  [`prompts/05-direct-handover-final-closeout-argon.md`](file:///C:/Dev/cafe-operations-system-3/docs/research/2026-11-02-erp-experience/prompts/05-direct-handover-final-closeout-argon.md)
- **تسليم المشروع وسياق العمل لـ Argon:**
  [`ARGON-PROJECT-HANDOFF-20261104.md`](file:///C:/Dev/cafe-operations-system-3/docs/research/2026-11-02-erp-experience/ARGON-PROJECT-HANDOFF-20261104.md)
- **خريطة الطريق المحدّثة (بالعربية):**
  [`PLAN.ar.md`](file:///C:/Dev/cafe-operations-system-3/docs/research/2026-11-02-erp-experience/PLAN.ar.md)
- **خطة الهوية والتوسع التشغيلي (المراحل 10–12):**
  [`REDESIGN-CRM-TEAM-ROADMAP-20261104.md`](file:///C:/Dev/cafe-operations-system-3/docs/research/2026-11-02-erp-experience/REDESIGN-CRM-TEAM-ROADMAP-20261104.md)
- **تفاصيل دورة التسليم والاستلام المبسط (الخطوة 5):**
  [`STEP-5-HANDOVER-WORKFLOW.md`](file:///C:/Dev/cafe-operations-system-3/docs/research/2026-11-02-erp-experience/STEP-5-HANDOVER-WORKFLOW.md)
- **تصميم وتغطية المحاسبة 4B.2:**
  [`STEP-4B2-DESIGN.md`](file:///C:/Dev/cafe-operations-system-3/docs/research/2026-11-02-erp-experience/STEP-4B2-DESIGN.md)

---

## 3. بيئة العمل وفروع Git

- **Worktree التنفيذي:**
  `C:/Users/Acer/.codex/worktrees/nextcup-workspace-redesign/cafe-operations-system-3`
- **فرع العمل:**
  `codex/nextcup-workspace-redesign-20261102`
- **حالة الالتزامات (Commits):**
  - إغلاق المحاسبة 4B.2 وتصدير الحسابات محفوظ في `bbbed42`.
  - إصلاح عرض النافذة محفوظ في `203cc48`.
  - دورة التسليم السابقة وتقاريرها محفوظة في `3ea7c9b`.
  - تعديلات التسليم المباشر وتوزيع النقدية لا تزال محلية (غير ملتزمة) مع 3 migrations غير متتبعة (`20261106090000_direct_handover_cash_disposition`, `20261106100000_handover_issue`, `20261106110000_handover_direct_flag`).

---

## 4. المهام المتبقية قبل إغلاق دفعة التسليم المبسط (Step 5 Direct Handover)

1. **تحديد حارس معاينة 3113 الفعلي:** مسار `scripts/preview-server-3113.mjs` المذكور بالتقرير لم يوجد في المكان المتوقع، ويجب اكتشاف آلية الحراسة والتشغيل الفعلية.
2. **مطابقة أدلة الاختبارات والمتصفح مع المصدر والبناء النهائي:** مطابقة 34 اختبارًا و291 فحصًا وسجلات البناء.
3. **مراجعة فواصل صفحات تقرير PDF والتحقق من فتح ملف XLSX في برنامج جداول.**
4. **توفير بيئة معاينة حية نهائية للمالك للحصول على القبول البصري.**

---

## 5. تسلسل المراحل القادمة في المشروع

| الترتيب | المرحلة | النطاق والمطلوب |
|---|---|---|
| **الحالي** | **إغلاق الخطوة 5** | إغلاق التحقق من التسليم المبسط، معاينة 3113، وقبول المالك |
| **التالي** | **المرحلة 10A** | نماذج التصميم البصري الجديدة (مستوحاة من النماذج الـ 5) للموافقة |
| **لاحقاً** | **المرحلة 10B–10C** | بناء وتطبيق مكونات التصميم الموحدة تدريجياً |
| **لاحقاً** | **المرحلة 11A–11C** | إدارة الفروع ومهام الموظفين واعتماد الإنجاز |
| **لاحقاً** | **المرحلة 12A–12C** | نظام إدارة علاقات العملاء (CRM)، سجل العميل، والشكاوى والمتابعات |
| **محفوظة** | **المراحل 6–9** | QR الذاتي (6)، النسخ الاحتياطي لجهاز المالك (7)، تشغيل LAN والمزامنة (8)، والتسعير من التكلفة (9) |
| **مفتوحة** | **المحاسبة 4B.3–4B.5**| بانتظار قرارات D6 و D7/D8 واعتماد المحاسب القانوني |

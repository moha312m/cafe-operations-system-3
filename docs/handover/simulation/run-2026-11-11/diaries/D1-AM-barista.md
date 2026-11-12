# يوميات مازن — باريستا — D1-AM

### D1-AM-S2b — طابور البار
- What I tried: قرأت GET /api/sales/kitchen و /api/display/orders و /api/orders حوالي 10 مرات. حاولت POST /api/orders/<id>/status بـ PREPARING ثم PATCH.
- What I expected, as a باريستا: أشوف الطلبات في شاشة التحضير وأحرّكها PREPARING ثم READY.
- What the system did: kitchen يرجع {"tickets":[]} دائما رغم وجود 21 طلب CONFIRMED (#12 #14-#33). display/orders يعرضهم كلهم تحت "preparing" و ready فاضي. POST .../status = 405 بدون رسالة. PATCH .../status = 403 «ليس لديك صلاحية لتنفيذ هذا الإجراء» (حسابي عنده orders:update-status). SERVED من CONFIRMED على #31 = نفس الـ403. PATCH /api/orders/<id> بـ status = 400 «لا يمكن تعديل الطلب بعد دخوله مرحلة التحضير» (والطلب لسه CONFIRMED).
- My comment: ما قدرت أحرّك ولا طلب. شاشة kitchen فاضية والـdisplay بيقول "جاري التحضير" على طلبات محدش بدأها. الرسائل مش واضحة (405 صامت، و400 رسالة غلط). مفيش طريقة أعرف بها إلغاء طلب.

### D1-AM-S2c — تحضير الطلبات بعد منح الصلاحية
- What I tried: PATCH /api/orders/<id>/status بـ PREPARING ثم READY على #12 #14 #15 #16-#31 و#33 (بدون #32). كل شوية قرأت الطابور. جربت SERVED على #16 و#17 (تيك أواي مدفوع).
- What I expected, as a باريستا: كل طلب يتحرك، وشاشة العرض تظهر الجاهز.
- What the system did: كل الطلبات وصلت READY (200). #14 كان PREPARING من محاولتي الأولى فالـPREPARING التاني رجع 400 «الحالة دي مش مسموحة للطلب». display/orders بقى يظهر ready لـ 20 طلب و preparing:[32]. SERVED على #16 و#17 = 200.
- My comment: تمام. الباريستا يقدر يعمل SERVED (غالبا الكاشير/الويتر هو المفروض). رسالة 400 مش واضحة.

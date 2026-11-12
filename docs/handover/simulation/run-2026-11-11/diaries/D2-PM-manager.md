# يوميات هالة — مديرة الفرع — اليوم 2 مساءً

### D2-PM-S3e — مصروف ثلج 40 جنيه بدون إيصال
- What I tried: POST /api/expenses مبلغ 40، بدون documentReference، --idem. بعدها فتحت شيفتي (POST /api/shifts openingCashAmount 0) وجربت المصروف مرة ثانية.
- What I expected, as a مديرة: تسجيل المصروف على درج كريم الذي دفع منه.
- What the system did: 400 «التحصيل محتاج شيفت مفتوح». فتح شيفتي: 201، شيفت #5 id cmwcb2vtt00x3hljodnt828vb، درج 0. المصروف ثانيةً: 400 «النقد المتوقع المتاح لا يكفي للصرف؛ تحقق من الدرج». لا يوجد مصروف مسجل.
- My comment: لا توجد طريقة لتسجيل مصروف دُفع من درج كاشير آخر. الـ40 خرجت من درج كريم ولا أثر لها. فتح شيفت جديد للمدير لا يحل المشكلة وسبب مشكلة أخرى (S5). رسالة الخطأ الأولى مضللة (لفظ «التحصيل» لمصروف).

### D2-PM-S5 — إغلاق ليلي إلى عهدة الفرع
- What I tried: GET close-flow؛ ثم إغلاق شيفت كريم cmwcasvek00pphljogyptmg2y بـ BRANCH_CUSTODY.
- What I expected: إغلاق شيفت كريم وبدء عد المخزون.
- What the system did: close-flow 200 لكنه يعرض شيفتي أنا (#5) لا شيفت كريم. إغلاق كريم: 409 «فيه شيفت تاني لسه شغال في الفرع…». إغلاق شيفتي BRANCH_CUSTODY: نفس الـ409 (كل شيفت يمنع الآخر). إغلاق شيفتي SHIFT_TO_SHIFT: 200، حالة AWAITING_HANDOVER وأنشأ تسليم DRAFT id cmwcb3zgz00xjhljotnbv5i9v. إغلاق كريم ثانية: 409 EXISTING_ACTIVE_HANDOVER (تسليمي). محاولة إلغاء تسليمي: 403 «مينفعش المُسلّم ينهي تسليمه بنفسه — ده إجراء مدير أو مالك».
- My comment: عالقة. شيفت كريم ما زال مفتوحاً. أحتاج مدير آخر (محمد المدير) أو المالك لإلغاء التسليم cmwcb3zgz00xjhljotnbv5i9v. توقفت.

### D2-PM-S5 (استكمال بعد إصلاح يدوي — «اختُبر بعد إصلاح يدوي») — إغلاق كريم إلى عهدة الفرع
- What I tried: إغلاق شيفت كريم #4 بـ BRANCH_CUSTODY: نقد 3083.05، كارت 230.6، محفظة 114، السبب «زيادة 30 غير معروفة + 40 ثلج خرجت بلا إيصال ولم يمكن تسجيلها». ثم جرد بن 12.319 ولبن 33.68 (أرقام GET /api/inventory).
- What the system did:
  - close: 200، AWAITING_HANDOVER، المتوقع 3093.05، الفعلي 3083.05، الفرق -10، حالة فرق نقدية cmwcb9tov00ymhljoldtlv0ow. لم يطلب توزيع نقدية. التسليم cmwcb9tra00yshljoragymaka (DRAFT، BRANCH_CUSTODY).
  - start_count: 200، جلسة cmwcba1ia00z8hljo3otcl22j. عد السطرين: 200 لكل منهما. submit: 200 CONFIRMED تلقائياً (within 2، outside 0). confirm: 200 alreadyConfirmed.
  - finish_outgoing: 200 OUTGOING_SUBMITTED.
  - to-branch-custody (مرتين): 409 «في سطور من الجرد الحالي لسه ماتسجلش استلامها».
  - acknowledge: 409 «مفيش وردية مستلمة مستنية العهدة».
  - override-accept NO_INCOMING: 409 «التسليم ده للعهدة المركزية — الاستلام العادي مش بيغطيه».
- My comment: لا أستطيع إنهاء الليلة. المسار يطلب تسجيل استلام السطور ولا توجد وردية مستلمة. توقفت.

# يوميات اليوم 3 صباحاً — ضغط وسوء استخدام (مختبِر ضوابط يلعب كل الأدوار)

ملاحظة: استخدمت حساب المالك للقراءة فقط (المخزون، التقارير، تفاصيل التسليم) لمعرفة أرقام النظام، وللكتابة فقط في D3-AM-4 (تسوية الخلاف) كما تطلب الخطوة.

حالة البداية: شيفت #4 كريم CLOSED، شيفت #5 هالة CLOSED، تسليم الليل cmwcb9tra00yshljoragymaka COMPLETED على عهدة الفرع. لا شيفت مفتوح.

### D3-AM-1 — فتح الصبح على عهدة الفرع (سارة)
- What I tried: GET active؛ فتح شيفت بـ 3083.05؛ بيع قبل التحقق؛ start_count؛ عد 10 سطور بأرقام النظام ولبن 33.18 (أقل 0.5)؛ submit؛ إعادة عد؛ سبب الفرق؛ تأكيد المديرة؛ verify.
- What I expected, as a كاشير: الشاشة تقول لي إن المتوقع في الدرج 3083.05 وأؤكد استلامه، ثم جرد الصبح، ثم أبيع.
- What the system did:
  - GET active قبل الفتح: carryforward source NONE، expectedOpeningCash null، «الشيفت السابق #5 هالة» (مش #4 كريم صاحب الدرج). لا يوجد إيصال نقدية لأؤكده.
  - POST /api/shifts: 201 شيفت #6 id cmwcjm12e010thljotyzdcd7i، openingCashReceipt null، custodyGateReason AWAITING_OPENING_VERIFICATION. الرقم 3083.05 كتبته أنا ولم يقارنه النظام بأي شيء.
  - بيع قبل التحقق: 400 «الشيفت مستني استلام العهدة» (صح).
  - start_count: 200 جلسة cmwcjml2y0113hljoew05bd6b (FULL، BLIND، 10 أصناف)، فترة عهدة الفرع cmwcbdxby010lhljoo94phcvg.
  - عد 10 سطور: 200 لكل سطر. submit: 200 RECOUNT_REQUIRED (within 9، outside 1 = لبن). إعادة العد بنفس الرقم + submit: نفس RECOUNT_REQUIRED.
  - سارة confirm: 403. سارة variance-reason: 403 «ليس لديك صلاحية».
  - هالة accept-variance (SIM_ST_COUNT): 200 VARIANCE_CONFIRMED. هالة confirm: 200 CONFIRMED، varianceCaseIds [] (deferred BRANCH_OPENING_VERIFICATION).
  - verify: 200 VERIFIED، rebase لبن 33.68→33.18، حالة فرق cmwcjpqvt012chljomj5pgvrn، cashCustodyPeriodId cmwcjm1bb010vhljo8dl7tx6o.
  - بعدها البيع اشتغل (D3-AM-3).
  - فرق اللبن في التقارير: STOCK، responsibility BRANCH، attribution BRANCH_CUSTODY/SHARED، employee null، القيمة null «فرق خامات بدون تكلفة مسجلة» رغم unitCost 38. التقرير يعرض استثناء OPENING_WITHOUT_RECEIPT لشيفت #6.
- My comment: جرد الصبح ممتاز للمخزون. لكن النقدية لم تُتحقق: لا رقم متوقع، لا إيصال، كان ممكن أكتب أي رقم. فرق اللبن على «الفرع» بدون قيمة جنيه.

### D3-AM-2 — كاشيرين يفتحوا في نفس الوقت
- What I tried: كريم يفتح شيفت وسارة فاتحة؛ سارة تفتح شيفت ثاني (مرة ومرتين بالتوازي)؛ كريم يفتح ثاني.
- What I expected: إما منع الشيفت الثاني أو ضمه لنفس الدرج.
- What the system did: كريم 201 شيفت #7 id cmwcjqoni014ehljounujuak4، درج منفصل بـ 0، custodyReadyAt فوراً بدون أي استلام أو جرد. سارة ثانية: 200 alreadyOpen true (نفس #6)، والتوازي: الاثنين 200 alreadyOpen. كريم ثانية: 200 alreadyOpen. كل فتح متكرر غيّر custodyReadyAt للشيفت الموجود (20:02:32 → 20:03:30 → 20:03:31).
- My comment: شخص واحد لا يفتح درجين (صح). لكن الكاشير الثاني يبيع فوراً من مخزون في عهدة سارة بدون أي استلام. وهذا سبّب قفل كامل بعدها (D3-AM-5 و7).

### D3-AM-3 — خدمة
- What I tried: 6 طلبات تيك أواي لسارة، 2 لكريم، الباريستا READY، الكاشير SERVED.
- What the system did: سارة 201: #65 (57 كاش) cmwcjri6t0156hljo3pxxoobv، #66 (68.4 كارت) cmwcjrifc015hhljocd7xjaqj، #67 (79.8 محفظة) cmwcjriks015shljo5a7yh684، #68 (96.9 مختلط 50 كاش + 46.9 كارت) cmwcjrirr0163hljo9plpd4ne، #69 (68.4 كاش) cmwcjrj0g016hhljoult7bp2b، #70 (85.5 كاش) cmwcjrj5t016shljoue8gy6t4. كريم 201: #71 (28.5) cmwcjrqlp0173hljoirtf9r23، #72 (68.4) cmwcjrqrm017ehljoh6uzd5qi، كلها على شيفت #7 (درجه هو). READY مباشرة من CONFIRMED: 400 «الحالة دي مش مسموحة»؛ بعد PREPARING كله 200، ثم SERVED 200.
- My comment: كويس. ملاحظة: الـ ROUTES لا يذكر أن PREPARING لازم قبل READY.

### D3-AM-4 — تسليم نقدية للمديرة، خلاف ثم تسوية
- What I tried: توزيع النقدية قبل الإغلاق؛ إغلاق SHIFT_TO_SHIFT؛ توزيع 500 لهالة والباقي 2843.95 في الدرج؛ هالة تعترض «استلمت 450 بس»؛ هالة وسارة تحاولا التسوية؛ المالك يسوي 450.
- What the system did:
  - توزيع قبل الإغلاق: 409 «اقفل الشيفت ماليًا الأول».
  - إغلاق: 200 AWAITING_HANDOVER، فعلي = متوقع = 3343.95، تسليم cmwcju7bm01aphljo359a7lmj.
  - قائمة المستلمين فيها «أحمد المالك» مرتين بـ id مختلفين.
  - توزيع: 201 cmwcjue8801b3hljo10nhj39a، تسليم نقدية cmwcjue8a01b5hljo8y1p7x5e DECLARED.
  - اعتراض: 200 DISPUTED؛ اعتراض ثاني بمفتاح مختلف: 200 alreadyDisputed.
  - تسوية هالة: 403 «للمالك فقط». سارة: 403. المالك: 200 RESOLVED (450). تسوية ثانية بمبلغ 500: 200 alreadyResolved (لم يتغير).
  - الأثر: صف سارة في تقرير المساءلة deliveries resolvedShortfall 50 و«shared cashAmount -50»؛ لكن إغلاق #6 مكتوب «مطابق» (أخضر)، لا حالة فرق جديدة، والـ 50 غير داخلة في cash.shortage ولا grossVariance لسارة (412.84 = 300 + 112.84).
- My comment: الأثر موجود لكن ضعيف. التسوية تحدد المبلغ فقط، لا تحدد من يتحمل الـ 50 (سارة أم هالة). الإغلاق يظهر مطابق.

### D3-AM-5 — خروج واستلام في نفس اللحظة / جهازين
- What I tried: جرد تسليم سارة (بن 12.265، لبن 32.78) وsubmit؛ بالتوازي: سارة finish_outgoing + كريم acknowledge ثم accept + كريم جهاز 2 accept بمفتاح مختلف.
- What the system did:
  - جرد التسليم: جلسة cmwcjwb8u01bfhljos64jrdhf، submit 200 CONFIRMED تلقائياً.
  - التوازي: سارة 200 OUTGOING_SUBMITTED. كريم ack: 409 «مفيش وردية مستلمة مستنية العهدة». كريم accept (الجهازين): 409 «في سطور من الجرد الحالي لسه ماتسجلش استلامها». إعادة ack بعد الإرسال: نفس 409.
  - كريم حاول يقفل #7 علشان يبقى مستلم: 409 EXISTING_ACTIVE_HANDOVER. يعني كريم لا يستطيع الاستلام ولا الإغلاق.
  - هالة acknowledge: نفس 409. to-branch-custody: 409 «مش للعهدة المركزية». override MANAGER_ADJUSTMENT و NO_INCOMING بسبب: 409 «سطور لسه ماتسجلش استلامها».
  - منى (محاسبة، دور CASHIER) تفتح شيفت: 403.
  - الحل الوحيد: هالة فتحت شيفت #8 id cmwck4poi0001hl3gnn2hl1tm بـ 2843.95 → pending AWAITING_CUSTODY_TRANSFER، carryforward PENDING_HANDOVER 2843.95 (لكن «الشيفت السابق #7 كريم» بدل #6 سارة).
  - السباق الحقيقي بالتوازي: هالة جهاز 1 ack 200 + accept 200 COMPLETED؛ هالة جهاز 2 ack 409 «فيه سطر ناقص أو مسجل بالفعل» و accept 409 «التسليم ده اتقفل خلاص»؛ كريم accept على شيفت هالة: 409 «التسليم مشغول بعملية تانية»، وبعد الانتهاء 409 «اتقفل خلاص»؛ سارة finish ثانية 200 alreadySubmitted. إعادة نفس مفتاح جهاز 1: 200 نفس النتيجة.
  - النتيجة: استلام واحد. الدرج 2843.95 HANDED_TO_SHIFT #8 هالة. عهدة نقدية cmwck534b001hhl3ghomrwufn، مخزن cmwck533m0019hl3g0wzd8w26.
- My comment: السباق محمي جيداً. لكن الكاشير اللي فتح بالتوازي محبوس: لا يستلم ولا يقفل ولا المديرة تقدر تتجاوز. اضطررت المديرة تفتح شيفت تاني.

### D3-AM-6 — تعديل الجرد بعد التوقيع وتطبيق الفروق مرتين
- What I tried: سارة PATCH لبن 30 على جرد التسليم (بدون وبعد expectedCountedAt)؛ PATCH على جرد الصبح؛ هالة PATCH؛ هالة accept-variance مرتين (نفس المفتاح ومختلف) على جرد التسليم وعلى لبن الصبح (نفس السبب وسبب مختلف وبالتوازي)؛ request-recount على التسليم المكتمل؛ recount سطر.
- What the system did: PATCH بدون expectedCountedAt: 409 «الكمية اتغيرت من تسجيل أحدث» (رسالة مضللة)؛ مع expectedCountedAt الصحيح: 409 «الجرد ده اتقفل خلاص — مينفعش تسجل كمية عليه». جرد الصبح: 409 مقفول. كل accept-variance (7 محاولات): 409 «الجرد ده اتقفل خلاص». request-recount: 409 «التسليم مش في حالة تسمح بطلب إعادة الجرد». recount سطر: 400 تحقق مدخلات.
- My comment: سليم. رسالة الـ PATCH الأولى مضللة فقط.

### D3-AM-7 — تجاوز المديرة بسبب وبدون سبب / كاشير يمشي بدون تسليم
- What I tried (أ، على تسليم سارة وهو مفتوح): override بدون سبب وبدون ملاحظة؛ سبب فقط؛ ملاحظة فقط؛ سبب + ملاحظة فراغات.
- What the system did: 400 «reasonCodeId: لازم تحدد سبب الاستثناء»؛ 400 «note: لازم تكتب سبب الاستثناء بالتفصيل»؛ ملاحظة فقط: أول مرة NETWORK_ERROR (fetch failed)، الإعادة 400 reasonCodeId (9.7 ثانية)؛ فراغات: 400. ومع السبب: 409 (شوف D3-AM-5).
- What I tried (ب): كريم يقفل #7 SHIFT_TO_SHIFT بـ 96.9 ويمشي بدون عد ولا توزيع نقدية. هالة: override بدون سبب، ثم بسبب (NO_INCOMING و MANAGER_ADJUSTMENT لنفسها)، approve، to-branch-custody، cancel بدون/بسبب.
- What the system did:
  - إغلاق كريم: 200 AWAITING_HANDOVER، تسليم cmwck6kew001xhl3gbq9d6vrh DRAFT.
  - GET /api/handovers/<id> للمسودة: 409 «التسليم مش في مرحلة مراجعة» (حتى للمالك) — لا أستطيع رؤية التفاصيل.
  - override بدون سبب: 400. بسبب: 409 «التسليم مش في حالة تسمح بالاستلام». approve: 409 «المُسلّم يبدأ الجرد الأول». to-branch-custody: 409. cancel بدون سبب: 400؛ بسبب: 409 «عهدة المخزن المرتبطة بالتسليم مش مفتوحة».
  - هالة start_count نيابة عنه: 200 (رغم رسالة approve). جلسة cmwck7xvr002bhl3gfa7z1gzz، عد بن 12.265 ولبن 32.78، submit SUBMITTED (مش تلقائي)، هالة confirm جردها بنفسها: 200 CONFIRMED.
  - finish_outgoing (هالة ثم كريم): 409 «الجرد ده اتقفل خلاص». المسار القديم {"action":"submit"} من كريم: 200 OUTGOING_SUBMITTED.
  - بعدها override بدون سبب 400، بسبب 409 «سطور ماتسجلش استلامها»، cancel بسبب 409 «عهدة المخزن مش مفتوحة».
  - درج كريم 96.9: لا توزيع، carryforward للي هيفتح: PENDING_HANDOVER، expectedOpeningCash null، «الشيفت السابق #8 هالة».
- My comment: الكاشير اللي يمشي بدون تسليم يقفل الفرع: المديرة لا تستطيع الإلغاء لعهدة الفرع ولا التجاوز. المخزون لم يُعد إلا لما المديرة عدّت بنفسها وأكدت جردها بنفسها. finish_outgoing يرفض والمسار القديم يقبل.

## حالة الفرع في النهاية
- شيفت واحد مفتوح وشغال: #8 هالة cmwck4poi0001hl3gnn2hl1tm (درج 2843.95 + عهدة المخزن).
- #6 سارة CLOSED (تسليمها COMPLETED). #7 كريم AWAITING_HANDOVER، تسليمه cmwck6kew001xhl3gbq9d6vrh OUTGOING_SUBMITTED ينتظر أول شيفت جديد يفتح (يستلم 96.9 والخامات). لا يمكن إلغاؤه لعهدة الفرع.
- الشيفت الجاي لازم يعرف: أي شخص يفتح شيفت هيبقى «مستلم» تسليم كريم؛ والكاش المتوقع لن يظهر له (null)؛ الرقم الصحيح 96.9.

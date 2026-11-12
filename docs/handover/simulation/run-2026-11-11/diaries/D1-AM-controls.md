# D1-AM-CTRL — مختبر الضوابط (controls tester)

كل الطلبات عبر sim.mjs على localhost:3100. بدون حساب المالك. بدون SQL.

### D1-AM-CTRL-1 — الويتر يحاول يشوف الكاش والتسليم
- What I tried: وليد: GET shifts, close-flow, handovers, handover detail, cash-deliveries, reports/daily, accounting/pnl, expenses؛ POST payments (1 ج على طلب #1)؛ PATCH status CANCELLED على #33 و #31 (مدفوعين ومقدَّمين)، وبعدين على #34 (مدفوع ولسه CONFIRMED).
- What I expected, as a ويتر: كله ممنوع.
- What the system did: كل القراءات 403 ما عدا cash-deliveries = 200 `{"deliveries":[]}` (فاضية). payments = 403. الإلغاء = 400 «الحالة دي مش مسموحة» على SERVED، و 409 «Refund outstanding collections…» على #34.
- My comment: سليم. لكن رفض الإلغاء جه من قاعدة حالة الطلب، مش من الصلاحية — الويتر وصل لفحص الحالة. expenses بقيمة "1" نص رجعت 400 قبل فحص الصلاحية.

### D1-AM-CTRL-2 — الباريستا يبيع ويحصّل
- What I tried: مازن: نفس القراءات + shift report #1؛ POST orders (CASH NOW و PENDING)؛ POST payments.
- What I expected, as a باريستا: ممنوع.
- What the system did: كله 403 (cash-deliveries 200 فاضية).
- My comment: fine.

### D1-AM-CTRL-3 — أمين المخزن والكاش
- What I tried: عادل: GET shifts، handover detail، employee-variances؛ POST purchases/cmwc3ugj700hohl54xa7o4jfu/payments 1 ج CASH بدون شيفت.
- What I expected, as a أمين مخزن: ما يشوفش فروق كاش الكاشير؛ الدفع النقدي للمورد يتسجل على درج/خزنة معروفة.
- What the system did: shifts 403. handover detail 200 (جرد بن/لبن، بدون أرقام كاش). employee-variances 200 وفيها فرق كاش سارة -300. الدفع 200 → paidAmount 301، payment cmwc8t6qs00ukhl54t7389sx9، fundingSource = null.
- My comment: الدفع نجح من غير شيفت ومن غير مصدر فلوس. ومفيش قيد في الدفاتر للدفعات (حساب الموردين 2100 دائن 1050 بدون أي مدين).

### D1-AM-CTRL-4 — المحاسبة منى
- What I tried: GET pnl/trial-balance/journal/daily/expenses/shifts/employee-variances/shift report #1/audit؛ POST orders، payments، shifts، expenses؛ backup export.
- What I expected, as a محاسبة: تقرأ الدفاتر؛ ما تبيعش ولا تفتح شيفت ولا تحصّل.
- What the system did: القراءات 200. البيع/التحصيل/فتح الشيفت 403. المصروف 403 «الصرف والرد للمالك والمدير المخولين فقط». backup 403.
- My comment: سليم. whoami بيعرض صلاحيات orders:create/payments:create/shifts:operate بس التنفيذ بيرفض — العرض مش مطابق.

### D1-AM-CTRL-5 — سارة بعد التسليم
- What I tried: PATCH سطر بن في جرد cmwc437pl00skhl54xticf06c؛ submit تاني؛ accept لتسليمها؛ cash-disposition لنفسها؛ variance-reason؛ request-recount؛ issues؛ GET report.
- What I expected, as a كاشير خلّصت: كله مقفول.
- What the system did: PATCH 409 «الجرد ده اتقفل خلاص» (أول مرة 409 رسالة تعارض). submit 409. accept 409 «التسليم ده اتقفل». disposition 400 ثم 409 «اتسجل قبل كده». variance-reason 403. recount 409. issues = 201 → issue cmwc91alh01kvhl54y81snlls OPEN. report 403.
- My comment: الأقفال شغالة. سارة ما تقدرش تشوف تقرير شيفتها هي. فتح «مشكلة» على تسليم مكتمل مسموح (عملت واحدة اختبار).

### D1-AM-CTRL-6 — كريم يوافق لنفسه
- What I tried: accept-variance على سطر مقفول؛ resolve للمشكلة cmwc91alh01kvhl54y81snlls؛ طلب استرداد على طلب #23 من شيفت الصباح؛ decision ACCEPT.
- What I expected, as a كاشير: ما يوافقش لنفسه.
- What the system did: accept-variance 403، resolve 403. الاسترداد 202 → request cmwc94ygq0001hljogqsn26qa PENDING 165.3. decision 403 «Only the selected active cafe owner…». بعدها طلب تاني لنفس الطلب 202 → cmwc97x3a000qhljoqwqn9aje PENDING (اتنين معلقين لنفس الطلب).
- My comment: الموافقة محمية. لكن ينفع يتعمل أكتر من طلب استرداد معلق لنفس الطلب.

### D1-AM-CTRL-7 — هالة على فرع تاني
- What I tried: GET shifts/inventory/orders/daily/handovers/pnl/expenses بفرع مدينة نصر؛ POST shifts هناك؛ re-sync جرد التسليم المقفول؛ accept-variance.
- What I expected, as a مديرة فرع: فرع تاني ممنوع.
- What the system did: shifts/inventory/orders = 200 بس بيرجعوا بيانات فرع التجمع (الـ branchId اتجاهل). daily/expenses/handovers/pnl 403. فتح شيفت 403 «ليس لديك صلاحية على فرع تاني». re-sync 403 «للمالك فقط». accept-variance 409 مقفول.
- My comment: مفيش تسريب، لكن الشاشة ممكن تفهّم المديرة إن ده فرع مدينة نصر. حركة مخزون على صنف فرع تاني ما اتجربتش (مالقيتش id صنف من الفرع التاني).

### D1-AM-CTRL-8 — التكرار
- What I tried: دفعة مورد بنفس المفتاح، بالتوازي، بمفتاح مختلف، نفس المفتاح بجسم مختلف، بدون مفتاح؛ طلب بنفس --idem مرتين بالتوازي ثم مرة كمان؛ استرداد #24 تاني.
- What I expected: مفتاح واحد = عملية واحدة.
- What the system did: إعادة نفس المفتاح 200 بدون زيادة (301). التوازي: واحد 200 وواحد 409 «قيد التنفيذ». مفتاح مختلف = دفعة جديدة (303). مفتاح بجسم مختلف 409. بدون مفتاح 400. الطلب: واحد 201 + 409، والإعادة رجعت نفس الطلب #34 cmwc973kp000fhljoitd31xpm (CARD 28.5 في شيفت كريم). استرداد #24: 409 «no refundable collections» و 409 «Payment is no longer refundable».
- My comment: سليم. اتعمل طلب حقيقي #34 في شيفت كريم (فيزا 28.5، لسه CONFIRMED).

### D1-AM-CTRL-9 — مسارات مخفية بكريم
- What I tried: GET/PATCH handover-config، GET/PATCH handover-policy، freeze release، audit، backup export، users.
- What I expected, as a كاشير: ممنوع.
- What the system did: GET handover-config 200، GET handover-policy 200؛ PATCH الاتنين 403. freeze release 400 (من غير سبب) ثم 403 مع السبب. audit 403، backup 403، users 403.
- My comment: سليم. القراءة للإعدادات مسموحة للكاشير (معلومة بس).

## بيانات اتعملت من الاختبار
- دفعات مورد على INV-D1-001: cmwc8t6qs00ukhl54t7389sx9، cmwc96tu80007hljo8enapeym، cmwc96u5a000bhljo75q4ef2p (1 ج كاش لكل واحدة، المجموع 3 ج، paid 303 / باقي 747).
- مشكلة تسليم OPEN: cmwc91alh01kvhl54y81snlls على cmwc434fn00s0hl542q1y551r.
- طلبين استرداد PENDING على #23: cmwc94ygq0001hljogqsn26qa، cmwc97x3a000qhljoqwqn9aje (لازم المالك يرفضهم).
- طلب #34 cmwc973kp000fhljoitd31xpm فيزا 28.5 في شيفت كريم، CONFIRMED.

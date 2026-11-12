# يوميات وليد — ويتر — اليوم الثاني صباحاً

### D2-AM-S2w — فتح 3 طاولات وتقديم الطلبات
- What I tried: فتحت طاولات 1 و2 و3 بطلبات DINE_IN (collectionMode PENDING، لكل طلب --idem). ضغطت طلب طاولة 2 مرتين بنفس المفتاح بالتوازي. بعدها تابعت GET /api/orders حتى صارت READY وعلّمتها SERVED.
- What I expected, as a ويتر: ممكن الطلب يترفض لأن شيفت الكاشير لسه مفتوحش.
- What the system did:
  - GET /api/shifts/active للويتر: 403 «ليس لديك صلاحية لتنفيذ هذا الإجراء» (مش شايف حالة الشيفت).
  - طاولة 1: 201، طلب #48 id cmwcafay300ddhljocfci1914، الإجمالي 96.9، جلسة cmwcafbjg00dihljogyn77kud.
  - طاولة 2: ضغطتين متوازيتين: 201 + 409 «العملية دي قيد التنفيذ — جرّب بنفس المفتاح بعد لحظات». النتيجة طلب واحد فقط #49 id cmwcafgmb00dthljohod9iofs، الإجمالي 108.3، جلسة cmwcafgo400dyhljo1mhl1xav.
  - طاولة 3: 201، طلب #50 id cmwcafh3u00e9hljoxylol1mt، الإجمالي 193.8، جلسة cmwcafh4a00eehljo2ba5euot.
  - لم يُرفض أي طلب بسبب الشيفت (الطلبات ظهرت saleShiftId=null).
  - الطلبات بقيت CONFIRMED حوالي دقيقتين ثم READY، وبعدها PATCH status SERVED = 200 للثلاثة.
  - شاشة الطاولات (GET /api/tables) بعد التقديم: الطاولات 1 و2 و3 كلها OPEN، displayStatus PENDING_COLLECTION، unservedOrders 0.
  - طاولة 3: OPEN، PENDING_COLLECTION، orderCount 1، total 193.8، paid 0، remaining 193.8. تُركت مفتوحة وغير مدفوعة عمداً.
- My comment: الطلب اتقبل من غير شيفت كاشير مفتوح (saleShiftId=null) — يحتاج مراجعة. الباقي fine.

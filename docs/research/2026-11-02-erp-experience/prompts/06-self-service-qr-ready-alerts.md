# Additional Step 6 — Optional self-service QR ready alerts

Recommended Codex model: GPT-6 Astra. Thinking: High.
Roadmap: inspect QR/settings/status flow → add secure tracking and acknowledgement → foreground sound → consented background push/outbox → verify supported devices and hand off.

Implement the optional NEXT CUP self-service pickup feature described below. The owner explicitly requested BOTH an alert inside the customer's tracking page and background notifications where the device supports them. This is an addition to the five-step update roadmap; preserve their implemented work and handoffs.

This message authorizes isolated local implementation, focused tests, schema/migration preparation and application of this feature's reviewed migration only to a positively verified task-owned disposable database. It does not authorize applying migrations or enabling the feature on the owner's real database, controlling PostgreSQL, changing financial policies, interrupting the real ERP, push/main merge or deployment.

## Current system and boundaries

Original checkout: C:/Dev/cafe-operations-system-3. Recorded live owner ERP3110/database5433 must remain protected. Continue the same isolated feature worktree where appropriate, read AGENTS.md, PLAN.ar.md and the latest step handoffs, and preserve unrelated owner work. Do not repeat the completed ERP integration or change .env.

Read relevant installed Next.js docs. Reuse the current architecture and installed dependencies. There is no currently identified Web Push/service-worker/outbox implementation to reuse; verify that before adding one. If a sender library is necessary, this step narrowly permits adding one maintained Web Push package and required TypeScript types/lockfile changes in the isolated worktree, after verifying its current official API/version and compatibility. Do not install into a dependency directory shared with the running owner app, hand-roll Web Push encryption, or upgrade unrelated packages. Document the exact dependency diff.

Use process-local test credentials. Never commit/log VAPID private keys, guest tokens or full push endpoints. Document environment-variable names only; owner environment configuration remains a separate operational action.

Inspect:
- src/components/customer-menu/customer-menu-page.tsx and types.ts
- src/app/api/qr/[branchId]/orders/route.ts
- src/app/api/orders/[id]/status/route.ts and all other READY transition producers
- src/lib/qr-approval.ts, cafe-settings.ts, idempotency.ts and protected transactions/audits
- Existing settings API/UI and public-menu data projection
- Order, CafeSettings and existing relations in prisma/schema.prisma.

Proposed focused new files, subject to the repository conventions verified above: src/app/pickup/[ticketId]/page.tsx, src/components/customer-menu/pickup-tracker.tsx, src/lib/qr-pickup.ts, src/lib/qr-pickup-push.ts, public/qr-pickup-sw.js, a pickup-scoped manifest/landing page and scripts/qr-pickup-dispatcher.ts. Reuse equivalents if present. Keep the worker scope as narrow as the supported pickup/PWA flow allows, and keep all staff/accounting fetches outside caching.

Verified facts: public QR orders use source=QR_MENU; legal status transitions and staff authorization already exist; Order.readyAt is available; Order has the composite unique [id,cafeId,branchId]. The current QR success screen does not implement secure live tracking. Order numbers and phone numbers are not authentication.

## Product behavior

1. Add an owner-authorized operating setting “الاستلام الذاتي — Help Yourself”, default OFF. Prefer the existing workflow-switch/settings framework rather than a new workflow engine. Public clients see only the needed effective boolean/instructions, not private settings.
2. Eligibility is derived server-side from this setting and source=QR_MENU at order placement. Do not force DINE_IN into TAKEAWAY or alter payment, waiter approval, routing, kitchen, table-session, loyalty or inventory rules.
3. Eligible customers receive a private tracking page with order number, safe status and pickup instructions. Show a direct button “تفعيل تنبيه جاهزية طلبي”. Ordering remains possible without audio/push permission. Do not introduce a mandatory phone number; retain any separately configured existing loyalty requirement.
4. After a genuine committed READY transition, an opted-in open page repeats a short chime, proposed cadence every10 seconds, while that readiness notice is active and unacknowledged. Display a prominent “طلبك جاهز للاستلام” card and “هستلم الطلب” button.
5. Acknowledgement persists server-side and stops that notice on other tabs/devices. It is NOT physical handover, payment or SERVED. Actual delivery remains the existing authorized staff action with all payment/custody/stock guards.
6. Provide an accessible mute control. Muting/closing a notification is not acknowledgement. Unsupported sound or refused permission must leave a useful visual tracking flow.
7. Default changes apply to new eligibility/tickets. Turning the feature OFF stops further alerts/jobs immediately without deleting orders, acknowledgements or audit history. Existing normal QR behavior remains unchanged when disabled.

## Browser capability contract — do not promise impossible ringing

- Audio must be unlocked by a customer gesture. Handle rejected play()/AudioContext activation and show an actionable fallback; do not attempt to bypass autoplay restrictions.
- Foreground repeat sound and OS background notifications are separate capabilities. Browser/OS permission, silent/Focus settings, battery rules and suspension affect delivery/sound. No guarantee of continuous ringing while the screen is locked or the browser is closed.
- Background delivery requires an active service worker, supported Push/Notifications APIs and a secure reachable origin. localhost on the ERP computer is not a phone-reachable test URL. Do not expose the owner server or create a tunnel/deployment without approval.
- On iOS/iPadOS, test the supported Home Screen web-app flow and user-gesture permission requirement. Prove that the installed app can access the SAME customer's order securely; do not assume browser/PWA storage handoff. Supply a safe one-time handoff or an honest supported ordering flow if needed.
- Use service-worker persistent notifications on mobile, not an unsupported Notification constructor. A service worker cannot provide a guaranteed endless audio loop. Do not rely on requireInteraction/renotify as a universal guarantee.
- Proposed background policy: an initial ready notification, up to two reminders at60/120 seconds while unacknowledged, and15-minute job expiry. Keep the unacknowledged tracking state visible afterward. Treat these as documented configurable/safe defaults, not an invisible claim to ring forever.
- Notification body/click opens the protected tracking page. Mark acknowledgement only after the explicit customer action. Distinguish push-provider acceptance, device display where observable, and actual customer acknowledgement.

## Proposed reference schema — new, not an existing/applied migration

Verify current schema names and reusable equivalents first. If no equivalent exists, the following is the bounded reference design. Validate it with the installed Prisma version and prepare a migration; do not modify old migrations or deploy to owner data.

Add to CafeSettings:

```prisma
selfServicePickupEnabled Boolean @default(false)
```

Add the reverse relation to Order:

```prisma
pickupTicket QrPickupTicket?
```

New reference definitions:

```prisma
enum QrPickupPushJobStatus {
  PENDING
  CLAIMED
  SENT
  CANCELLED
  EXPIRED
  FAILED
}

model QrPickupTicket {
  id             String   @id @default(cuid())
  orderId        String   @unique
  cafeId         String
  branchId       String
  guestTokenHash String   @db.VarChar(64)
  createdAt      DateTime @default(now())
  expiresAt      DateTime
  revokedAt      DateTime?
  order          Order    @relation(fields: [orderId, cafeId, branchId], references: [id, cafeId, branchId], onDelete: Restrict)
  notices        QrPickupNotice[]
  subscriptions  QrPickupPushSubscription[]
  @@unique([id, cafeId, branchId])
  @@index([guestTokenHash, expiresAt])
  @@index([cafeId, branchId])
}

model QrPickupNotice {
  id             String   @id @default(cuid())
  ticketId       String
  cafeId         String
  branchId       String
  readyAt        DateTime
  acknowledgedAt DateTime?
  createdAt      DateTime @default(now())
  ticket         QrPickupTicket @relation(fields: [ticketId, cafeId, branchId], references: [id, cafeId, branchId], onDelete: Restrict)
  jobs           QrPickupPushJob[]
  @@unique([ticketId, readyAt])
  @@unique([id, ticketId, cafeId, branchId])
  @@index([ticketId, acknowledgedAt])
}

model QrPickupPushSubscription {
  id           String   @id @default(cuid())
  ticketId     String
  cafeId       String
  branchId     String
  endpoint     String   @db.Text
  endpointHash String   @db.VarChar(64)
  p256dh       String
  auth         String
  expiresAt    DateTime?
  revokedAt    DateTime?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  ticket       QrPickupTicket @relation(fields: [ticketId, cafeId, branchId], references: [id, cafeId, branchId], onDelete: Restrict)
  jobs         QrPickupPushJob[]
  @@unique([ticketId, endpointHash])
  @@unique([id, ticketId, cafeId, branchId])
  @@index([ticketId, revokedAt])
}

model QrPickupPushJob {
  id             String   @id @default(cuid())
  noticeId       String
  subscriptionId String
  ticketId       String
  cafeId         String
  branchId       String
  reminderIndex  Int      @default(0)
  status         QrPickupPushJobStatus @default(PENDING)
  dueAt          DateTime
  expiresAt      DateTime
  claimedAt      DateTime?
  lockedUntil    DateTime?
  sentAt         DateTime?
  attempts       Int      @default(0)
  lastErrorCode  String?
  createdAt      DateTime @default(now())
  notice         QrPickupNotice @relation(fields: [noticeId, ticketId, cafeId, branchId], references: [id, ticketId, cafeId, branchId], onDelete: Restrict)
  subscription   QrPickupPushSubscription @relation(fields: [subscriptionId, ticketId, cafeId, branchId], references: [id, ticketId, cafeId, branchId], onDelete: Restrict)
  @@unique([noticeId, subscriptionId, reminderIndex])
  @@index([status, dueAt])
  @@index([lockedUntil])
}
```

Ticket existence records eligibility for that order. readyAt identifies a readiness generation; if the application has a stronger existing generation/version mechanism, reuse it rather than creating competing meanings. A stale acknowledgement must not suppress a newer notice. Do not introduce a new legal order transition merely to test re-readiness.

## Guest security and APIs

Use a cryptographically random, at least256-bit browser guest capability issued via an HttpOnly/Secure/SameSite cookie before eligible submission, and persist only its hash. Bind ticket creation atomically to the actual QR order and that guest. A shared guest hash may authorize that customer's own multiple tickets; it must never authorize another guest's order.

Preserve withIdempotency and QR throttling. Replayed order creation must retain correct ticket access without leaking guest secrets through cached response bodies, URLs, logs or audits. Do not use phone number, sequential order number or an ordinary orderId as proof of ownership.

Proposed protected public-customer endpoints, following repository conventions:
- POST /api/qr/[branchId]/guest-session — establish the guest capability with origin/rate guards.
- GET /api/qr/pickup/[ticketId] — minimal owned-order tracking, no private customer/staff/payment data.
- POST /api/qr/pickup/[ticketId]/acknowledge — Zod notice identity, stale-generation/state checks, exactly-once persisted acknowledgement and replay receipt.
- POST/DELETE /api/qr/pickup/[ticketId]/push-subscription — bounded validated subscription and revocation.

Scope every endpoint to the guest, ticket, order, cafe and branch; return non-enumerating refusals. Require same-origin/CSRF protection for cookie-authenticated mutations, expiry/revocation checks and suitable per-guest throttles without penalizing a whole café Wi-Fi unnecessarily. Responses must not be publicly cached.

Validate HTTPS push endpoints against reviewed trusted provider hosts, with no private/internal destinations or redirects; prevent SSRF through forged subscription data. Store endpoints/keys as secrets with bounded retention. Keep notification text minimal; never expose phone numbers, private notes or financial details on a lock screen.

## Transaction, worker and UI integration

Create notice/outbox rows only as part of a successful READY transaction and required audit. Unique keys must prevent duplicate events/jobs after staff retries. Do not send network push inside the order transaction. Handle subscription after READY by creating only the missing appropriate job.

Run a bounded task-owned dispatcher with atomic claims/leases, retry backoff, expiry, provider-error handling and revoked/404/410 endpoint cleanup. Recheck owner setting, order state, acknowledgement and expiry immediately before sending. Cancel pending reminders after acknowledgement/terminal state. An already in-flight push can arrive late; opening it must fetch current state and must not restart an acknowledged alert.

Use existing realtime infrastructure if suitable; otherwise bounded authenticated polling with visibility-aware backoff is sufficient for foreground tracking. Coordinate tabs to avoid multiple simultaneous chimes. Multiple orders must remain independently acknowledgeable. Clear timers/listeners and audio on unmount, acknowledgement, terminal state or feature disable.

A minimal service worker may handle push/click and required public assets. Do not cache authenticated ERP pages, finance endpoints, customer tracking responses or mutable order/payment APIs. Do not introduce an offline order/payment path.

Use the shared Arabic/RTL/green UI. Staff kitchen/pickup views show ready, customer acknowledged and actual served distinctly, with a pending-ack list. Customer acknowledgement must not award loyalty, collect money, decrement stock, close a table or mark SERVED.

## Acceptance and honest completion

Use only synthetic disposable fixtures. Test feature OFF compatibility; QR-only eligibility; preserved approval/payment/serving behavior; guest isolation, guessing, expiry, CSRF, SSRF, revoked subscriptions and absence of secrets in logs; READY transaction rollback and duplicate delivery jobs; duplicate/stale acknowledgement; pending/in-flight reminder races; cancelled/served state; multiple tabs/orders; refresh/reconnect; denied permission/autoplay and unsupported push.

Perform genuine foreground browser checks with a user gesture. Test Android Chrome and an iOS Home Screen app, including background/locked screen, only on available consenting test devices and a secure phone-reachable test origin. Mocks do not prove real background delivery or hardware behavior. Record the exact browser/device and whether the notification was accepted, observed, audible and acknowledged. If these checks cannot run, report background/device verification as incomplete.

This new schema/status/security feature requires a fresh affected regression set and final build for the Step6 source; the pre-Step6 Step5 build is not automatically current. Preserve prior proofs and bind new genuine source/build/migration receipts. Do not rerun unrelated investigations without cause.

Finish STEP-6-HANDOFF.md and a concrete activation packet: tested migration/checksums, dependency diff, required environment-variable names, dispatcher command, actual preview URL, capability/device matrix, privacy/retention defaults and owner maintenance/backup/switch actions. Do not enable this on real cafés or deploy its migration until that exact operational approval exists.

Final status: COMPLETE / PARTIALLY COMPLETE / BLOCKED / NEEDS OWNER DECISION. Report foreground, background, physical-device and owner-activation statuses separately.

Primary platform references, verified during prompt preparation:
- [MDN autoplay and user activation](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)
- [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
- [MDN Notifications API](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API)
- [WebKit: Web Push for iOS/iPadOS Home Screen apps](https://webkit.org/blog/13966/web-push-for-web-apps-on-ios-and-ipados/)

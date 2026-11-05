# Planned addition 8 — Shared LAN operation and automatic cloud synchronization

Recommended Codex model: **GPT-6 Astra**. Thinking: **High**.
Roadmap: branch authority and local-QR design → shared venue runtime and durable transactions → ordered cloud reconciliation → real multi-device outage/restart/recovery acceptance.

## Confirmed owner choice — 2026-11-03

The owner explicitly chose: **cashier, kitchen and QR ordering must keep working together through the venue's local network when Internet fails**, with local saving and automatic synchronization after Internet returns. This supersedes the earlier proposed independent-browser-only architecture. Do not ask the same topology question again or implement isolated browser queues as if they satisfied it.

This addition is separate from owner-device backup addition 7. Its browser-open-only choice applies to backup scheduling, not to the shared venue runtime. Core Step1/1B is implemented; Steps2–5 and additions6/7 keep their numbering. No application implementation, local service setup or deployment occurs merely by saving this prompt.

**Invoke 8A first.** This is a larger architecture change, not a service-worker checkbox. An explicit 8A invocation authorizes bounded design/protocol work and pure simulations in the worktree/branch identified by that invocation or its approved current handoff. Verify the actual HEAD, source and ownership; without an identified target, finish read-only preparation before requesting it. Further slices use the reviewed 8A handoff and their actual authorized environment; recording all slices here does not execute them automatically.

Read AGENTS.md, the latest Step1/1B/2 handoffs, PLAN.ar.md section13, current Prisma schema, protected transactions, order creation/status/collection, stock freezes, shift/custody/approval rules, reporting and output definitions. Read installed Next.js guides, including progressive-web-apps.md, before selecting a client/worker integration. In the inspected source there are server IdempotencyKey reservations and sessionStorage retry keys, but no implemented shared offline branch runtime.

Preserve owner source/data, .env, existing SQL and fixtures. No owner database operations, PostgreSQL control, provisioning, installation, seeds/resets, push, merge, deployment, external messages or live financial-policy changes are authorized by this planning prompt. Local runtime and networking setup must be concrete and separately scoped before execution; never commandeer an existing database/listener or weaken safety pins. Reuse any already documented applicable authorization rather than repeatedly requesting it.

## 1. Chosen topology and proposed authority design

**Confirmed topology:** an on-site coordinator on an owner-designated always-available venue computer/device, serving cashier, kitchen and customer QR clients over the functioning LAN. Its local transactional datastore persists accepted work through a client/browser restart. Cloud hosting remains the central cross-branch service and reporting destination.

**Engineering proposal, not yet an owner-approved financial-policy change:** for an enabled branch, route its operational writes through one enrolled branch coordinator in both connected and disconnected modes. Synchronize its committed facts to the cloud with durable identity and provenance. This avoids an uncontrolled failover in which the cloud and local coordinator both accept independent writes to the same branch's cash drawer, orders or stock. Validate this authority model in 8A before activation; if current business workflows cannot support it, present the precise alternative and tradeoff rather than silently choosing dual writers.

The local coordinator must run the same reviewed domain behavior and protected transactions, not a simplified second POS or ledger. A PostgreSQL-specific Prisma/schema/locking implementation cannot silently become an unrelated local storage engine; identify a supported packaging/datastore approach and prove Decimal, transaction, locking and durability equivalence. Select venue hardware/OS/runtime, capacity, startup/restart and data-directory requirements in the 8A handoff. Do not assume this developer machine, owner database5433 or disposable5434 is the customer's production coordinator.

Define branch/device enrollment, branch authority epoch, allowed writer, revocation and safe replacement. Enforce the authority boundary on every branch write path, including cloud POS, QR, admin changes, payments, table operations and background jobs. Remote/cloud orders for an edge-enabled branch must reach the active coordinator, or remain explicitly unaccepted/pending. A successful cloud payment or order acknowledgement cannot be invented while the venue has not durably accepted the corresponding operation.

During a partition, the cloud must not automatically appoint a second branch writer. Replacement/failover needs a proven fencing and pending-data recovery protocol; an old coordinator cannot reconnect as a second live writer. Stale epoch operations retain reviewable evidence but do not silently mutate current state. Do not promise automatic cloud failover and concurrent strict local authority without a demonstrated coordination protocol.

The LAN and coordinator need power and local connectivity. Internet loss is distinct from router/LAN failure, coordinator failure, device failure and cloud outage. Show distinct states and support limits. A standalone browser queue may retain an unsubmitted intent during a brief client-to-hub loss, but it must not show kitchen delivery, table reservation, payment confirmation or a shared order as accepted until the coordinator has durably committed it.

## 2. Local QR, guest access and browser origins

A new customer's phone must be able to open the local menu and submit a QR order over venue Wi-Fi during a WAN outage; success cannot depend on that phone previously caching the cloud app. Define and demonstrate the QR link/discovery path, stable local origin, routing/DNS strategy, trusted TLS/certificate provisioning/renewal, guest Wi-Fi routing and any browser local-network permissions.

Do not assume the current Railway public URL automatically reaches a private LAN server, that mobile data reaches the venue LAN, or that localhost on a customer's phone names the cashier computer. Identify when a venue-local QR or onboarding link is required and the user-facing switching flow. If one printed QR is required for connected and disconnected modes, prove its local/public resolution design and certification on the supported devices before claiming it.

Prefer a directly served, trusted local web origin for venue clients. Do not rely on bypassing certificate warnings, browser security flags, permissive global CORS, or disabling Wi-Fi isolation across the entire network. Expose only reviewed application endpoints to guest devices; never the local database port, owner admin interface or sync credentials. Tenant/branch/table identity and short-lived tracking capability remain server-validated; a table number in a URL is not authorization.

Secure-context/service-worker, local-network and origin/storage behavior must be tested on real target browsers. A page's public-to-private network access and WebSocket permissions may differ from direct local navigation; do not assume universal compatibility. Read primary guidance: [MDN secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts), [MDN local network access](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Local_network_access).

QR orders still follow current waiter/approval/preparation rules. Kitchen updates, readiness and customer acknowledgement use the local coordinator while LAN-connected. Addition6 sound may work in the open local tracking page after required interaction; Internet-dependent push, SMS, email and provider payment are not promised during WAN loss. Reconnection must not send an old ready event as a fresh repeated notification. Preserve the distinction between customer acknowledgement, actual service, payment and stock consumption.

## 3. Shared operational scope and UI

Add **Settings → العمل عبر شبكة المكان والمزامنة**, with owner-authorized enrollment/activation, coordinator identity and health, connected devices, LAN/cloud status, local storage health, last committed local sequence, last cloud-acknowledged sequence, pending/conflict count, update state, recovery and safe disabling.

Use the shared app shell and Step1B identity. Staff see **متصل بالمكان / يعمل محليًا — الإنترنت مقطوع / مزامنة السحابة / تعذر الاتصال بجهاز المكان / يحتاج مراجعة**. A working LAN may have no Internet. Expose a useful retry/sync center without an ordinary delete-pending-work button. Do not mislabel “accepted by the local coordinator” as “confirmed in the cloud”.

Publish a capability matrix before activation:

| Area | Required venue continuity | Explicit boundaries |
|---|---|---|
| Cashier, menu, orders | Shared prepared catalog, order creation, allowed cash collection, local receipt and protected order lifecycle | One domain transaction/command identity; cash received is not automatic SERVED |
| Kitchen | Receive coordinator-accepted tickets, update preparation/ready state, reconnect/recover history | No duplicate ticket or state loss after restart |
| QR and tables | Guest local menu/order/tracking, staff approvals, shared table sessions and visible occupancy | Phone must reach the venue LAN/local origin; preserve guest/table scope |
| Shifts, cash and stock | Current local authoritative custody, stock policy/freezes and permission gates | No relaxed stock enforcement, false shift opening/closure or fabricated approval |
| Sales/SKU/shift/table reports | Coordinator-local accepted data with clear coverage and pending-cloud marker | Cross-branch consolidated cloud reports may lag; do not add local rows twice after sync |
| Expenses/purchases/recipes/counts | Explicit reviewed support matrix and safe drafts/views, then scoped local commands | Do not call all ERP modules offline-ready before their authoritative domain paths are proven |
| Treasury/accounting/remote owner approvals | Preserve current protected behavior and clearly state which authority is available locally | Accountant/D7/D8 and live-posting gates remain; no second ledger |
| Card/wallet, cloud integrations and background push | Show genuine provider capability and pending/unavailable state | No invented offline charge approval or retry that charges twice |

All clients share state through the coordinator rather than inferring it from independently cached copies. Concurrent cashiers must see shared accepted table/order/stock state. Keep permission changes, catalog/policy updates and remote approvals versioned and ordered; do not overwrite local active work with a newer cloud catalog mid-transaction.

## 4. Durability, authorization and identity

Persist the complete local business write, audit, replayable command result and cloud-bound outbox event atomically in the coordinator's transactional datastore. Return accepted only after that durable commit. A network send, client toast, printed ticket or IndexedDB insertion alone is not a shared local commit. Test power/process failure at the acknowledged-commit boundary; document remaining hardware/filesystem limits.

Client commands have immutable UUIDs, payload hashes, actor/device/cafe/branch/authority-epoch context, causal dependencies and protocol versions. Online and offline paths reuse the same logical identity, including “coordinator committed, response lost, client retries after reconnect”. Two intentional identical baskets have different logical command IDs. Deduplicate concurrent clients/tabs and retry exactly the same command; do not key business identity only by basket hash.

Local staff authentication must remain available through Internet loss and coordinator/client restart using a reviewed, bounded offline-capability policy. No plaintext staff passwords, exported cloud password hashes, server signing secrets or reusable cloud bearer tokens in browsers. Define enrollment, local unlock/authentication, expiration, current role/custody checks, audit, local key ownership and emergency lockout. A cashier cannot become owner or approve their own refund because cloud approval is unreachable.

Immediate remote revocation cannot be learned across a disconnected network. Bound offline authority and define the unavailable-approval path; reconnect validates current cloud/device authority without erasing already committed local cash evidence. Distinguish expiry of permission to accept new commands from synchronization of older durable facts. Neither user-supplied times nor a device clock rollback extends authority. No fake historical backdating or reassignment of offline cash to a different actor/shift.

Preserve exact financial snapshots, Decimal/minor-unit arithmetic, units, discounts/tax/service, revision/return semantics and actual service-time stock deduction. The local coordinator needs a coherent authoritative copy of current custody, stock, freezes and pricing; “last browser snapshot” is insufficient for shared strict operations. Persist occurred-at-local, coordinator sequence/commit time and cloud-received time separately. No new fiscal receipt/numbering guarantee without reviewing the applicable existing invoice contract.

Keep a stable branch-wide local order number plus a globally unique order identity and documented cloud mapping. If statutory/final invoice numbers require another allocation rule, resolve that before activation. Never renumber a customer's existing receipt invisibly or use a new operation ID during recovery.

## 5. Cloud synchronization and split-brain prevention

Use an ordered durable outbox on the coordinator and authenticated, cafe/branch-scoped cloud ingestion. Define bounded batches, contiguous committed sequence, authority epoch, event UUID, schema/protocol version, canonical payload hash, dependencies and approved replayable receipt. Sign/authenticate transport with rotatable coordinator identity kept out of browsers. Establish server-side scope from enrollment, not a user-supplied cafeId.

Cloud synchronization acknowledges an event only after its permitted effects and immutable ingestion receipt commit atomically. A lost acknowledgement causes replay of the same event/hash and returns the old receipt; a changed hash or sequence collision is a conflict. Never acknowledge a high sequence across missing predecessors. Apply independent branches separately, while preserving causal order within a branch epoch.

Define the actual replication mapping in 8A: authoritative local entity IDs and snapshots, central references/projections, current business invariants, finance/inventory audit preservation and conflict handling. It must neither blindly upsert arbitrary client database rows nor call ordinary “create order/collect payment/serve” APIs again as if the sale were new. Do not re-execute an external charge, stock deduction, loyalty redemption or accounting posting to synchronize an already committed effect. Where a central policy cannot accept an authoritative fact, quarantine it with its original evidence and expose review rather than deleting it or falsely marking synced.

Use existing Order, Payment, Shift, stock, accounting and audit structures as canonical business models; the sync outbox/receipts are transport provenance, not a parallel ledger. Review cross-branch references, local-vs-central IDs and conflict outcomes explicitly. No silent financial-policy change is authorized to make replication convenient.

Cloud-to-coordinator changes need their own reviewed order/version/checkpoint contract. Remote order submissions, catalog changes, permission updates and remote approvals cannot mutate a second independent copy of active branch stock/cash. Reject stale writes or queue explicit commands for the coordinator; no last-write-wins for money, stock, table occupancy or custody.

Reconcile on actual API recovery, authenticated startup/resume and bounded retries with backoff/jitter. Internet and cloud failures must not stop LAN operations. Retain data through long outages, cloud deployment and protocol upgrade; support negotiated versions or a recoverable paused sync rather than deleting pending work. Keep immutable dedupe evidence for the supported replay/recovery window. Exactly-once transport is not promised; durable identities and transactional deduplication prevent repeated business effects.

## 6. Proposed reference schema — not an applied migration

8A must inspect current schema/IDs and finalize the exact schema before any implementation slice applies it. Starting reference names and constraints are below. No new JournalEntry/Payment/Order replacement is proposed. Any migration needs its explicitly permitted disposable environment; planning does not authorize owner migrations.

| Proposed model/enum | Exact starting fields | Relations and required constraints |
|---|---|---|
| BranchEdgeNode | id UUID PK; cafeId String; branchId String; enrolledById String; label String(100); state EdgeNodeState; publicKeyId String; enrolledAt DateTime; revokedAt DateTime? | Cafe, Branch, User with restrict deletion of retained provenance; unique(cafeId,branchId,id); index(cafeId,branchId,state). Private key remains outside this table/client |
| BranchEdgeAuthority | id UUID PK; cafeId String; branchId String; nodeId UUID; epoch BigInt; grantedAt DateTime; revokedAt DateTime?; cloudAckSequence BigInt default0 | Composite node relation(cafeId,branchId,nodeId); unique(cafeId,branchId,epoch); unique(cafeId,branchId,nodeId,epoch); index(cafeId,branchId,revokedAt). A reviewed PostgreSQL partial unique active-authority constraint per branch is also required, not approximated by nullable uniqueness |
| EdgeIngestReceipt | id UUID PK; cafeId String; branchId String; nodeId UUID; epoch BigInt; sequence BigInt; eventId UUID; payloadHash String(64); protocolVersion Int; committedAtLocal DateTime; receivedAtCloud DateTime; result Json | Composite authority relation(cafeId,branchId,nodeId,epoch); unique(cafeId,branchId,nodeId,epoch,sequence); unique(cafeId,eventId); index(cafeId,branchId,receivedAtCloud). Persist atomically with accepted central effects |
| EdgeNodeState | ACTIVE, REVOKED | Admission state only; never an Order/Payment financial status |
| LocalEdgeOutbox — coordinator-only persistence | eventId UUID PK; branch/epoch/sequence; command identity; protocolVersion; payloadHash; immutable payload; createdAt; state; retryAfter; acknowledgedAt; cloud receipt | Transactionally linked to the actual local domain write; unique(branch,epoch,sequence), unique(command identity and effect kind); pending/review entries cannot be pruned. Final Prisma-vs-local table placement follows the reviewed packaging model |

These are **proposed reference definitions**, not a validated Prisma migration. 8A must supply compilable Prisma relations/back-relations, exact SQL constraints, auth scopes, strict Zod schemas and route/event contracts after validating the packaging and authority model. Do not apply an unverified schema or create a second business datastore merely from this table.

Proposed route families: local authenticated /api/edge/commands and /api/edge/health; local public /api/qr/... with existing scoped tracking semantics; cloud owner-only node/authority administration; node-authenticated /api/edge/sync/push, /pull and /receipts. Inspect existing routes and reuse conventions; these are not currently implemented endpoints. Validate bounded batches, decimal strings, UUID/sequence/epoch, hash, protocol version and operation allowlist; input may not supply arbitrary SQL/model mutations.

## 7. Backup, recovery, updates and administration

Addition7 cloud backup coverage and coordinator-local backup coverage are different. A venue-local transaction not yet acknowledged by the cloud is absent from a cloud-only backup. Show central/local sequence watermarks, cloud acknowledgement, pending/review counts and actual snapshot coverage. Owner-device backup must identify its source and include any explicitly selected local data/outbox consistently.

Provide reviewed encrypted coordinator backup and restore/recovery procedures that do not depend on Railway being online. Preserve command/event IDs, branch epoch, provenance and acknowledgement state. A restored clone starts quarantined: no second active coordinator, automatic reenrollment or replay using fresh IDs. Reconcile cloud receipts and safely fence a lost/replaced node before activating a recovery target.

Cover coordinator process restart, machine restart, interrupted writes, corrupt/partial archive, wrong key, low disk and LAN/WAN recovery. Do not claim backups from a file download without restore evidence. Browser persistence remains useful for prepared assets/unsubmitted drafts, not the sole authoritative venue database.

Updates must preserve active orders, compatible clients, local keys, pending outbox and old protocol support. No cache cleanup, factory reset or logout that destroys accepted/unsynchronized work. Expose nontechnical owner health/recovery instructions, supported capacity/hardware and safe rollback. Keep DB ports, platform credentials and infrastructure controls outside product guest flows.

## 8. Delivery slices and real acceptance

**8A — Architecture/protocol proof first:** current-route/permission/custody inventory, venue hardware/runtime proposal, LAN QR origin/TLS/guest-network design, branch write-authority and failure matrix, exact schema/routes/Zod/event/transaction contracts, report/backup watermarks, upgrade/recovery protocol and pure fault simulations. This slice does not claim live offline readiness or authorize installing services. Obtain review of the concrete design before code/setup slices that change operational authority or financial behavior.

**8B — Shared venue runtime:** explicitly authorized isolated coordinator environment, local staff/guest auth, cashier+KDS+QR/table flows, protected domain transactions, durable results and receipt/ticket recovery. Existing policy and UI identity remain.

**8C — Cloud sync and wider modules:** scoped ordered ingestion/pull, dedupe/fencing, reports and backup reconciliation, then the explicitly supported additional ERP module commands. No automatic owner migrations/deployment.

**8D — Integrated acceptance and recovery:** physical multi-device WAN isolation, coordinator/client restarts, network and cloud partitions, safe restoration, owner usability acceptance and separately authorized production activation.

Required evidence on verified synthetic environments:

1. One coordinator, cashier client, kitchen client and a real phone on venue Wi-Fi. Disconnect the actual WAN while LAN stays up; on a phone that never cached the app open the local QR, order, receive/approve it at the venue, prepare/mark ready, view customer tracking and acknowledge pickup. Record cash separately and actual service through current rules. Show shared table/order state on another client.
2. At least10 distinct orders, including two identical baskets, concurrent cashiers and repeated submissions. A local acknowledged order survives a coordinator restart; a client retry after a lost response creates one order, expected payments, exact service-time stock effects and one kitchen ticket.
3. Restore Internet/cloud; reconcile exact order/payment/stock/report counts and local/cloud watermarks. Repeat synchronization and replay old receipts/bundles: zero duplicate collection, stock deduction, loyalty redemption, posting or customer notification.
4. Crash before/after local transaction, after central commit/before acknowledgement, and during checkpoint update. Test gaps/reordered batches/hash mismatch, expired/revoked authority, old node reconnect, cloned restore, coordinator replacement and simultaneous cloud/edge submissions. No split-brain writer and no high acknowledgement over an unapplied predecessor.
5. Test cashier/guest/manager authorization, wrong cafe/branch, reused QR tracking capability, guest Wi-Fi isolation, TLS/certificate expiry/renewal, Android/iOS/browser permissions and phone on mobile data rather than venue Wi-Fi. State unsupported paths honestly; no security-warning bypass.
6. Test shift/custody changes, stock freeze/strict enforcement, price/revision changes, permission expiry/revocation, partial cash collection/refunds where supported, prepared/unserved vs served orders, midnight/Cairo reporting and remote owner approval unavailable. Preserve original evidence and current finance policy.
7. Test low/full disk, interrupted local write, LAN loss, WAN-only loss, cloud-only outage, power/process restart, long outage, app/protocol update with pending work and independent encrypted restore. Router/coordinator failure must not be disguised as normal working Internet-offline mode.
8. Demonstrate screen/CSV/Excel/print, reports by SKU/shift/table and cloud cross-branch views at known checkpoints; distinguish pending local coverage and avoid duplicate aggregate results. Hardware receipt printing and background notifications need their own real-device evidence.

Run meaningful pure/targeted runtime, security/concurrency, build and production-mode browser checks appropriate to each slice. Do not provision a missing target or use owner data as fallback. Final handoff includes exact supported device/network/module matrix, source changes, reviewed schema/protocol, setup/health/recovery instructions, tests and failed/unverified paths, preview topology and rollback preserving pending work. Final status must distinguish planned architecture, implemented shared LAN behavior, verified synchronization/recovery and production authorization.

Primary references: [MDN secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts), [MDN local network access](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Local_network_access), [MDN Service Workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API), [MDN storage durability](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria). Use installed framework guidance and actual domain code as primary implementation context.

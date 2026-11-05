# Optional addition 7 — Owner-device backups from ERP Settings

Recommended Codex model: **GPT-6 Astra**. Thinking: **High**.
Roadmap: tenant-data inventory and versioned archive → encrypted manual backup and local verification → daily/weekly scheduling while ERP is open → independent offline inspection and isolated restore drill → evidence and handoff.

## Confirmed product request

Add **Settings → النسخ الاحتياطي واستعادة البيانات** for each authorized cafe/restaurant owner. Provide **نسخ احتياطي الآن** and an optional schedule **متوقف / يوميًا / أسبوعيًا**, saving on that owner's computer.

The owner explicitly confirmed on2026-11-03: automatic backup only needs to run while ERP is open on the computer. No native helper, OS service, mobile background guarantee or closed-browser scheduling is requested. The WhatsApp comparison concerns simple settings; do not integrate WhatsApp or its cloud storage.

Step1/1B implementation is already done. The original Steps2–5 and optional QR addition6 retain their numbering. This is a separate planned addition, normally after the five core steps; executing it does not mean those steps or production readiness are complete.

The owner subsequently requested offline operation and synchronization as separate addition 8; see [its prompt](08-offline-working-and-sync.md). A cloud archive cannot claim to cover unsynchronized device commands. When that feature exists, expose separate central/local coverage markers and an explicitly verified encrypted pending-work recovery component. A recovered pending bundle is quarantined for authorized reconciliation using original command identities, never blindly replayed or cloned into another active device. Do not expand this backup implementation into offline sales merely from this cross-reference.

This document is an implementation prompt for later explicit invocation. Recording it in the roadmap is not permission to run it now.

## Execution scope when invoked

Use only the NEXT CUP implementation worktree path and branch explicitly identified in the invoking instruction or its approved current handoff. If neither identifies an approved target, finish read-only planning and request that missing target before editing; branch inspection alone does not authorize selecting another checkout. Within that target, reuse existing architecture, installed dependencies, permissions and UI identity. Verify the actual branch/HEAD/current work and read the latest handoff; do not assume the previous recorded deployment state is current. Read `AGENTS.md`, section12 of `C:/Dev/cafe-operations-system-3/docs/research/2026-11-02-erp-experience/PLAN.ar.md`, the current schema and relevant installed Next.js guides first.

Local implementation, focused tests and reviewed local commits are authorized by explicit invocation of this prompt. No push, merge, deployment, owner-database operation, PostgreSQL control, provisioning, global seed/reset or .env change is authorized. Testing and restore writes require positively verified dedicated disposable targets with real server/database correspondence. Preserve existing fixture receipts and historical guard code/pins. If an isolated restore target is unavailable, finish independent code/pure checks, prepare its exact setup request and report the restore drill unverified.

## 1. Settings and honest status

Extend the existing `src/app/(app)/settings/page.tsx` using an owner-only shared-style settings card. Suggested component: `src/components/settings/backup-card.tsx`. Add a session-level coordinator in the existing authenticated shell so scheduling continues on other ERP pages, not only while Settings is visible. Respect existing feature gates and user/tenant changes.

The card includes:

- **نسخ احتياطي الآن**, **اختيار/تغيير مجلد الحفظ**, and **فحص نسخة محفوظة**.
- Automatic frequency OFF by default; daily or weekly, time, IANA time zone, and weekday for weekly schedules. Display **يعمل أثناء فتح ERP على هذا الكمبيوتر مع توفر الاتصال** beside the control.
- Device-specific destination/capability/permission state, schedule, next due slot, last archive generated, **last file saved and verified on this device**, and the archive's actual data coverage time. Never conflate these timestamps.
- States: idle, preparing, receiving, encrypting, saving, verifying, saved, overdue, failed, needs permission, needs recovery-key unlock, unsupported and offline. Keep percentages indeterminate if total work/bytes are unknown.
- Retain multiple dated archives. Never overwrite the only good backup. Any retention pruning needs explicit owner opt-in, affects only manifest-owned files in the selected directory, follows successful new-file verification, and cannot remove the last known good copy or unrelated files.
- A clear recovery-key setup and reminder. The key must work without the live service. The reference flow keeps the unlocked encryption material in session memory; after reload/logout or loss of that material, show the locked state and require owner unlock. Never silently report scheduled backups as active while the required key is unavailable.

Do not upload the owner's filesystem path, directory handle or recovery secret to Railway. Local preferences/history are namespaced by cafeId, ownerId and this browser/device. Do not show one owner's folder/history after another owner logs in. Logging out stops in-flight coordination safely and releases in-memory secrets; it must not delete existing backup files.

## 2. Saving on a supported computer

Feature-detect and test File System Access on desktop Chrome/Edge over a secure context. The owner selects a directory through an explicit user action. Persist a supported directory handle in device-local IndexedDB; check actual permission before every scheduled write. Renew permissions only through an appropriate owner click. A timer cannot summon a directory picker or bypass a denied prompt.

On unsupported browsers, retain a clearly labeled manual download fallback. Disable automatic folder saving with an explanation. A requested browser download is not proof that a file reached durable owner storage; distinguish download-started from a save that the application can actually verify.

Write a uniquely named new archive, finish/close the write, reopen and verify the saved bytes/manifest before recording local success or pruning. Handle cancellation, revoked permissions, full disk and truncated files. Leave previous verified archives intact. Temporary/incomplete files must never appear as valid completed backups.

Primary references: [MDN directory picker](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker), [Chrome File System Access](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access).

## 3. One tenant-consistent, portable archive

Inspect the actual current Prisma relations and define an explicit export inventory before coding. Include the cafe's branches, catalog/products/variants/add-ons, recipes, stock and movements, counts/handovers, suppliers/purchases, orders/invoices/items/revisions, collections/refunds, customers/loyalty, shifts, treasury, expenses, accounting/journals where present, settings and necessary business history. Include relevant owned attachments or explicitly identify unavailable/missing items. A link to an online attachment is not an independent copy of its contents.

Use only authorized cafe-owned rows and required safe reference data. Do not expose a shared database dump. Exporting a complete cafe requires cafe-wide owner authority: deny a branch-restricted/lower-role request rather than presenting a partial export as a complete backup. Resolve cafeId from the authorized session, not a client-supplied tenant ID. Maintain tenant scoping through every relation, including attachment reads and historical actors.

Exclude passwords/password hashes, session cookies, API tokens, customer tracking/bearer secrets, provider/Railway credentials and other authentication secrets. Preserve necessary historical actor references through safe non-login metadata; document the separate controlled authentication bootstrap needed for a recovered installation. Do not change users' current credentials to make an archive restorable.

Generate the relational dataset under a bounded, consistent PostgreSQL read snapshot, using appropriate read-only/repeatable-read semantics. Avoid independent page queries taken at different financial moments. Never mix another tenant into the archive. Keep Decimal and bigint values exact as strings and timestamps explicit; never round-trip financial values through binary floating point. For attachments outside PostgreSQL, pin immutable object versions or verify the staged bytes against the manifest; changed/unavailable bytes cannot silently become a complete backup.

The versioned manifest records archive/format/schema/application versions, cafe identity, coverage/snapshot time, module/table inventory and row counts, relationships, attachment inventory/checksums, omissions and payload integrity checks. Define supported size/time limits and test representative larger datasets; fail visibly at limits instead of silently dropping older records or attachments. Bound memory, snapshot duration and transfer resources.

Inspect current route/auth/client patterns. Proposed endpoint: `GET /api/backups/archive`, using dedicated binary/stream handling rather than the small JSON-report reader's default deadline. Authenticate and authorize server-side, rate-limit exports and use appropriate private/no-store responses. No public reusable download URL or URL-embedded access secret. Cancellation of this read must not alter business records or money-command recovery. Safe export audit metadata may use the existing audit mechanism, separately from the read-only data snapshot; a server export event is not proof of local saving.

Proposed Prisma models, enums, relations and indexes: **NONE for the confirmed browser-open design**. Device schedule, directory handles, unlock state and local save history stay device-local. Reuse current cafe, user, business and audit structures. This is a proposed reference architecture, not an already verified migration. If a material schema change becomes necessary, present the precise reason/schema separately before applying it; do not manufacture a second ledger or silently expand this scope.

## 4. Encryption and key ownership

Store an encrypted portable archive using a reviewed authenticated-encryption construction and maintained platform/library primitives. Document key generation/derivation, authenticated metadata, randomness/nonces, format versioning and tamper/truncation rejection. Use Web Crypto/established implementations appropriately; do not invent a cipher or unreviewed streaming-crypto protocol. Inspect available dependencies before proposing an addition.

The owner controls a recovery key/secret and is shown how to keep it separately from the archives. It must not depend on a Railway secret that becomes unavailable during an outage. Do not persist a plaintext recovery secret in localStorage, logs, source, URLs or the service database. Do not promise key recovery that has not been designed and verified. Wrong/lost keys and damaged archives fail safely without overwriting data.

This is business-data protection, not a guarantee against a compromised owner computer or a specialist cryptographic signoff. Complete an explicit security review and actual recovery tests before calling the feature release-ready. References: [OWASP cryptographic storage](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html), [MDN Web Crypto](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API).

## 5. Daily/weekly while ERP is open

Validate preferences with Zod: frequency OFF/DAILY/WEEKLY; a valid local HH:mm; valid IANA zone; weekday0–6 required for weekly mode; device-local retention choice if supported. Keep proposed client DTOs separate from verified server contracts. Disabling the schedule stops future scheduled work, not existing stored files.

Check due work on authenticated app start, visible/focus resume and network return, plus an appropriate while-open timer. Use local calendar slots in the selected time zone, handling DST, clock changes and missed windows. On return from sleep/offline/closed ERP, perform at most one current catch-up backup and record its actual coverage/save time; do not invent a file for every missed day.

Deduplicate manual/scheduled and multi-tab attempts for the same device/cafe/due slot with a robust lock and generation/identity checks. Use capability detection and a tested fallback if the preferred browser locking API is unavailable. A lease/lock or an export response alone is not a completed backup. Do not persist a slot as successful before file verification.

Failures are retryable with bounded backoff only while prerequisites remain valid. A revoked permission/locked key requires owner action, not repeated popups. Stop on logout or changed owner/cafe; late async work must not update the next owner's status. Device scheduling is not a Railway cron job and does not rely on Periodic Background Sync for exact delivery. [Browser periodic-sync limitations](https://developer.mozilla.org/en-US/docs/Web/API/Web_Periodic_Background_Synchronization_API).

## 6. Railway outage and recovery

Previously saved archives must remain usable without the original Railway service/account. Deliver a version-matched independent local inspection/recovery kit with the first backup and test it without network access. An authenticated page served only by the unavailable ERP is insufficient. The kit must inspect/decrypt/validate the archive locally without uploading its data or key, show coverage/content/omissions and support documented recovery into an authorized isolated target. It must not require a production secret or contact a CDN to display essential data. Treat archive contents as untrusted input; no executable HTML, unsafe extraction paths or unlimited decompression.

Restore is a separate, explicit operation: preflight key/integrity/version/tenant/relationship checks → preview → isolated test target → exact data reconciliation. Restore records inertly through a controlled importer, not by replaying sale/payment/stock/posting APIs. Preserve history and exact relationships/values; do not create new financial events, send messages, activate jobs or duplicate inventory usage. Never merge/overwrite live owner data automatically. A real restore needs its own authorization and rollback plan.

Explain in Arabic: saved copies protect data up to their recorded coverage time. A new server-derived backup cannot be produced while the server is unavailable. A backup does not make offline POS sales or synchronization available; those remain separate features.

## 7. Verification and delivery

Use meaningful targeted tests and a verified synthetic cafe, never owner data. Required evidence:

1. Manual export → encrypt → save on a real supported computer → reopen/decrypt/validate; exact row counts, identities, relationships, Decimal/bigint values and relevant attachment bytes. Test concurrent synthetic business changes during export and changed/missing attachment bytes: the archive represents one consistent snapshot or fails/declares incompleteness explicitly. Show representative settings and saved-file states.
2. Two cafe owners plus a limited user: no cross-tenant data, no credential leakage and no branch-limited export mislabeled complete.
3. Daily/weekly/OFF, time/zone/DST, missed-slot catch-up, app navigation away from Settings, reload/locked key, two tabs, overlapping manual backup, logout/account change and late responses.
4. Network/Railway outage, denied/revoked folder permission, unsupported browser, disk full, interrupted/truncated/tampered file, wrong recovery key and safe retention behavior. Never record success without a valid saved file.
5. Open the independent recovery kit with network disabled; test a separately authorized isolated restore. Reconcile business totals and references, with zero extra collections/postings/stock deductions/messages. Publish omissions/size/support limits and device/browser results.

Finish local source and focused verification before asking for any deployment/setup approval. Deliver a short `BACKUP-STEP7-HANDOFF.md` with changed files, format/key/recovery instructions, exact checks, synthetic proof, screenshot evidence, tested support matrix and remaining gates. Distinguish implemented code, verified local saves, verified recovery and owner acceptance. Do not mark the backup feature complete or reliable merely because an archive downloaded or unit tests passed.

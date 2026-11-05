# NEXT CUP — redesign, CRM and branch execution roadmap

Planning revision dated 2026-11-04, Africa/Cairo. Requested by the owner. Implementation awaits the current Claude 4B.2 closeout and later visual acceptance. This document proposes product direction and acceptance criteria. It does not claim new modules are implemented.

## 1. Evidence and design direction

Five images attached in this conversation are the visual references. Their sample text, dates, labels and numbers are illustrative. No claim about the functionality of the pictured products is inferred from their appearance.

| Reference | Adopt in NEXT CUP | Adapt for operational use |
|---|---|---|
| 1 — sage, slate and lavender component board | Soft corners, subtle elevation, segmented controls, explicit selected and empty states | Crisp borders and dark readable text; restrained shadows; clear keyboard focus |
| 2 — monochrome dashboard | Four concise KPI cards, period switcher, chart beside a small agenda, compact data table | Real sales, collection, expenses and task data with consistent branch/date scope |
| 3 — blue administration dashboard | Grouped modules and direct shortcuts to actions and queues | Role-based operational areas and a simple hierarchy; one primary page scroll |
| 4 — purple tasks and groups screens | Compact task rows, status chips, assignees, team views and progress | Arabic RTL, readable text and labelled actions; performance measures explain their denominator |
| 5 — mobile portal | Large quick-access tiles, notifications, upcoming work and bottom navigation | Employee home with My tasks, current shift, requests and relevant branch shortcuts |

The recommended direction combines a near-black navigation rail, warm light content surfaces and restrained green accents. Suggested tokens, subject to visual approval: navigation #151918, navigation tiles #202624, canvas #F6F7F4, surface #FFFFFF, text #17221E, primary #27695B. Lavender, blue and amber are secondary accents for module identification. Status text and icons must accompany colour. Verify actual contrast combinations before acceptance.

Arabic body text targets 16px, secondary information 14px, section headings 20–24px. Use existing Arabic font and components where suitable. Desktop data rows target approximately 48–64px for ordinary content, expanding for necessary content. Touch controls target at least 44px. Corners and spacing use shared tokens. Financial rows have aligned numeric columns and explicit currency. Readability comes from hierarchy and spacing as well as size.

Navigation module boxes have dark surfaces, distinct outline icons and visible titles. The active module has a green accent, explicit selected state and a visible subpage. Expanded groups and the mobile drawer use keyboard-accessible controls. Retain readable names when the rail is expanded and accessible labels when collapsed.

Use cards for summaries and navigation, compact rows for recurring records, and a detail drawer/page for full evidence. The expense list remains compact. POS retains task-specific large touch targets. Filters use one reusable pattern with visible applied scope, reset, loading and empty states. Search, sorting, pagination and full-versus-page export scope remain consistent across modules.

## 2. Proposed information architecture

- Overview — owner dashboard, branch comparison, alerts and action inbox.
- Sales and service — POS, sales invoices, returns, customers, tables, kitchen and QR orders.
- Inventory and purchasing — stock, movements, counts, suppliers, purchases, recipes and approved pricing tools.
- Finance and accounting — operating expenses, treasury, chart of accounts, journals, ledger and financial reports with existing approval gates.
- Branches and team — branch workspace, shifts, people, tasks, checklists, requests and operating procedures.
- Customers / CRM — customer directory, customer history, complaints and follow-up work.
- Reports — existing report hierarchy, including sales by SKU, shift, employee and table; later task and customer reports.
- Settings — permissions, feature settings, backup, local operation and synchronization health.

Navigation follows permissions. Reuse existing routes and redirect old bookmarks deliberately when routes change. Grouping in this plan does not imply replacing operational models or duplicating customers and staff.

## 3. Role-specific home screens

Owner: company/branch selector, period selector, net sales with definition, collections, expenses, overdue tasks, branch comparison and exceptions requiring a decision. Links open the underlying filtered records. Avoid implying that collections equal revenue or operational expenses alone establish accounting profit.

Branch manager: current shift, staffing assignments, opening/closing checklist, delayed orders, inventory exceptions, tasks awaiting review and customer complaints assigned to the branch.

Employee: My tasks today, clear due times, task instructions, current shift, blocked-work reporting and submitted work awaiting approval. Customer-sensitive and financial information follows existing permissions.

## 4. Step 10 — shared visual system and rollout

10A: inventory the current components and screenshots. Prepare four representative screens using realistic synthetic data — POS, compact expenses, owner overview and task list/detail. Include desktop, 1024px with expanded rail, and 375–390px mobile. Present the recommended palette and interaction states for owner acceptance.

10B: implement shared tokens, navigation, headers, filters, list rows, cards, drawers, status chips and export controls. Pilot the accepted components on one management page and one operational page. Preserve existing permissions and transactional paths.

10C: apply incrementally across sales/reports, expenses/accounting, recipes/inventory/purchases, branches/team and CRM. Each rollout includes a source comparison, populated browser evidence, keyboard flow and regression checks appropriate to the affected behaviour. Do not label the whole ERP redesigned after changing the shell alone.

Acceptance: no page-wide horizontal overflow on the agreed mobile widths, usable internal table scrolling where required, accessible focus, meaningful labels, tested contrast, zoom support, accurate empty/error/loading states and readable exports. Owner visual acceptance remains a distinct status.

## 5. Step 11 — branches, staff responsibilities and task execution

The owner's central requirement is traceable responsibility across branches. Existing Branch, User and Shift models were found in the root schema. A narrow schema search did not identify a dedicated Task/Checklist model; inspect the active worktree and routes before proposing new tables.

11A delivers a shared task service and employee/manager screens. Each task includes title, instructions, branch, accountable assignee, creator, priority, due date/time, optional shift link, checklist items and evidence requirements. Team membership may aid assignment, but each actionable task has an accountable person. Bulk assignment to several branches creates traceable per-branch instances.

Workflow: assigned → in progress → submitted for review → approved. Blocked, cancelled and reopened states carry reasons. Overdue is calculated from due time and completion policy. Only reviewer approval counts as accepted completion when review is required. Evidence may include notes, an attachment or checklist results, with author and timestamp. A task links to an expense, maintenance issue or stock record when relevant; completing it alone never changes that record's financial state.

11B adds recurring opening/closing, cleaning and maintenance templates, due-date reminders, escalation, reassignment and review queues. Recurrences have stable occurrence identities so retries cannot create duplicate tasks. Record whether changing a template affects future instances, preserving completed history. Recurrence and deadlines use the branch's configured timezone.

11C adds employee and branch views for assigned, submitted, approved, overdue, blocked and reopened tasks. Show task complexity/priority and period filters alongside counts; report acceptance rate with an explicit denominator. Avoid automatic payroll deductions or a simplistic employee ranking from raw task counts.

Acceptance scenario: owner assigns a cleaning task to each of two branches; one employee submits evidence, a reviewer requests correction, the employee resubmits and the reviewer approves. The other branch becomes overdue and appears in the owner's action inbox. Test wrong-branch access, reassignment, concurrent edits, duplicate submission, notification retry and audit history.

## 6. Step 12 — CRM linked to operations

Customer is already present in the root schema. Reuse its stable identity, existing order relationships and business isolation after inspecting the active worktree. CRM and staff-task tracking have distinct screens and share assignments where follow-up is needed.

12A: customer search and profile, validated contact details, branch visit history, order/invoice links, approved notes, communication preferences and consent records where applicable. Show visit count, last visit and spend with clear treatment of refunds and selected date scope. Customer merge is a separately reviewed operation with duplicate checks and retained history.

12B: complaint/case intake from branch or customer contact, priority, responsible employee, due date, linked order, follow-up activity and resolved/reopened states. A complaint can create a staff task with a stable link. Customer identity, notes and evidence are restricted by role and business; branch access is explicit.

12C: customer segments, repeat-customer trends, unresolved complaints and follow-up performance. Loyalty, campaigns and outbound message integrations remain optional later increments with separate business rules, consent and provider review. Internal task notifications and external customer communications are recorded separately.

Acceptance: a customer's purchases remain attached to the same identity, a complaint is assigned and followed to resolution across permitted branches, restricted employees cannot view excluded contact/history data, and retries create one follow-up. Verify search, exports and reports against seeded records.

## 7. Additional operational gaps to assess

| Capability | Proposed treatment |
|---|---|
| Action inbox and approvals | Shared view over existing approvals plus tasks, with source-specific decisions and audit |
| Branch operating checklists | Reuse Step 11 recurrence and evidence instead of a separate task engine |
| Maintenance tickets | Initial task subtype linked to branch/equipment; extend asset register only if business need is confirmed |
| Procedures and staff onboarding | Versioned instructions attached to tasks, acknowledgement and training completion in a later 11 increment |
| Attendance and leave | Discover existing support first; record as a separate future scope with payroll dependencies |
| Equipment/asset accounting | Link operational maintenance identifiers to the approved accounting design when available |
| Cross-branch overview | Reuse existing branch permissions and metric definitions, with last-updated time and incomplete-sync indicators |

These are coverage proposals. Discovery must distinguish absent capability from an existing feature needing better navigation. The five screenshots inspire presentation and do not establish payroll, accounting or compliance policies.

## 8. Dependencies, integrity and release sequence

Current work remains Claude's 4B.2 closeout, including account administration/export additions. Wait for its report before editing its source. Review its source/runtime evidence and reconcile roadmap status first.

Then approve 10A, close the appropriate core integration gates, and implement 10B plus 11A sequentially before CRM 12A. The original steps 6–9 remain scheduled work: self-service QR alerts, owner-device backup, shared LAN operation and cost-based pricing. Each retains its existing design and approval requirements.

Task/CRM APIs require server-side business/branch authorization, transactional audit, retry-safe writes, optimistic concurrency and bounded exports. Minimize exposed personal information. Define attachment access and retention during technical design.

LAN work in Step 8 must define ownership of task edits, customer changes, assignments and evidence uploads before these modules claim offline support. Show pending synchronization and freshness in branch dashboards. Backup Step 7 must later include new task/CRM relationships and permitted attachments, with restore verification.

Each milestone records implementation, technical checks, populated browser checks, owner acceptance and release separately. After this document update, wait for the latest Claude result. No new implementation prompt is dispatched by this planning session.

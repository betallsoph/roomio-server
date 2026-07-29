# Legacy finance ledger touchpoints (FIN-000)

Inventory date: 2026-07-29 (checkout rows reconciled 2026-07-30 post-AUTH-006)  
Base: `origin/refactor/production-hardening` @ `759e796`  
Branch: `docs/FIN-000-reconciliation`  
Scope: roomio-api + roomio-web + roomio-tma  
Excluded: full AUTH-006 resurvey; production secrets; signed URLs.

Sources: Lane 1 API inventory, Lane 2 Web/TMA inventory, Lane 4 independent verify.  
Drizzle `meta/*_snapshot.json` mirrors are noted once under schema history — not duplicated per snapshot.

Replacement tickets are concrete FIN/UX/TG/DATA/CORE IDs from `docs/production-hardening/02-invoice-debt-payment.md`. No “fix later” rows.

## Summary counts

| Surface                                | Touchpoints (rows below) | Notes                                                     |
| -------------------------------------- | ------------------------ | --------------------------------------------------------- |
| API schema + migrations                | 11                       | Includes `depositRequired` schema-only                    |
| API routes / services / cron / scripts | 40                       | Invoice/payment/room debt write cluster; checkout split canonical vs legacy |
| Web                                    | 22                       | Includes client `invoiceDebtAmount` / bulk `previewTotal` |
| TMA                                    | 22                       | No local debt formula; uses Room.debtAmount / confirmPaid |
| **Total**                              | **95**                   |                                                           |

Lane 4 cross-check: API primary source files ≈ 19 (+ drizzle history); Web+TMA files ≈ 23. Row count below is operation-level (one endpoint/action per row), not unique files.

---

## API — schema & migrations

| repo       | file                                              | endpoint/job/component      | op             | data used                                                          | has transaction? | callers | risk                                    | replacement ticket        | owner   |
| ---------- | ------------------------------------------------- | --------------------------- | -------------- | ------------------------------------------------------------------ | ---------------- | ------- | --------------------------------------- | ------------------------- | ------- |
| roomio-api | `src/lib/server/db/schema.ts`                     | `rooms` columns             | write (schema) | `status` (`empty\|paid\|debt`), `debtAmount`                       | —                | Drizzle | Payment state conflated with occupancy  | FIN-027, FIN-028          | backend |
| roomio-api | `src/lib/server/db/schema.ts`                     | `invoices` columns          | write (schema) | `status`, `paidAmount`, `paymentProofImage`, float amounts         | —                | Drizzle | Legacy float + proof-on-invoice         | FIN-002, FIN-009, FIN-028 | backend |
| roomio-api | `src/lib/server/db/schema.ts`                     | `paymentTransactions` table | write (schema) | legacy payment log                                                 | —                | Drizzle | Not ledger-grade; duplicates paidAmount | FIN-003                   | backend |
| roomio-api | `src/lib/server/db/schema.ts`                     | `tenantProfiles.deposit`    | write (schema) | `deposit` doublePrecision                                          | —                | Drizzle | Profile deposit ≠ ledger held           | FIN-019, FIN-028          | backend |
| roomio-api | `src/lib/server/db/schema.ts`                     | `contracts.deposit`         | write (schema) | `deposit` doublePrecision                                          | —                | Drizzle | Contract deposit ≠ collected            | FIN-019, FIN-028          | backend |
| roomio-api | `src/lib/server/db/schema.ts`                     | `tenancies.depositRequired` | write (schema) | `depositRequired` bigint                                           | —                | Drizzle | Schema ahead of runtime deposit ledger  | FIN-019, AUTH-004         | backend |
| roomio-api | `drizzle/0000_thankful_forgotten_one.sql`         | initial migration           | write (schema) | Invoice paidAmount/proof; Room debtAmount; Tenant/Contract deposit | —                | migrate | Baseline legacy money columns           | FIN-002, FIN-016          | backend |
| roomio-api | `drizzle/0001_swift_onslaught.sql`                | migration                   | write (schema) | PaymentTransaction + FKs                                           | —                | migrate | Legacy txn table                        | FIN-003, FIN-017          | backend |
| roomio-api | `drizzle/0017_nebulous_felicia_hardy.sql`         | migration                   | write (schema) | PaymentTransaction indexes                                         | —                | migrate | Legacy txn lookups                      | FIN-003                   | backend |
| roomio-api | `drizzle/0018_nasty_starbolt.sql`                 | migration                   | write (schema) | PaymentTransaction.paymentAccountId                                | —                | migrate | Legacy txn metadata                     | FIN-003                   | backend |
| roomio-api | `drizzle/0023_auth004_managed_tenant_tenancy.sql` | AUTH-004 migration          | write (schema) | Tenancy.depositRequired; TenantProfile.deposit nullable            | —                | migrate | Deposit field triad                     | FIN-019, FIN-025          | backend |

---

## API — invoices & payments

| repo       | file                                                   | endpoint/job/component             | op         | data used                                                                     | has transaction? | callers              | risk                                | replacement ticket        | owner   |
| ---------- | ------------------------------------------------------ | ---------------------------------- | ---------- | ----------------------------------------------------------------------------- | ---------------- | -------------------- | ----------------------------------- | ------------------------- | ------- |
| roomio-api | `src/routes/api/invoices/+server.ts`                   | `GET /api/invoices`                | read       | status filter; paidAmount; paymentProofImage                                  | no               | Web/TMA              | Legacy DTO exposure                 | FIN-008                   | backend |
| roomio-api | `src/routes/api/invoices/+server.ts`                   | `POST /api/invoices`               | write      | status=pending, paidAmount=0; rooms.status=debt; debtAmount+=total            | yes              | Landlord UI          | Debt without ledger                 | FIN-006, FIN-007, FIN-027 | backend |
| roomio-api | `src/routes/api/invoices/+server.ts`                   | `DELETE /api/invoices`             | read/write | outstanding=total-paid; debtAmount-=                                          | yes              | Landlord bulk delete | Debt adjust, no room status fix     | FIN-014, FIN-027          | backend |
| roomio-api | `src/routes/api/invoices/[id]/+server.ts`              | `GET /api/invoices/:id`            | read       | status, paidAmount, paymentProofImage                                         | no               | Web/TMA              | Legacy detail DTO                   | FIN-008                   | backend |
| roomio-api | `src/routes/api/invoices/[id]/+server.ts`              | `PUT` action `confirmPaid`         | read/write | paidAmount=total; status=paid; paymentTransactions insert; room paid + debt-= | yes              | Landlord confirm     | No partial; no CORE-006 audit       | FIN-010, CORE-006         | backend |
| roomio-api | `src/routes/api/invoices/[id]/+server.ts`              | `PUT` action `uploadProof`         | write      | paymentProofImage; status=pending                                             | no               | Tenant/landlord      | Proof on invoice; can reset overdue | FIN-009                   | backend |
| roomio-api | `src/routes/api/invoices/[id]/+server.ts`              | `PUT` default update               | write      | paidAmount from body; may set paid                                            | no               | Landlord edit        | No debt/txn sync                    | FIN-010, FIN-012          | backend |
| roomio-api | `src/routes/api/invoices/[id]/+server.ts`              | `DELETE /api/invoices/:id`         | read/write | debtAmount-=outstanding if not paid                                           | yes              | Landlord             | Debt-only adjust                    | FIN-014, FIN-027          | backend |
| roomio-api | `src/routes/api/invoices/[id]/payment-link/+server.ts` | `POST .../payment-link`            | read       | reject if paid; amountDue=total-paid                                          | no               | Tenant PayOS/VietQR  | Amount from legacy fields           | FIN-011, FIN-008          | backend |
| roomio-api | `src/routes/api/invoices/bulk/+server.ts`              | `POST /api/invoices/bulk`          | write      | pending+paidAmount=0; room debt+=                                             | yes              | Landlord bulk        | Bulk debt bump                      | FIN-006, FIN-007          | backend |
| roomio-api | `src/routes/api/invoices/draft-approve/+server.ts`     | `POST /api/invoices/draft-approve` | read/write | draft→pending; room debt+=                                                    | yes              | Landlord drafts      | Legacy approve path                 | FIN-007                   | backend |
| roomio-api | `src/routes/api/payment-webhook/+server.ts`            | PayOS unmatched/ignored/duplicate  | write      | paymentTransactions status variants                                           | no               | PayOS webhook        | Orphan/duplicate rows               | FIN-011, FIN-023          | backend |
| roomio-api | `src/routes/api/payment-webhook/+server.ts`            | PayOS applied                      | read/write | paidAmount+=; status paid/partial; debtAmount-=; room paid if full            | yes              | PayOS webhook        | Float math; partial room status gap | FIN-011, FIN-012, FIN-027 | backend |
| roomio-api | `src/routes/api/payments/+server.ts`                   | `GET /api/payments`                | read       | paymentTransactions + invoice                                                 | no               | Landlord payments UI | Legacy txn table                    | FIN-008, FIN-015          | backend |

---

## API — rooms, tenants, contracts, dashboards

| repo       | file                                        | endpoint/job/component        | op         | data used                                                                       | has transaction? | callers             | risk                                 | replacement ticket        | owner   |
| ---------- | ------------------------------------------- | ----------------------------- | ---------- | ------------------------------------------------------------------------------- | ---------------- | ------------------- | ------------------------------------ | ------------------------- | ------- |
| roomio-api | `src/routes/api/rooms/+server.ts`           | `GET /api/rooms`              | read       | status filter; debtAmount                                                       | no               | Rooms UI            | Debt from room cache                 | FIN-027, FIN-008          | backend |
| roomio-api | `src/routes/api/rooms/+server.ts`           | `POST /api/rooms`             | write      | status=empty, debtAmount=0                                                      | yes              | Add room            | Init legacy fields                   | FIN-027                   | backend |
| roomio-api | `src/routes/api/rooms/+server.ts`           | `PUT` checkout (Tenancy canonical) | write      | Tenancy ACTIVE→ENDED; conditional `tenantId`/`currentManagedTenantId` clear; returns `TenancyDto` + `room:{id}`; **does not** set `Room.status` or `Room.debtAmount` | yes              | Checkout when `tenancyDualWriteEnabled` or room has ACTIVE Tenancy (split-brain guard) | Ends occupancy without debt/settlement; legacy `debtAmount`/`status` cache may stay stale | FIN-020, FIN-021, FIN-027 | backend |
| roomio-api | `src/routes/api/rooms/+server.ts`           | `PUT` checkout (legacy, no Tenancy)  | write      | `status=empty`, `tenantId=null`, `debtAmount=0` (only when flag OFF and no ACTIVE Tenancy) | no               | Checkout on pre-Tenancy / never-backfilled rooms | Clears debt without settlement — legacy-only path | FIN-020, FIN-019, AUTH-007 | backend |
| roomio-api | `src/routes/api/rooms/+server.ts`           | `PUT` standard                | write      | optional status, debtAmount                                                     | no               | Room edit           | Manual debt override                 | FIN-027, FIN-030          | backend |
| roomio-api | `src/routes/api/tenants/+server.ts`         | `GET /api/tenants`            | read       | tenantProfiles.deposit                                                          | no               | Tenants UI          | Legacy deposit                       | FIN-019, FIN-008          | backend |
| roomio-api | `src/routes/api/tenants/+server.ts`         | `POST /api/tenants` check-in  | write      | deposit; room status=paid debt=0; contracts.deposit                             | yes              | Onboarding          | Deposit not ledger; room marked paid | FIN-019, FIN-025, FIN-027 | backend |
| roomio-api | `src/routes/api/contracts/+server.ts`       | `GET/POST/PUT /api/contracts` | read/write | contracts.deposit                                                               | no               | Contracts UI        | Display/write legacy deposit         | FIN-019                   | backend |
| roomio-api | `src/routes/api/finance/+server.ts`         | `GET /api/finance`            | read       | sum paidAmount by month                                                         | no               | Finance dashboard   | Revenue ≠ ledger                     | FIN-015                   | backend |
| roomio-api | `src/routes/api/dashboard/stats/+server.ts` | `GET /api/dashboard/stats`    | read       | rooms.status; invoice status counts; sum paidAmount                             | no               | Dashboard           | Mixed room+invoice legacy            | FIN-015, FIN-027          | backend |
| roomio-api | `src/routes/api/super-admin/+server.ts`     | `GET /api/super-admin`        | read       | room debt/status; invoice paidAmount; paymentTransactions; JS unpaid aggregates | no               | Super-admin Web/TMA | SaaS metrics on legacy               | FIN-015, FIN-023          | backend |

---

## API — automation, cron, scripts, adjacent

| repo       | file                                     | endpoint/job/component    | op                    | data used                             | has transaction? | callers              | risk                         | replacement ticket | owner   |
| ---------- | ---------------------------------------- | ------------------------- | --------------------- | ------------------------------------- | ---------------- | -------------------- | ---------------------------- | ------------------ | ------- |
| roomio-api | `src/lib/server/automation.ts`           | `runOverdueSweep`         | write                 | invoices.status→overdue               | no               | cron/automation      | Status without ledger        | FIN-004, FIN-007   | backend |
| roomio-api | `src/lib/server/automation.ts`           | `queueInvoiceReminders`   | read                  | status filter; total-paid in message  | no               | cron/automation      | Reminder from legacy balance | FIN-004, FIN-022   | backend |
| roomio-api | `src/lib/server/automation.ts`           | `generateDraftInvoices`   | write                 | status=draft, paidAmount=0            | yes              | cron/automation      | Draft still legacy schema    | FIN-006            | backend |
| roomio-api | `src/lib/server/automation.ts`           | `getCentralInbox` overdue | read                  | overdue/partial; total-paid           | no               | `GET /api/inbox`     | Inbox from legacy            | FIN-015, FIN-022   | backend |
| roomio-api | `src/lib/server/automation.ts`           | `getCentralInbox` proofs  | read                  | paymentProofImage; status≠paid        | no               | inbox                | Proof queue on invoice       | FIN-009            | backend |
| roomio-api | `src/lib/server/automation.ts`           | date helpers              | read                  | `toISOString().split/slice` month/day | no               | automation jobs      | TZ-sensitive civil dates     | FIN-001            | backend |
| roomio-api | `src/routes/api/cron/monthly/+server.ts` | `POST /api/cron/monthly`  | read/write (indirect) | overdue/reminders/drafts              | per child        | External cron        | Touches legacy money paths   | FIN-006, FIN-023   | backend |
| roomio-api | `src/routes/api/automation/+server.ts`   | `POST /api/automation`    | read/write (indirect) | same jobs                             | per child        | Landlord UI          | Manual trigger               | FIN-006            | backend |
| roomio-api | `src/routes/api/inbox/+server.ts`        | `GET /api/inbox`          | read (indirect)       | via getCentralInbox                   | no               | Inbox UI             | Aggregates legacy signals    | FIN-022            | backend |
| roomio-api | `scripts/cleanup-uploads.ts`             | `npm run cleanup:uploads` | read/write            | clear aged paymentProofImage          | no               | Ops cron             | Proof URL on invoice row     | FIN-009, DATA-008  | backend |
| roomio-api | `src/lib/server/payos.ts`                | amount rounding           | read (compute)        | `Math.round(input.amount)`            | no               | payment-link / PayOS | Rounding ≠ FIN-001 half-up   | FIN-001, FIN-011   | backend |

---

## Web (roomio-web)

| repo       | file                                                | endpoint/job/component                 | op             | data used                            | has transaction? | callers            | risk                               | replacement ticket                         | owner    |
| ---------- | --------------------------------------------------- | -------------------------------------- | -------------- | ------------------------------------ | ---------------- | ------------------ | ---------------------------------- | ------------------------------------------ | -------- |
| roomio-web | `src/lib/invoice-detail.ts`                         | `invoiceDebtAmount()`                  | read (compute) | totalAmount-paidAmount               | no               | InvoiceDetailModal | **P0** client balance              | FIN-022, UX-012                            | frontend |
| roomio-web | `src/lib/invoice-detail.ts`                         | status label helpers                   | read           | legacy 4-state status                | no               | InvoiceDetailModal | vs ledger 6-state                  | FIN-022, UX-012                            | frontend |
| roomio-web | `src/lib/invoice-detail.test.ts`                    | unit tests                             | read           | encodes debt formula                 | no               | CI                 | Locks legacy math                  | FIN-022, UX-012                            | frontend |
| roomio-web | `src/lib/InvoiceDetailModal.svelte`                 | detail / paid / proof / confirm        | read/write     | paidAmount, proof, confirmPaid       | no               | invoices pages     | Legacy paid/debt UI                | FIN-008, FIN-009, FIN-010, UX-012, UX-013  | frontend |
| roomio-web | `src/routes/dashboard/invoices/+page.svelte`        | list + confirmPayment                  | read/write     | status, total, proof, confirmPaid    | no               | landlord           | Legacy confirm                     | FIN-008, FIN-010, UX-013                   | frontend |
| roomio-web | `src/routes/dashboard/invoices/drafts/+page.svelte` | totalSelected + approve                | read/write     | sum totals; draft-approve            | no               | drafts             | Client sum; room-debt copy         | FIN-007, FIN-022, UX-014                   | frontend |
| roomio-web | `src/routes/dashboard/invoices/bulk/+page.svelte`   | `previewTotal()` + submit              | read/write     | rent/meter/flat JS math → bulk API   | no               | bulk wizard        | **P0** full invoice math in JS     | FIN-005, FIN-006, UX-014                   | frontend |
| roomio-web | `src/routes/dashboard/+page.svelte`                 | unpaid widget + confirm                | read/write     | pending filter; confirmPaid          | no               | home               | Legacy status + confirm            | FIN-008, FIN-010, UX-012                   | frontend |
| roomio-web | `src/routes/tenant/+page.svelte`                    | pendingInvoice + uploadProof + deposit | read/write     | status≠paid; proof; deposit          | no               | tenant             | Unpaid inference; proof-on-invoice | FIN-008, FIN-009, FIN-019, FIN-022, TG-004 | frontend |
| roomio-web | `src/routes/dashboard/rooms/+page.svelte`           | room list/detail/export                | read           | room.status, debtAmount              | no               | rooms              | Finance state on room              | FIN-027, FIN-015, UX-010                   | frontend |
| roomio-web | `src/routes/dashboard/buildings/+page.svelte`       | `calculatePropertyStats`               | read (compute) | status===debt; paid=total-empty-debt | no               | buildings          | Paid rooms from status             | FIN-027, FIN-015                           | frontend |
| roomio-web | `src/routes/dashboard/tenants/+page.svelte`         | deposit sum + create                   | read/write     | reduce(deposit); Number(deposit)     | no               | tenants            | Client money parse                 | FIN-019, FIN-028, UX-016                   | frontend |
| roomio-web | `src/routes/dashboard/contracts/+page.svelte`       | deposit create/list                    | read/write     | form.deposit                         | no               | contracts          | Legacy deposit                     | FIN-019, FIN-028                           | frontend |
| roomio-web | `src/routes/admin/+page.svelte`                     | unpaidAmount reduce                    | read (compute) | landlord metrics                     | no               | super-admin        | Client re-aggregate                | FIN-015, UX-016                            | frontend |
| roomio-web | `src/routes/staff/+page.svelte`                     | room status badges                     | read           | paid/debt/empty                      | no               | staff              | Payment state on room              | FIN-027                                    | frontend |
| roomio-web | `src/routes/dashboard/finance/+page.svelte`         | chart maxBar                           | read (compute) | API finance rows                     | no               | finance            | Display scaling only               | UX-016                                     | frontend |
| roomio-web | `src/lib/upload.ts`                                 | payment-proof purpose                  | write (asset)  | proof images                         | no               | tenant upload      | Infra for legacy proof             | FIN-009, DATA-008                          | frontend |

---

## TMA (roomio-tma)

| repo       | file                                                       | endpoint/job/component                 | op             | data used                             | has transaction? | callers            | risk                         | replacement ticket                | owner |
| ---------- | ---------------------------------------------------------- | -------------------------------------- | -------------- | ------------------------------------- | ---------------- | ------------------ | ---------------------------- | --------------------------------- | ----- |
| roomio-tma | `src/routes/tenant/+page.svelte`                           | pendingInvoice + uploadProof + deposit | read/write     | status≠paid; proof; deposit           | no               | tenant             | Same legacy paths as Web     | FIN-009, FIN-019, FIN-022, TG-004 | TMA   |
| roomio-tma | `src/routes/dashboard/invoices/+page.svelte`               | list/detail + confirmPaid              | read/write     | status, total, paidAmount type, proof | no               | landlord invoices  | No invoiceDebtAmount helper  | FIN-010, FIN-022, UX-012, UX-013  | TMA   |
| roomio-tma | `src/routes/dashboard/+page.svelte`                        | unpaid + confirm                       | read/write     | pending; confirmPaid                  | no               | home               | Legacy confirm               | FIN-008, FIN-010, UX-012          | TMA   |
| roomio-tma | `src/routes/dashboard/rooms/+page.svelte`                  | room cards/detail                      | read           | status, debtAmount                    | no               | rooms              | Room finance state           | FIN-027, UX-010                   | TMA   |
| roomio-tma | `src/routes/dashboard/buildings/+page.svelte`              | calculatePropertyStats                 | read (compute) | status debt counts                    | no               | buildings          | Paid from status             | FIN-027, FIN-015                  | TMA   |
| roomio-tma | `src/routes/dashboard/workspace/[propertyId]/+page.svelte` | workspace stats                        | read (compute) | status; debtAmount                    | no               | property workspace | TMA-only surface             | FIN-027, FIN-015                  | TMA   |
| roomio-tma | `src/routes/dashboard/tenants/+page.svelte`                | deposit sum/create                     | read/write     | deposit Number()                      | no               | tenants            | Client money parse           | FIN-019, FIN-028                  | TMA   |
| roomio-tma | `src/routes/dashboard/contracts/+page.svelte`              | contract deposit                       | read/write     | form.deposit                          | no               | contracts          | Legacy deposit               | FIN-019, FIN-028                  | TMA   |
| roomio-tma | `src/routes/dashboard/invoices/bulk/+page.svelte`          | bulk submit                            | write          | Number(prev/curr) → bulk API          | no               | bulk               | No previewTotal (unlike Web) | FIN-006, UX-014                   | TMA   |
| roomio-tma | `src/routes/staff/+page.svelte`                            | room status badges                     | read           | paid/debt                             | no               | staff              | Room payment state           | FIN-027                           | TMA   |
| roomio-tma | `src/routes/super-admin/+page.svelte`                      | unpaidAmount reduce                    | read (compute) | metrics                               | no               | super-admin        | Client re-aggregate          | FIN-015, UX-016                   | TMA   |
| roomio-tma | `src/routes/dashboard/finance/+page.svelte`                | chart scaling                          | read (compute) | API rows                              | no               | finance            | Display only                 | UX-016                            | TMA   |
| roomio-tma | `src/lib/upload.ts`                                        | payment-proof                          | write (asset)  | proof images                          | no               | tenant             | Legacy proof infra           | FIN-009, DATA-008                 | TMA   |

---

## Known gaps

1. **`Tenancy.depositRequired`** — schema only; zero runtime writers outside schema.
2. **Three deposit fields** — `TenantProfile.deposit`, `Contract.deposit`, `Tenancy.depositRequired` coexist.
3. **`invoices.status=draft`** used in code; schema comment lists paid/pending/overdue/partial only.
4. **No QStash finance handlers** in current tree — reconciliation is FIN-023 / JOB tickets.
5. **`/api/payos-webhook` (subscription)** — no rent invoice paidAmount/debtAmount usage.
6. **CORE-006 audit** allowlist exists; money mutation routes do not emit finance audit events yet.
7. **Web vs TMA parity** — Web has `invoiceDebtAmount` + bulk `previewTotal`; TMA does not.
8. **Fixtures/tests** (`security-fixtures.ts`, meter integration) seed room status/deposit — not production write paths; omitted from table.
9. **Checkout debt semantics (AUTH-006)** — canonical Tenancy checkout no longer clears `Room.debtAmount`/`status`; legacy checkout still zeroes both for rooms without ACTIVE Tenancy. Properties on dual-write / backfilled Tenancy use canonical path; unmigrated rooms keep legacy debt wipe.
10. **FIN-001** (`MoneyVnd` / `LocalDate`) is the foundation for replacing float math and `toISOString` date splits listed above.

## Verification notes

- Second-pass patterns: `paidAmount|debtAmount|paymentTransactions|paymentProofImage|depositRequired|confirmPaid|uploadProof|invoiceDebtAmount|previewTotal|room.status === 'debt'`.
- AUTH-006 reconciliation (2026-07-30): `PUT /api/rooms` checkout splits into Tenancy canonical (`endActiveTenancyForRoom`, transactional, `TenancyDto` response, debt untouched) vs legacy-only (`debtAmount=0`, no transaction) when `tenancyDualWriteEnabled=false` and `hasActiveTenancyForRoom` is false.
- Lane 4 confirmed automation/cron/cleanup/payos/webhook blind spots are covered in API sections above.
- No production credentials, signed URLs, or live account IDs included.

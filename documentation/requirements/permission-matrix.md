# Role and permission matrix

_Generated from `packages/api-contracts/src/permissions.ts`. Enforced server-side on every request (PermissionsGuard + service checks); hiding UI controls is only a convenience._

Roles are editable per business (Administration → Roles). An administrator can only grant permissions they hold. The Owner role always has all permissions.

| Permission | Description | Owner | Store Manager | Cashier | Purchasing Officer | Storekeeper | Accountant | System Administrator | Read-only Auditor |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `dashboard.view` | View dashboard | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `pos.sell` | Ring up sales at the POS | ✓ | ✓ | ✓ |  |  |  |  |  |
| `pos.hold` | Hold and recall carts | ✓ | ✓ | ✓ |  |  |  |  |  |
| `pos.discount` | Apply discounts within the policy limit | ✓ | ✓ | ✓ |  |  |  |  |  |
| `pos.price_override` ★ | Override price on fixed-price items (min-price breaches still need approval); negotiable items can be bargained by any cashier down to the minimum | ✓ | ✓ |  |  |  |  |  |  |
| `pos.credit_sale` | Sell on customer credit | ✓ | ✓ |  |  |  |  |  |  |
| `pos.return` | Process customer returns and exchanges | ✓ | ✓ |  |  |  |  |  |  |
| `pos.confirm_payment` ★ | Manually confirm electronic payments with a reference | ✓ | ✓ |  |  |  |  |  |  |
| `sessions.open` | Open a cashier session | ✓ | ✓ | ✓ |  |  |  |  |  |
| `sessions.close` | Count and close own cashier session | ✓ | ✓ | ✓ |  |  |  |  |  |
| `sessions.cash_drop` | Record cash drops to the safe | ✓ | ✓ | ✓ |  |  |  |  |  |
| `sessions.paid_out` ★ | Record paid-outs from the till | ✓ | ✓ |  |  |  |  |  |  |
| `sessions.view_all` | View all cashier sessions | ✓ | ✓ |  |  |  | ✓ |  |  |
| `products.view` | View catalogue | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `products.manage` | Create and edit products | ✓ | ✓ |  |  |  |  |  |  |
| `products.view_cost` ★ | See cost prices and margins | ✓ | ✓ |  | ✓ |  | ✓ |  | ✓ |
| `prices.manage` ★ | Manage price lists and branch prices | ✓ | ✓ |  |  |  |  |  |  |
| `inventory.view` | View stock levels and movements | ✓ | ✓ |  | ✓ | ✓ | ✓ |  | ✓ |
| `inventory.adjust` | Request stock adjustments and write-offs | ✓ | ✓ |  |  | ✓ |  |  |  |
| `inventory.transfer` | Create, dispatch and receive transfers | ✓ | ✓ |  |  | ✓ |  |  |  |
| `inventory.count` | Run physical counts | ✓ | ✓ |  |  | ✓ |  |  |  |
| `inventory.opening` ★ | Post opening stock balances | ✓ |  |  |  |  |  |  |  |
| `purchasing.view` | View purchase orders and receipts | ✓ | ✓ |  | ✓ | ✓ | ✓ |  | ✓ |
| `purchasing.manage` | Create and submit purchase orders | ✓ | ✓ |  | ✓ |  |  |  |  |
| `purchasing.receive` | Receive goods | ✓ | ✓ |  |  | ✓ |  |  |  |
| `suppliers.view` | View suppliers | ✓ | ✓ |  | ✓ | ✓ | ✓ |  | ✓ |
| `suppliers.manage` | Create and edit suppliers | ✓ | ✓ |  | ✓ |  |  |  |  |
| `payables.manage` ★ | Post supplier invoices and payments | ✓ |  |  | ✓ |  | ✓ |  |  |
| `customers.view` | View customers | ✓ | ✓ | ✓ |  |  | ✓ |  | ✓ |
| `customers.manage` | Create and edit customers | ✓ | ✓ | ✓ |  |  |  |  |  |
| `customers.credit` ★ | Set credit limits and receive account payments | ✓ | ✓ |  |  |  | ✓ |  |  |
| `finance.view` | View financial accounts and sessions | ✓ | ✓ |  |  |  | ✓ |  | ✓ |
| `finance.manage` ★ | Internal transfers, settlements, reconciliations | ✓ |  |  |  |  | ✓ |  |  |
| `expenses.manage` ★ | Record expenses | ✓ | ✓ |  |  |  | ✓ |  |  |
| `accounting.view` | View chart of accounts and journals | ✓ |  |  |  |  | ✓ |  | ✓ |
| `accounting.journal` ★ | Create manual journals (approval required) | ✓ |  |  |  |  | ✓ |  |  |
| `accounting.periods` ★ | Close fiscal periods | ✓ |  |  |  |  | ✓ |  |  |
| `reports.view` | Operational reports | ✓ | ✓ |  | ✓ | ✓ | ✓ |  | ✓ |
| `reports.financial` ★ | Financial statements and margin reports | ✓ | ✓ |  |  |  | ✓ |  | ✓ |
| `approvals.view` | View approval requests | ✓ | ✓ |  |  |  | ✓ |  | ✓ |
| `approve.discount` ★ | Approve excessive discounts | ✓ | ✓ |  |  |  |  |  |  |
| `approve.price_override` ★ | Approve below-minimum prices | ✓ | ✓ |  |  |  |  |  |  |
| `approve.refund` ★ | Approve refunds | ✓ | ✓ |  |  |  |  |  |  |
| `approve.stock_adjustment` ★ | Approve stock adjustments, write-offs and count variances | ✓ | ✓ |  |  |  |  |  |  |
| `approve.purchase` ★ | Approve high-value purchase orders | ✓ | ✓ |  |  |  |  |  |  |
| `approve.credit` ★ | Approve customer credit exceptions | ✓ | ✓ |  |  |  |  |  |  |
| `approve.journal` ★ | Approve manual journals | ✓ |  |  |  |  | ✓ |  |  |
| `approve.period_reopen` ★ | Approve reopening a closed period | ✓ |  |  |  |  | ✓ |  |  |
| `approve.cash_variance` ★ | Approve cashier closing variances and paid-outs | ✓ | ✓ |  |  |  |  |  |  |
| `admin.users` | Manage users and branch access | ✓ |  |  |  |  |  | ✓ |  |
| `admin.roles` | Manage roles and permissions | ✓ |  |  |  |  |  | ✓ |  |
| `admin.settings` | Business settings, branches, registers, taxes | ✓ |  |  |  |  |  | ✓ |  |
| `admin.audit` | View audit log | ✓ |  |  |  |  |  | ✓ | ✓ |

★ sensitive permission.

## Approval types and deciding permission

| Request type | Permission required to decide |
|---|---|
| DISCOUNT | `approve.discount` |
| PRICE_OVERRIDE | `approve.price_override` |
| REFUND | `approve.refund` |
| STOCK_ADJUSTMENT | `approve.stock_adjustment` |
| PURCHASE_ORDER | `approve.purchase` |
| CUSTOMER_CREDIT | `approve.credit` |
| MANUAL_JOURNAL | `approve.journal` |
| PERIOD_REOPEN | `approve.period_reopen` |
| CASH_VARIANCE | `approve.cash_variance` |
| PAID_OUT | `approve.cash_variance` |

Self-approval is blocked by default for every type (configurable per policy). The System Administrator role holds no `approve.*` permission: technical administration does not confer financial approval authority.

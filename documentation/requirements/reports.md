# Reports and metric definitions

All reports query live records (no hardcoded figures), respect branch access, hide cost-based columns from users without cost visibility, and export CSV (`?format=csv`). Drill-down links open the source sale, session, journal or document.

| Metric | Definition |
|---|---|
| Reporting date | Business-local date (`businesses.timezone`) of `sales.completed_at` / document posting time. Financial statements use journal `entry_date`. |
| Gross sales | Σ unit price × quantity, before discounts |
| Net sales (tax-exclusive) | Σ `sale_lines.net_amount` (after discounts, excluding tax) |
| Returns | Σ `sales_return_lines.net_refund` (tax-exclusive) |
| Net revenue | Net sales − returns |
| Cost of sales | Σ weighted-average cost at sale time − returned cost. In the P&L also includes purchase price variance, shrinkage and write-offs |
| Gross profit | Net revenue − cost of sales |
| Gross margin % | Gross profit ÷ net revenue × 100 |
| Markup % | Gross profit ÷ cost of sales × 100 |
| Collections | Confirmed payments by method; cash = amount retained (tendered − change) |
| Operating profit | Gross profit + other income − operating expenses. **Not the same as available cash** |

Available reports: daily sales, collections by method, sales by product/variant/category/branch/cashier, gross profit & margin, discounts, refunds, inventory valuation, slow-moving/ageing stock, stock movements (Inventory → Movements), low stock & reorder (Inventory → Reorder), expiry (Inventory → Expiry), count variances, transfers in transit, purchases by supplier, supplier ageing, customer ageing (Customers → Receivables ageing), cashier variances, expenses, trial balance, profit and loss, balance sheet, reconciliation, audit activity.

Not yet built: direct cash-flow statement (deliberately deferred until cash classifications and reconciliations are in production use), PDF exports (browser print is available for receipts and screens).

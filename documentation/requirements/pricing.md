# Pricing rules

**Precedence (deterministic):**
1. Branch price list item (price list with `branch_id` = sale branch) of the requested kind (RETAIL/WHOLESALE), effective at the pricing instant.
2. Business-wide price list item of that kind.
3. The variant's own price (`wholesale_price` for WHOLESALE, falling back to `retail_price`).

Within a level, the item with the latest `effective_from` wins; ties break on latest `created_at`, then id. The effective window is `[effective_from, effective_to)`, so future-dated prices can be scheduled.

- Price list kind comes from the customer's group (e.g. resellers → WHOLESALE), else RETAIL.
- Packaging units sell at base-unit price × factor (e.g. carton of 24).
- **Minimum price:** item `min_price`, else variant `min_price` (× factor). A line whose effective unit price after discount falls below it requires a `PRICE_OVERRIDE` approval — except on negotiable products, where it is a hard floor (below).
- **Negotiable (bargain) prices:** a product with `negotiable_price = true` must have a minimum price on every active SKU (not above the retail/asking price). At the till any cashier with `pos.sell` may enter the agreed unit price (`override_price`; the POS also accepts an agreed total for the quantity and converts it to a unit price). The server refuses any effective unit price below the minimum with `BELOW_MIN_PRICE` — there is no approval route, for any role, and a discount cannot be used to go under it. Such lines are recorded with price source `NEGOTIATED`. Turning bargaining on/off and setting minimum prices require `prices.manage`.
- **Bulk / loose goods** (`product_type = BULK`): one SKU, stocked and sold in the base unit (e.g. kg, metre, heap) with fractional quantities (3 decimals); no serial numbers. Buy a lot through a packaging unit (e.g. 1 bale = 120 pieces) and sell by the piece. Stock, costing (weighted average) and accounting are the same as standard products.
- **Discounts:** require `pos.discount` and a reason. A discount above the `DISCOUNT` policy percentage (default 10 % of the line) requires approval. Manual price overrides require `pos.price_override`.
- The backend recalculates every price, discount, tax and total; client figures are never trusted (`POST /sales/quote` returns the server's numbers to the POS).
- Historical sale lines snapshot description, SKU, unit and factor, list price, unit price, price source, discount (+ reason, approval), tax rate and amounts, and cost.
- **Promotions (Phase 3):** schema exists (`promotions`, `promotion_rules`). Planned rule: best single non-stackable promotion applies after the base price and before manual discounts; stackable promotions apply in priority order.

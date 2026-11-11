-- Hand-written integrity controls that Prisma's schema language cannot express.
-- These are the database's last line of defence; services enforce the same
-- rules first and return friendly errors.

-- ---------------------------------------------------------------- stock ----
-- One balance row per (location, variant, batch); NULL batch treated as equal.
CREATE UNIQUE INDEX stock_balances_loc_variant_batch_key
  ON stock_balances (location_id, variant_id, batch_id) NULLS NOT DISTINCT;

ALTER TABLE stock_balances
  ADD CONSTRAINT stock_balances_non_negative CHECK (qty_on_hand >= 0 AND qty_reserved >= 0);

ALTER TABLE inventory_cost_pools
  ADD CONSTRAINT inventory_cost_pools_non_negative CHECK (quantity >= 0 AND value >= 0);

ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_nonzero CHECK (quantity <> 0 OR value <> 0);

ALTER TABLE variant_unit_conversions
  ADD CONSTRAINT variant_unit_conversions_factor_positive CHECK (factor > 0);

ALTER TABLE barcodes
  ADD CONSTRAINT barcodes_quantity_positive CHECK (quantity > 0);

ALTER TABLE product_variants
  ADD CONSTRAINT product_variants_prices_non_negative CHECK (
    retail_price >= 0 AND (wholesale_price IS NULL OR wholesale_price >= 0) AND (min_price IS NULL OR min_price >= 0));

-- ------------------------------------------------------------ documents ----
ALTER TABLE purchase_order_lines
  ADD CONSTRAINT po_lines_quantities CHECK (quantity > 0 AND unit_factor > 0 AND unit_cost >= 0 AND received_base >= 0 AND invoiced_base >= 0);

ALTER TABLE goods_receipt_lines
  ADD CONSTRAINT gr_lines_quantities CHECK (qty_accepted >= 0 AND qty_damaged >= 0 AND qty_rejected >= 0 AND unit_cost >= 0);

ALTER TABLE sale_lines
  ADD CONSTRAINT sale_lines_quantities CHECK (
    quantity > 0 AND quantity_base > 0 AND discount_amount >= 0 AND qty_returned_base >= 0 AND qty_returned_base <= quantity_base);

ALTER TABLE payments
  ADD CONSTRAINT payments_amount_positive CHECK (amount > 0 AND change_given >= 0);

ALTER TABLE sales
  ADD CONSTRAINT sales_amounts CHECK (total >= 0 AND credit_amount >= 0 AND credit_settled >= 0 AND credit_settled <= credit_amount);

-- At most one open/closing session per register.
CREATE UNIQUE INDEX cashier_sessions_one_open_per_register
  ON cashier_sessions (register_id) WHERE status <> 'CLOSED';

-- ----------------------------------------------------------- accounting ----
ALTER TABLE journal_lines
  ADD CONSTRAINT journal_lines_one_sided CHECK (
    debit >= 0 AND credit >= 0 AND (debit = 0 OR credit = 0) AND (debit + credit) > 0);

ALTER TABLE journal_entries
  ADD CONSTRAINT journal_entries_balanced_header CHECK (total_debit = total_credit AND total_debit > 0);

-- Lines must sum to the header totals at commit time.
CREATE OR REPLACE FUNCTION fn_check_journal_balanced() RETURNS trigger AS $$
DECLARE
  v_entry uuid := COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);
  v_dr numeric; v_cr numeric; h_dr numeric; h_cr numeric;
BEGIN
  SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0) INTO v_dr, v_cr FROM journal_lines WHERE journal_entry_id = v_entry;
  SELECT total_debit, total_credit INTO h_dr, h_cr FROM journal_entries WHERE id = v_entry;
  IF v_dr <> v_cr OR v_dr <> h_dr OR v_cr <> h_cr THEN
    RAISE EXCEPTION 'Journal entry % is unbalanced (lines Dr % / Cr %, header Dr % / Cr %)', v_entry, v_dr, v_cr, h_dr, h_cr
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_journal_balanced
  AFTER INSERT ON journal_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_check_journal_balanced();

-- Entry date must fall in an OPEN fiscal period it references.
CREATE OR REPLACE FUNCTION fn_check_journal_period() RETURNS trigger AS $$
DECLARE p record;
BEGIN
  SELECT * INTO p FROM fiscal_periods WHERE id = NEW.fiscal_period_id;
  IF p IS NULL OR NEW.entry_date < p.start_date OR NEW.entry_date > p.end_date THEN
    RAISE EXCEPTION 'Journal date % is outside fiscal period', NEW.entry_date USING ERRCODE = 'check_violation';
  END IF;
  IF p.status <> 'OPEN' THEN
    RAISE EXCEPTION 'Fiscal period % is closed', p.name USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_journal_period BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION fn_check_journal_period();

-- Posted journals are immutable except for linking a reversal.
CREATE OR REPLACE FUNCTION fn_journal_entry_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Journal entries cannot be deleted; post a reversal' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'POSTED' AND NEW.status = 'REVERSED' AND OLD.reversed_by_id IS NULL AND NEW.reversed_by_id IS NOT NULL
     AND NEW.total_debit = OLD.total_debit AND NEW.entry_date = OLD.entry_date AND NEW.number = OLD.number THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Posted journal entries are immutable; post a reversal' USING ERRCODE = 'restrict_violation';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_journal_entry_immutable BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION fn_journal_entry_immutable();

-- Append-only tables.
CREATE OR REPLACE FUNCTION fn_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_journal_lines_append_only BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION fn_append_only();
CREATE TRIGGER trg_stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION fn_append_only();
CREATE TRIGGER trg_audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION fn_append_only();
CREATE TRIGGER trg_approval_actions_append_only BEFORE UPDATE OR DELETE ON approval_actions
  FOR EACH ROW EXECUTE FUNCTION fn_append_only();

-- Completed sales cannot be deleted; only limited columns may change later
-- (credit settlement and returned quantities are tracked on separate columns).
CREATE OR REPLACE FUNCTION fn_sale_protect() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'COMPLETED' THEN
      RAISE EXCEPTION 'Completed sales cannot be deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'COMPLETED' AND (
       NEW.status <> OLD.status OR NEW.total <> OLD.total OR NEW.net_amount <> OLD.net_amount
    OR NEW.tax_total <> OLD.tax_total OR NEW.cost_total <> OLD.cost_total OR NEW.number <> OLD.number
    OR NEW.completed_at IS DISTINCT FROM OLD.completed_at OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id) THEN
    RAISE EXCEPTION 'Completed sales are immutable; use a return or reversal' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sale_protect BEFORE UPDATE OR DELETE ON sales
  FOR EACH ROW EXECUTE FUNCTION fn_sale_protect();

-- A journal header without lines (or with lines not matching it) fails at commit.
CREATE OR REPLACE FUNCTION fn_check_journal_header_has_lines() RETURNS trigger AS $$
DECLARE v_dr numeric; v_cr numeric;
BEGIN
  SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0) INTO v_dr, v_cr FROM journal_lines WHERE journal_entry_id = NEW.id;
  IF v_dr <> NEW.total_debit OR v_cr <> NEW.total_credit THEN
    RAISE EXCEPTION 'Journal entry % lines (Dr % / Cr %) do not match header', NEW.number, v_dr, v_cr USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_journal_header_has_lines
  AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_check_journal_header_has_lines();

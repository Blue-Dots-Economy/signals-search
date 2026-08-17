-- NOTE: authoritative copy lives in Signals-DPG
-- (apps/api/drizzle/0012_item_search_source_updated_at.sql + the item_search block
-- of packages/database/src/utils/sql_scripts/core/create_items.sql); this is the
-- dev/test mirror. Keep the DDL identical.
--
-- item_search.source_updated_at — the source row version that was actually
-- indexed (#122). The sweep decided staleness with
-- `items.updated_at > item_search.indexed_at`, but `indexed_at` is stamped at
-- WRITE time — after a ~200-400ms embedding round trip — while the row version it
-- describes was READ before that. An update committed inside the embed window
-- therefore carries an EARLIER `updated_at` than the index write that overwrote
-- it, so the sweep saw the stale snapshot as newer than the fresh data and never
-- re-selected the row: it stayed wrong permanently.
--
-- Recording the read row's `items.updated_at` makes the check compare VERSIONS
-- instead of clocks, so commit timing cannot fool it. `indexed_at` keeps its own
-- meaning (when the write happened) for the recency sort and freshness monitoring.
-- NULL = indexed before this column existed; the sweep COALESCEs to `indexed_at`.

ALTER TABLE item_search ADD COLUMN IF NOT EXISTS source_updated_at timestamptz;

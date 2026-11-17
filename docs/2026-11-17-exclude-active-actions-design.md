# Search: leave out items that already have an active action

Issue: #223 (design), #224 (build), Story #197.

## Problem

Voice bots search with a profile as the anchor and offer the results to the caller. Some results already have an open action (apply or connect) with that profile. When the caller picks one, Signals-DPG rejects the action with `422 ACTION_LIMIT_REACHED`. Search should be able to leave those items out.

## Rule

An item is left out when Signals-DPG would reject a new action between it and the anchor. Search uses the same rule Signals-DPG uses (`action_pair_cap.ts`):

- **Pair:** the anchor and the result item, in either direction (anchor → item or item → anchor).
- **Open action:** any action type whose status is not closed. Closed = every status outside the `create` group of the interaction's `metric_categories` in `network.json`, plus a fixed list in Signals-DPG code (`accepted`, `completed`, `cancelled`, `rejected`, `declined`, `withdrawn`).
- **Limit:** `max_actions_per_pair` in `network.json`, default 1 when absent. The item is left out when the pair's open actions reach the limit.

Search already loads the same `network.json` (`NETWORK_CONFIG_PATH`), so it reads the limit and statuses from there.

## API change

New optional field in `message.intent` on `POST /v1/search` and `POST /v1/search/flat`:

| Field | Type | Default |
|---|---|---|
| `exclude_active_actions` | boolean | `false` |

```json
"intent": { "item": { "id": "<anchor item_id>" }, "exclude_active_actions": true }
```

- Requires `intent.item.id`. Without an anchor: `400 VALIDATION_ERROR`.
- Response shape is unchanged. Left-out items are missing from `items` and from `total`.
- Requests with the flag on are not cached, so an action taken a moment ago is reflected on the next search.
- Off by default, so existing callers see no change.

## Example

Anchor P1 (a job seeker). Nearby jobs ranked J2, J1, J5, J3, J4.

| Action | Status | Open? |
|---|---|---|
| P1 → J2 apply | `submitted` | yes |
| P1 → J4 apply | `rejected` | no |
| J5 → P1 connect | `invited` | yes |

With `exclude_active_actions: true` and `limit: 3`, the response is J1, J3, J4 with `total: 3`.

## Approaches

Filtering after the search is ruled out: it returns short pages and breaks `offset`. Both approaches below filter inside the query, before `LIMIT`/`OFFSET`.

### Approach 1: look up `item_actions` at search time (recommended)

`item_actions` is in the same database search already reads. The search query first collects the items the anchor has reached the limit with, then excludes them:

```sql
WITH blocked AS (
  SELECT CASE WHEN a.source_item_id = $anchor THEN a.target_item_id ELSE a.source_item_id END AS item_id
  FROM item_actions a
  WHERE a.partition_network = $network
    AND (a.source_item_id = $anchor OR a.target_item_id = $anchor)
    AND a.action_status <> ALL($closed)
  GROUP BY 1
  HAVING count(*) >= $limit
)
... existing search ...
AND s.item_id NOT IN (SELECT item_id FROM blocked)
```

The lookup only reads the anchor's own actions, through the existing `item_actions` source/target indexes.

### Approach 2: store a `blocked_with` list in `item_search`

`item_search` has one row per item, but "blocked" belongs to a pair. The only way to keep it on the row is a list column on both sides of each blocked pair:

```sql
ALTER TABLE item_search ADD COLUMN blocked_with uuid[] NOT NULL DEFAULT '{}';
CREATE INDEX item_search_blocked_with_gin ON item_search USING gin (blocked_with);
```

| item_id | blocked_with |
|---|---|
| P1 | {J2, J5} |
| J2 | {P1} |
| J5 | {P1} |

Search then adds `AND NOT (s.blocked_with @> ARRAY[$anchor])`.

To keep it current, Signals-DPG publishes an event on every action create and status change. The worker counts the pair's open actions in `item_actions` and adds or removes each item from the other's list. The repair sweep also has to fix the lists, and the item re-index must leave the column alone.

A flag or counter per item (`has_active_action`) cannot work: it would hide the item from every searcher, not just the anchor.

### Comparison

| | Approach 1: lookup at search time | Approach 2: `blocked_with` in `item_search` |
|---|---|---|
| Correctness | Always current | Lags behind the worker; a just-applied item can reappear |
| Search cost | One small indexed lookup per request | Slightly less: no extra table |
| Signals-DPG change | None | Publish action events; `item_search` DDL change |
| signals-search change | Query + request field | Column, event handling, pair counting, sweep repair |
| Write cost | None | Every action change rewrites two rows and adds entries to every index, including the vector index |
| Popular items | No effect | Lists grow with every open action |
| Lost events | Not applicable | Wrong results until the sweep repairs them |

**Recommendation: Approach 1.** It is always correct, needs no change in Signals-DPG, and adds only a small indexed lookup. Approach 2 saves that lookup but brings back the stale-result problem this Story is fixing, and adds write load and work in two repos.

## Open questions

1. The fixed closed-status list lives in Signals-DPG code, so search would hold a copy. Should it move into `network.json` instead?
2. Confirm the deployed search service mounts the same `network.json` as Signals-DPG, so `max_actions_per_pair` always matches.
3. Should an action started by the other side (item → anchor) also hide the item? Signals-DPG counts both directions today, and this design assumes the same.

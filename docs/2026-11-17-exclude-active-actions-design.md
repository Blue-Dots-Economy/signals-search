# Search: action filters, latest action and date filters

Issue: #223 (design), #224 (build), Story #197.

## Scope

Voice bots search with a profile as the anchor and offer the results to the caller. This design covers three additions to `POST /v1/search` and `POST /v1/search/flat`:

1. Filter results by the anchor's latest action with each result (for example, leave out jobs already applied to and still pending).
2. Show the anchor's latest action with each result.
3. Filter results by created date and updated date.

Parts 1 and 2 are about the pair (anchor, result), so they need an anchor (`intent.item.id`). A request that uses either without an anchor gets `400 VALIDATION_ERROR`. Part 3 is about the item alone and works with or without an anchor.

All new fields are optional and off by default, so existing callers see no change. They sit inside `message.intent`, so the result cache key covers them.

**Decided in review:** Option A (an action clause in `filters`) for the request shape, and Approach 1 (look up `item_actions` at search time) for where search reads action data. Option B and Approach 2 are kept below as the alternatives considered; either can be revisited if needs change.

## Terms

Every action between two items has a `type` and a `status`. Search also derives a `status_group` from `network.json`.

| Term | Answers | Examples | Source |
|---|---|---|---|
| `type` | What kind of action | `apply`, `connect` | `item_actions.action_type` |
| `status` | Its exact state now | `submitted`, `not_selected`, `invited`, `declined` | `item_actions.action_status` |
| `status_group` | What that state means | `create`, `accept`, `reject`, `cancel` | `metric_categories` in `network.json` |

Each action type has its own status names, so the same meaning can have different names:

| Group | `apply` | `connect` |
|---|---|---|
| `create` (still pending) | `submitted` | `invited` |
| `accept` | `shortlisted` | `accepted` |
| `reject` | `not_selected` | `declined` |
| `cancel` | `withdrawn` | `expired` |

With `status_group`, a bot can say "hide rejected" as `["reject"]` without knowing each network's status names. Search maps a group to its statuses from `network.json` at query time.

The group names are the four `metric_categories` buckets in `network.json`, for example in up-gzb `apply`: `create: [created, submitted]`, `accept: [accepted]`, `reject: [rejected]`, `cancel: [cancelled]`.

- `accept`, `reject` and `cancel` = the statuses in those buckets, across the network's interactions.
- `create` = every status that is not closed, the same rule Signals-DPG uses for its action limit (`action_pair_cap.ts`). Closed = the statuses in the `accept`, `reject` and `cancel` buckets, plus a fixed list in Signals-DPG code (`accepted`, `completed`, `cancelled`, `rejected`, `declined`, `withdrawn`). So `create` covers the `create` bucket, and also interactions that have no buckets.
- Interactions without `metric_categories` (all of yellow_dot, and `provider → provider` connect in blue_dot and purple_dot) only have `create`. Their closed statuses can still be matched by `status`.

**For bot prompts:** use `status_group` for status conditions, since it means the same on every network. Use `status` only where a network has no buckets, or for one exact status. `type` has no group; action types are defined per network, so a bot's prompt lists the types of the network it serves.

Search and Signals-DPG are deployed with the same `network.json`, so both always see the same statuses.

## Requirements and API changes

### 1. Filter by the anchor's latest action

Today, when the caller picks a job they already have a pending action on, Signals-DPG rejects the new action with HTTP `422` and the error `ACTION_LIMIT_REACHED`. The bot should be able to leave such jobs out, and later other cases (for example rejected ones too), without a new API change each time.

**Rules (both options):**

- **Latest action only.** A condition is checked against the pair's most recent action by `created_at`, in either direction (anchor → item or item → anchor), any type. Older actions are ignored: if P1 was not selected for J6 and then re-applied, J6's latest is `submitted`, and "exclude `not_selected`" keeps J6.
- **No action.** A pair with no action never matches a condition. "Exclude" keeps it; "keep only" drops it.
- Filtering happens before `LIMIT`/`OFFSET`, so pages stay full and `total` is correct.
- **Leave out pending actions = exclude `status_group: create`.** With `max_actions_per_pair` = 1 (every network today), this gives exactly the items Signals-DPG would reject. If a network sets a higher limit, search still hides an item on one pending action while Signals-DPG would allow another; this is a known limit.

**Option A: an action clause in `filters` (chosen)**

The existing `filters` list takes an optional `objType`. Without it, a clause filters the item, as today. With `"objType": "action"`, it filters the anchor's latest action with that item.

```json
"intent": {
  "item": { "id": "P1" },
  "filters": [
    { "objType": "action", "op": "not_in", "target": "status_group", "value": ["create", "reject"] },
    { "op": "eq", "target": "item_state.job_type", "value": "full_time" }
  ]
}
```

- `target`: `type`, `status`, `status_group` with `op` `eq`, `neq`, `in`, `not_in` (`not_in` is new, for action clauses only); or `created_at`, `updated_at` with `op` `gte`, `lte` and a value in epoch seconds.
- Several action clauses all apply to the same latest action (AND).
- For a pair with no action, `neq` and `not_in` keep the item; `eq`, `in`, `gte` and `lte` drop it.
- `400 VALIDATION_ERROR` for an action clause without an anchor, another `target`, or another `op`.

**Option B: an `action_filter` block in `intent` (considered)**

A separate block next to `filters`, saying whether matching items are left out or kept.

```json
"intent": {
  "item": { "id": "P1" },
  "action_filter": { "exclude": { "status_group": ["create", "reject"] } },
  "filters": [
    { "op": "eq", "target": "item_state.job_type", "value": "full_time" }
  ]
}
```

- `exclude` leaves out items whose latest action matches. `include` keeps only those. One of the two per request.
- Keys: `type`, `status`, `status_group`, each a list, where any value in the list matches (OR); `created_at`, `updated_at`, each a `{ "gte", "lte" }` range in epoch seconds. Several keys must all match (AND).
- `400 VALIDATION_ERROR` without an anchor, with both `exclude` and `include`, with an empty block, or with an unknown key.

**The same cases in both options:**

| Case | Option A | Option B |
|---|---|---|
| Leave out pending | `{ "objType": "action", "op": "neq", "target": "status_group", "value": "create" }` | `{ "exclude": { "status_group": ["create"] } }` |
| Leave out pending and rejected | `{ "objType": "action", "op": "not_in", "target": "status_group", "value": ["create", "reject"] }` | `{ "exclude": { "status_group": ["create", "reject"] } }` |
| Only my pending applications | `{ "objType": "action", "op": "eq", "target": "status_group", "value": "create" }`, `{ "objType": "action", "op": "eq", "target": "type", "value": "apply" }` | `{ "include": { "status_group": ["create"], "type": ["apply"] } }` |
| Applied in September 2026 | `{ "objType": "action", "op": "eq", "target": "type", "value": "apply" }`, `{ "objType": "action", "op": "gte", "target": "created_at", "value": 1788220800 }`, `{ "objType": "action", "op": "lte", "target": "created_at", "value": 1790812799 }` | `{ "include": { "type": ["apply"], "created_at": { "gte": 1788220800, "lte": 1790812799 } } }` |
| Rejected in September 2026 | `{ "objType": "action", "op": "eq", "target": "status_group", "value": "reject" }`, `{ "objType": "action", "op": "gte", "target": "updated_at", "value": 1788220800 }`, `{ "objType": "action", "op": "lte", "target": "updated_at", "value": 1790812799 }` | `{ "include": { "status_group": ["reject"], "updated_at": { "gte": 1788220800, "lte": 1790812799 } } }` |

| | Option A | Option B |
|---|---|---|
| Where | Inside `filters`, as suggested in review | Own block next to `filters` |
| Reads as | Same `op` words as item filters | `exclude` / `include` say what happens |
| Validation | Allowed `target` and `op` depend on `objType` | Item filters unchanged; the block has its own rules |
| Adding a field later | New `target` value | New key in the block |
| `/v1/search/flat` | `message.intent.filters.0.objType=action` | `message.intent.action_filter.exclude.status_group.0=create` |

**Action dates:** `created_at` is when the action was taken; `updated_at` is when the action last changed, which in practice is its last status change (the same two dates part 2 returns). Ranges follow part 3: epoch seconds, inclusive, either bound optional, `gte` not later than `lte`. They also follow the latest-action rule: "applied in September" still matches after the application is rejected, because a status change does not move `created_at`; "rejected in September" does not match if the user re-applied after it. The bot turns phrases like "2 months ago" into absolute epoch values.

**Response:** shape unchanged. Left-out items are missing from `items` and from `total`.

### 2. Show the anchor's latest action with each result

So the bot can say "you applied here on 18 Nov, it is still pending" or "this one was rejected".

**Request:** `"include_action": true` (boolean, default `false`) inside `message.intent`, next to the anchor.

```json
{
  "context": {
    "version": "1.0.0",
    "messageId": "b1f2c3d4-0001",
    "networkId": "blue_dot",
    "domain": "provider",
    "itemType": "job_posting_1.0"
  },
  "message": {
    "intent": {
      "item": { "id": "11111111-1111-1111-1111-111111111111" },
      "spatial": [{ "op": "s_dwithin", "distanceMeters": 10000 }],
      "include_action": true
    },
    "pagination": { "limit": 5, "offset": 0 }
  }
}
```

`/v1/search/flat`: `"message.intent.include_action": "true"`.

**Response:** each result that has an action with the anchor carries an `action` object, after the existing fields. Results with no action have no `action` field.

```json
{
  "context": { "...": "same as the request" },
  "message": {
    "items": [
      {
        "item_network": "blue_dot",
        "item_domain": "provider",
        "item_type": "job_posting_1.0",
        "item_id": "44444444-4444-4444-4444-444444444444",
        "item_state": { "...": "..." },
        "item_locations": [{ "lat": 28.67, "lng": 77.45 }],
        "item_instance_url": null,
        "item_schema_url": null,
        "created_at": "2026-11-01T08:00:00.000Z",
        "updated_at": "2026-11-05T10:30:00.000Z",
        "created_by": "user-123",
        "lifecycle_status": "live",
        "score": 0.82,
        "distanceMeters": 2300,
        "action": {
          "type": "apply",
          "status": "not_selected",
          "created_at": "2026-11-10T09:12:00Z",
          "updated_at": "2026-11-12T15:40:00Z"
        }
      },
      {
        "item_id": "33333333-3333-3333-3333-333333333333",
        "...": "existing fields, no action field: no action with the anchor"
      }
    ],
    "meta": { "total": 2, "limit": 5, "offset": 0, "sort_applied": "relevance" }
  }
}
```

| Field | Source in `item_actions` |
|---|---|
| `type` | `action_type` |
| `status` | `action_status` |
| `created_at` | `created_at`: when the action was taken |
| `updated_at` | `updated_at`: Signals-DPG sets it on every status update (a same-status update that only edits remarks also moves it) |

- **Latest only**, the same action part 1 filters on. When a new action is taken on the pair (for example a re-apply), it replaces the old one in the response.
- **Any status.** Closed actions such as `not_selected` are shown too.
- **Nothing else is returned.** `remarks` and `requirements_snapshot` can hold personal details and are never included.
- Works together with part 1. For example, with pending items left out, the remaining results show their latest action (such as a past rejection).

### 3. Filter by created date and updated date

**Request:** date ranges on the item's own `created_at` and `updated_at`, inside `message.intent`. Each bound is optional, inclusive, and a whole number of epoch seconds (UTC). They work with or without an anchor.

```json
{
  "context": {
    "version": "1.0.0",
    "messageId": "b1f2c3d4-0002",
    "networkId": "blue_dot",
    "domain": "provider",
    "itemType": "job_posting_1.0"
  },
  "message": {
    "intent": {
      "item": { "id": "11111111-1111-1111-1111-111111111111" },
      "filters": [{ "op": "eq", "target": "item_state.job_type", "value": "full_time" }],
      "created_at": { "gte": 1793491200, "lte": 1795219199 },
      "updated_at": { "gte": 1794700800 }
    },
    "pagination": { "limit": 5, "offset": 0 }
  }
}
```

Here `created_at` is 1 Nov to 20 Nov 2026 and `updated_at` is from 15 Nov 2026.

`/v1/search/flat` takes the same numbers as strings:

```json
{
  "context.messageId": "b1f2c3d4-0002",
  "context.networkId": "blue_dot",
  "context.domain": "provider",
  "context.itemType": "job_posting_1.0",
  "message.intent.item.id": "11111111-1111-1111-1111-111111111111",
  "message.intent.created_at.gte": "1793491200",
  "message.intent.created_at.lte": "1795219199",
  "message.intent.updated_at.gte": "1794700800"
}
```

A value that is not a whole number of seconds (an ISO string, a fraction, a negative number, or milliseconds), or `gte` later than `lte`, returns `400 VALIDATION_ERROR`.

**Response:** shape unchanged. Results already return `created_at` and `updated_at`, in ISO 8601.

These are plain conditions on the `items` table, which search already joins. They do not depend on the approach below.

### Caching

Results are cached for 45 seconds. Requests with an action filter or `include_action` are not cached, so an action taken a moment ago shows on the next search. Date-filter-only requests are cached as today.

## Example

Anchor P1 (a job seeker). Nearby jobs ranked J2, J1, J5, J3, J6, J4.

| Job | P1's actions, oldest first | Latest | Group |
|---|---|---|---|
| J2 | apply `submitted` | apply `submitted` | `create` |
| J1 | none | none | |
| J5 | connect `invited` (from J5) | connect `invited` | `create` |
| J3 | none | none | |
| J6 | apply `not_selected`, apply `submitted` | apply `submitted` | `create` |
| J4 | apply `not_selected` | apply `not_selected` | `reject` |

- Leave out pending: J1, J3, J4, `total: 3`.
- Leave out pending and rejected: J1, J3, `total: 2`.
- Only my pending applications: J2, J6, `total: 2` (J5 is a `connect`).
- `include_action: true` with no filter: all six; J2, J5, J6, J4 carry `action`, J1 and J3 do not.

## Approaches

Filtering after the search is ruled out: it returns short pages and breaks `offset`. Both approaches below work inside the query.

### Approach 1: look up `item_actions` at search time (chosen)

`item_actions` is in the same database search already reads. Before the search, take the anchor's latest action with each partner, then join it:

```sql
WITH latest AS (
  SELECT DISTINCT ON (partner) partner AS item_id, action_type, action_status, created_at, updated_at
  FROM (
    SELECT CASE WHEN source_item_id = $anchor THEN target_item_id ELSE source_item_id END AS partner, *
    FROM item_actions
    WHERE partition_network = $network
      AND (source_item_id = $anchor OR target_item_id = $anchor)
  ) a
  ORDER BY partner, created_at DESC
)
... existing search ...
LEFT JOIN latest l ON l.item_id = s.item_id
WHERE ... AND (l.item_id IS NULL OR l.action_status <> ALL($excluded_statuses))
```

- **Part 1:** the action conditions become `WHERE` conditions on `l` (status, type, `created_at`, `updated_at`), with groups expanded to their statuses.
- **Part 2:** `l` already holds the latest action, so it is returned from the same join.

It reads only the anchor's own actions, through the existing pair indexes, so the cost depends on the anchor's action count, not the corpus size.

### Approach 2: store action data in `item_search` (considered)

`item_search` has one row per item, but actions belong to a pair. So each row keeps the latest action with each partner, on both sides of every pair.

**Column:**

```sql
ALTER TABLE item_search ADD COLUMN latest_actions jsonb NOT NULL DEFAULT '{}';
```

| item_id | latest_actions |
|---|---|
| P1 | { "J2": {apply, submitted, ...}, "J4": {apply, not_selected, ...}, "J5": {connect, invited, ...}, "J6": {apply, submitted, ...} } |
| J4 | { "P1": {apply, not_selected, ...} } |
| J6 | { "P1": {apply, submitted, ...} } |

Each entry is `{type, status, created_at, updated_at}`. Because filters use the latest action only, this one column serves both parts. A flag or counter per item (`has_active_action`) cannot work: it would hide the item from every searcher, not just the anchor. A row per action cannot work either: the table has exactly one row per item, and each row carries the embedding.

**Search:** both parts read only the result row, with no extra table.

- Part 1: conditions on `s.latest_actions -> $anchor` (status, type and the two dates), with groups expanded to their statuses, before `LIMIT`/`OFFSET`.
- Part 2: `s.latest_actions -> $anchor` returned as `action`.

**Keeping it current:**

1. **Action events.** Signals-DPG publishes an event to the existing search stream on every action create and status change, carrying the network and the pair (`source_item_id`, `target_item_id`).
2. **Pair refresh.** For each event the worker reads the pair's latest action from `item_actions` and updates both rows in one transaction. Rows are locked in a fixed order, so two events for the same pair cannot deadlock. The worker recomputes from `item_actions` instead of applying the event, so repeated or out-of-order events are safe.
3. **New rows.** When an item is indexed for the first time, the worker fills the column from `item_actions`, because the item may already have actions (for example made while it was a draft). A re-index leaves the column alone.
4. **Lost events.** The periodic sweep also refreshes every pair with an action created or changed since its previous run.
5. **Deleted items.** When the orphan sweep removes a deleted item's row, it also removes that item from its partners' rows.
6. **Rollout.** A one-time backfill fills the column for all existing pairs, before callers start using the new fields.

**Changes:**

- Signals-DPG: publish action events; add the column to the search DDL it owns (`schema.sql`).
- signals-search: the same column in its local migration and startup schema check; action event handling; first-index fill; sweep and orphan repair; backfill job; query and request/response fields.

### Comparison

| | Approach 1: lookup at search time | Approach 2: copy into `item_search` |
|---|---|---|
| Correctness | Always current | Lags behind the worker; a just-applied item can reappear with a stale status |
| Search cost | One indexed lookup of the anchor's actions per request | Slightly less: no extra table |
| Signals-DPG change | None | Publish action events; `item_search` DDL change |
| signals-search change | Query + request/response fields | Column, event handling, sweep repair, backfill |
| Write cost | None | Every action change rewrites two rows and adds entries to every index, including the vector index |
| Popular items | No effect | Per-row data grows with every partner |
| Lost events | Not applicable | Wrong results until the sweep repairs them |

Part 3 is the same under both.

## Open question

The fixed closed-status list lives only in Signals-DPG code. It covers interactions without `metric_categories`. Search can't read it, so it would hold a copy, and the two can drift apart.

- **Agree a rule:** any new closed status is also added to `network.json`. Search copies today's six and reads everything else from `network.json`. No Signals-DPG change.
- **Move the list into `network.json`:** one list in one place, no copy in search. Needs a small Signals-DPG and schemas change.

Either works for the build. The rule is enough to start, and the move can follow.

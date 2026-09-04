import { z } from 'zod';

export const ContextSchema = z.object({
  version: z.string().default('1.0.0'),
  messageId: z.string().min(1),
  timestamp: z.string().optional(),
  networkId: z.string().min(1),
  domain: z.string().min(1),
  itemType: z.string().min(1),
});

const DwithinClauseSchema = z.object({
  op: z.literal('s_dwithin'),
  // Optional: when omitted, the search center is taken from the anchor item
  // (`intent.item.id`) — "search near this profile's own location". When
  // present, the explicit point is used and the profile's location is ignored.
  geometry: z.object({ type: z.literal('Point'), coordinates: z.tuple([z.number(), z.number()]) }).optional(),
  // Optional: falls back to SEARCH_DEFAULT_DISTANCE_METERS when omitted.
  distanceMeters: z.number().positive().optional(),
});

// A rectangular viewport filter (#644 "search this area"). Exists because a map
// viewport IS a rectangle, and approximating one with its circumscribed circle
// always covers more ground than the map showed — so the list would include
// items the user could not see, which is why the viewport area mode was
// originally dropped from the spec (D6).
//
// All four bounds are REQUIRED: a partial box has no sensible meaning, and
// defaulting the missing side would silently search somewhere the caller did
// not ask for. Ordering is validated in IntentSchema's refine below.
const BboxClauseSchema = z.object({
  op: z.literal('bbox'),
  minLat: z.number().min(-90).max(90),
  minLng: z.number().min(-180).max(180),
  maxLat: z.number().min(-90).max(90),
  maxLng: z.number().min(-180).max(180),
});

// Discriminated on `op`, which — combined with the `.max(1)` on the array below
// — is what makes a radius and a bbox MUTUALLY EXCLUSIVE: supplying both is two
// clauses and is rejected, rather than one silently winning.
const SpatialClauseSchema = z.discriminatedUnion('op', [DwithinClauseSchema, BboxClauseSchema]);

const FilterClauseSchema = z.object({
  op: z.enum(['eq', 'neq', 'in', 'contains', 'contains_any', 'gt', 'gte', 'lt', 'lte']),
  target: z.string().regex(/^item_state\.[A-Za-z0-9_]+$/, 'target must be item_state.<field>'),
  value: z.unknown(),
}).superRefine((f, ctx) => {
  // Numeric comparators must carry a finite number; otherwise Number(value) in the
  // query builder yields NaN and silently matches nothing.
  if (['gt', 'gte', 'lt', 'lte'].includes(f.op) && (typeof f.value !== 'number' || !Number.isFinite(f.value))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `op '${f.op}' requires a finite numeric value`, path: ['value'] });
  }
  // `in` is expanded with Array.prototype.map in the builder, so it must be an array.
  if (f.op === 'in' && !Array.isArray(f.value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `op 'in' requires an array value`, path: ['value'] });
  }
});

// Explicit ordering (#644). ABSENT is meaningful: it preserves the historical
// inferred behaviour (cosine > distance > recency), so existing callers are
// unaffected. See resolveSort in search_route.ts.
export const SortModeSchema = z.enum(['relevance', 'newest', 'nearest']);
export type SortMode = z.infer<typeof SortModeSchema>;

// A centre used ONLY for ordering — it never produces a WHERE predicate.
// Deliberately NOT subject to the anchorless-spatial refine below: an ordering
// centre needs no anchor, because it filters nothing.
const OrderingCenterSchema = z.object({
  type: z.literal('Point'),
  coordinates: z.tuple([z.number(), z.number()]), // GeoJSON order: [lng, lat]
});

export const IntentSchema = z.object({
  textSearch: z.string().min(1).optional(),
  // z.guid(), not z.uuid(): zod 4 tightened .uuid() to enforce the RFC 9562
  // version/variant nibbles, which would reject ids that this API has always
  // accepted (any 8-4-4-4-12 hex string, e.g. '1111...-1111'). z.guid() is zod 4's
  // name for the loose form and preserves the pre-zod-4 contract exactly.
  // Tightening to RFC-conforming ids is a deliberate API change, not a side
  // effect of a dependency bump — see #98.
  item: z.object({ id: z.guid() }).optional(),
  // At most one spatial clause: the search applies a single radius filter
  // (only the first clause was ever consumed), so reject extras explicitly
  // rather than silently ignoring them.
  spatial: z.array(SpatialClauseSchema)
    .max(1, 'at most one spatial clause is supported — a point radius (s_dwithin) and a bbox are mutually exclusive')
    .optional(),
  filters: z.array(FilterClauseSchema).optional(),
  // Both new fields live INSIDE intent, never on `message` beside pagination:
  // cacheKey() hashes {networkId, domain, itemType, intent, pagination}, so
  // placing them here makes the cache key cover them for free. Outside intent,
  // two requests differing only in `sort` would share one cache entry.
  sort: SortModeSchema.optional(),
  orderingCenter: OrderingCenterSchema.optional(),
}).superRefine((intent, ctx) => {
  // An s_dwithin clause without `geometry` derives the search center from the
  // anchor item, so it requires `item.id`. Without an anchor there is no point
  // to search around. A bbox carries its own bounds, so it never needs one.
  const hasAnchorlessSpatial = (intent.spatial ?? []).some((s) => s.op === 's_dwithin' && !s.geometry);
  if (hasAnchorlessSpatial && !intent.item?.id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'a spatial clause without geometry requires intent.item.id (the location is taken from the anchor item)',
      path: ['spatial'],
    });
  }

  // Bbox bounds must be correctly ordered. Rejected rather than normalised: a
  // transposed box is a caller bug, and silently swapping the corners would
  // search an area they did not ask for. A box with minLng > maxLng is how an
  // antimeridian-crossing viewport would arrive — unsupported, and failing
  // loudly is better than returning an empty result set that looks like
  // "nothing here".
  for (const s of intent.spatial ?? []) {
    if (s.op !== 'bbox') continue;
    if (s.minLat >= s.maxLat) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'bbox minLat must be less than maxLat',
        path: ['spatial'],
      });
    }
    if (s.minLng >= s.maxLng) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'bbox minLng must be less than maxLng (a viewport crossing the antimeridian is not supported)',
        path: ['spatial'],
      });
    }
  }
});

export const PaginationSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
}).default({ limit: 20, offset: 0 });

export const SearchRequestSchema = z.object({
  context: ContextSchema,
  message: z.object({ intent: IntentSchema, pagination: PaginationSchema }),
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

// Body shape for POST /v1/search/flat: a flat object of dot-delimited canonical
// paths (numeric segment = array index), values may all be strings. It cannot be
// described by SearchRequestSchema, so the route accepts this permissive record
// and validates against SearchRequestSchema AFTER unflattening + JSON-parsing.
export const FlatSearchRequestSchema = z.record(z.string(), z.unknown());

export const ItemResultSchema = z.object({
  item_network: z.string(),
  item_domain: z.string(),
  item_type: z.string(),
  item_id: z.string(),
  item_state: z.record(z.string(), z.unknown()),
  item_locations: z.array(z.object({ lat: z.number(), lng: z.number(), label: z.string().optional() })),
  item_instance_url: z.string().nullable(),
  item_schema_url: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  created_by: z.string().nullable(),
  lifecycle_status: z.string(),
  score: z.number().optional(),
  distanceMeters: z.number().optional(),
});

export const SearchResponseSchema = z.object({
  context: ContextSchema,
  message: z.object({
    items: z.array(ItemResultSchema),
    meta: z.object({
      total: z.number(),
      limit: z.number(),
      offset: z.number(),
      // Always present: the order actually applied after the contract §1.2
      // fallbacks, so a client can never claim an order it did not get. When
      // the request sent no `sort`, this names whichever inferred path ran.
      sort_applied: SortModeSchema,
    }),
  }),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

// A fully-qualified reference to a single indexed item (its composite PK), with
// the redundant `item_` prefix dropped since the nesting already says "item".
// `network` lives on each ref (not hoisted) so source and target may be in
// different networks — cross-network relevance is a supported use case, gated
// by the cross-network interaction matrix. `id` is a UUID for parity with the
// items table and the anchor lookup in /v1/search.
export const RelevanceRefSchema = z.object({
  network: z.string().min(1),
  domain: z.string().min(1),
  type: z.string().min(1),
  // z.guid() rather than z.uuid() — see the note on IntentSchema.item above.
  id: z.guid(),
});

// POST /v1/relevance body: the two items whose stored embeddings are compared.
// Directional — `source` is the item scored FROM (e.g. the viewer's profile),
// `target` the item scored AGAINST — matching the interaction matrix's from→to.
export const RelevanceRequestSchema = z.object({
  source: RelevanceRefSchema,
  target: RelevanceRefSchema,
});
export type RelevanceRequest = z.infer<typeof RelevanceRequestSchema>;

// POST /v1/relevance response: relevance as a percentage in [0, 100] derived
// from the cosine similarity of the two items' embeddings (higher = more
// similar). Band/confidence/reasoning are intentionally omitted for V1.
export const RelevanceResponseSchema = z.object({
  score: z.number(),
});
export type RelevanceResponse = z.infer<typeof RelevanceResponseSchema>;

export const ErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
});

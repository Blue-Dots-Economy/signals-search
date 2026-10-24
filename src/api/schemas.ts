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
  // When omitted, the centre is the anchor item's stored location.
  geometry: z.object({ type: z.literal('Point'), coordinates: z.tuple([z.number(), z.number()]) }).optional(),
  // Defaults to SEARCH_DEFAULT_DISTANCE_METERS.
  distanceMeters: z.number().positive().optional(),
});

// Viewport filter ("search this area"); a circle around the viewport would
// return items the map does not show. All four bounds are required so a missing
// side is never silently defaulted. Bound order is checked in IntentSchema.
const BboxClauseSchema = z.object({
  op: z.literal('bbox'),
  minLat: z.number().min(-90).max(90),
  minLng: z.number().min(-180).max(180),
  maxLat: z.number().min(-90).max(90),
  maxLng: z.number().min(-180).max(180),
});

// With `.max(1)` on the array below, a radius and a bbox are mutually exclusive.
const SpatialClauseSchema = z.discriminatedUnion('op', [DwithinClauseSchema, BboxClauseSchema]);

const FilterClauseSchema = z.object({
  op: z.enum(['eq', 'neq', 'in', 'contains', 'contains_any', 'gt', 'gte', 'lt', 'lte']),
  target: z.string().regex(/^item_state\.[A-Za-z0-9_]+$/, 'target must be item_state.<field>'),
  value: z.unknown(),
}).superRefine((f, ctx) => {
  // Numeric comparators must carry a finite number; otherwise Number(value) in the
  // query builder yields NaN and silently matches nothing.
  if (['gt', 'gte', 'lt', 'lte'].includes(f.op) && (typeof f.value !== 'number' || !Number.isFinite(f.value))) {
    ctx.addIssue({ code: 'custom', message: `op '${f.op}' requires a finite numeric value`, path: ['value'] });
  }
  // `in` is expanded with Array.prototype.map in the builder, so it must be an array.
  if (f.op === 'in' && !Array.isArray(f.value)) {
    ctx.addIssue({ code: 'custom', message: `op 'in' requires an array value`, path: ['value'] });
  }
});

// Absent selects the inferred ordering (see resolveSort in search_route.ts).
export const SortModeSchema = z.enum(['relevance', 'newest', 'nearest']);
export type SortMode = z.infer<typeof SortModeSchema>;

// Used only for ordering, never as a WHERE predicate, so it needs no anchor.
const OrderingCenterSchema = z.object({
  type: z.literal('Point'),
  coordinates: z.tuple([z.number(), z.number()]), // GeoJSON order: [lng, lat]
});

export const IntentSchema = z.object({
  textSearch: z.string().min(1).optional(),
  // z.guid(), not z.uuid(): zod 4's .uuid() enforces RFC 9562 version/variant
  // nibbles and would reject accepted ids like '1111...-1111'. Tightening this
  // is an API change.
  item: z.object({ id: z.guid() }).optional(),
  // The search applies one spatial clause, so extras are rejected, not ignored.
  spatial: z.array(SpatialClauseSchema)
    .max(1, 'at most one spatial clause is supported — a point radius (s_dwithin) and a bbox are mutually exclusive')
    .optional(),
  filters: z.array(FilterClauseSchema).optional(),
  // sort and orderingCenter must stay inside intent so cacheKey() covers them;
  // elsewhere, requests differing only in `sort` would share a cache entry.
  sort: SortModeSchema.optional(),
  orderingCenter: OrderingCenterSchema.optional(),
}).superRefine((intent, ctx) => {
  // An s_dwithin clause without geometry takes its centre from the anchor, so it
  // requires item.id. A bbox carries its own bounds.
  const hasAnchorlessSpatial = (intent.spatial ?? []).some((s) => s.op === 's_dwithin' && !s.geometry);
  if (hasAnchorlessSpatial && !intent.item?.id) {
    ctx.addIssue({
      code: 'custom',
      message: 'a spatial clause without geometry requires intent.item.id (the location is taken from the anchor item)',
      path: ['spatial'],
    });
  }

  // Misordered bounds are rejected, not swapped: swapping would search an area
  // the caller did not ask for. minLng > maxLng is an antimeridian-crossing
  // viewport, which is unsupported and would otherwise return an empty page.
  for (const s of intent.spatial ?? []) {
    if (s.op !== 'bbox') continue;
    if (s.minLat >= s.maxLat) {
      ctx.addIssue({
        code: 'custom',
        message: 'bbox minLat must be less than maxLat',
        path: ['spatial'],
      });
    }
    if (s.minLng >= s.maxLng) {
      ctx.addIssue({
        code: 'custom',
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

// POST /v1/search/flat body: a flat record of dot-delimited paths, validated
// against SearchRequestSchema after unflattening.
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
      // The order actually applied, after any degradation or inference.
      sort_applied: SortModeSchema,
    }),
  }),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

// A reference to one indexed item (its composite PK). `network` is per ref
// because source and target may be in different networks, gated by the
// cross-network interaction matrix.
export const RelevanceRefSchema = z.object({
  network: z.string().min(1),
  domain: z.string().min(1),
  type: z.string().min(1),
  // z.guid(), not z.uuid(): see IntentSchema.item.
  id: z.guid(),
});

// POST /v1/relevance body. Directional: `source` (e.g. the viewer's profile) is
// scored against `target`, matching the interaction matrix's from→to.
export const RelevanceRequestSchema = z.object({
  source: RelevanceRefSchema,
  target: RelevanceRefSchema,
});
export type RelevanceRequest = z.infer<typeof RelevanceRequestSchema>;

// POST /v1/relevance response: cosine similarity of the two embeddings as a
// percentage in [0, 100].
export const RelevanceResponseSchema = z.object({
  score: z.number(),
});
export type RelevanceResponse = z.infer<typeof RelevanceResponseSchema>;

export const ErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
});

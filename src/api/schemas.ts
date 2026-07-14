import { z } from 'zod';

export const ContextSchema = z.object({
  version: z.string().default('1.0.0'),
  messageId: z.string().min(1),
  timestamp: z.string().optional(),
  networkId: z.string().min(1),
  domain: z.string().min(1),
  itemType: z.string().min(1),
});

const SpatialClauseSchema = z.object({
  op: z.literal('s_dwithin'),
  // Optional: when omitted, the search center is taken from the anchor item
  // (`intent.item.id`) — "search near this profile's own location". When
  // present, the explicit point is used and the profile's location is ignored.
  geometry: z.object({ type: z.literal('Point'), coordinates: z.tuple([z.number(), z.number()]) }).optional(),
  // Optional: falls back to SEARCH_DEFAULT_DISTANCE_METERS when omitted.
  distanceMeters: z.number().positive().optional(),
});

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

export const IntentSchema = z.object({
  textSearch: z.string().min(1).optional(),
  item: z.object({ id: z.string().uuid() }).optional(),
  // At most one spatial clause: the search applies a single radius filter
  // (only the first clause was ever consumed), so reject extras explicitly
  // rather than silently ignoring them.
  spatial: z.array(SpatialClauseSchema).max(1, 'at most one spatial clause is supported').optional(),
  filters: z.array(FilterClauseSchema).optional(),
}).superRefine((intent, ctx) => {
  // A spatial clause without `geometry` derives the search center from the
  // anchor item, so it requires `item.id`. Without an anchor there is no point
  // to search around.
  const hasAnchorlessSpatial = (intent.spatial ?? []).some((s) => !s.geometry);
  if (hasAnchorlessSpatial && !intent.item?.id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'a spatial clause without geometry requires intent.item.id (the location is taken from the anchor item)',
      path: ['spatial'],
    });
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
  score: z.number().optional(),
  distanceMeters: z.number().optional(),
});

export const SearchResponseSchema = z.object({
  context: ContextSchema,
  message: z.object({
    items: z.array(ItemResultSchema),
    meta: z.object({ total: z.number(), limit: z.number(), offset: z.number() }),
  }),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const ErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
});

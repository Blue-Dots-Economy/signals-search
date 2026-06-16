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
  geometry: z.object({ type: z.literal('Point'), coordinates: z.tuple([z.number(), z.number()]) }),
  distanceMeters: z.number().positive(),
});

const FilterClauseSchema = z.object({
  op: z.enum(['eq', 'neq', 'in', 'contains', 'gt', 'gte', 'lt', 'lte']),
  target: z.string().regex(/^item_state\.[A-Za-z0-9_]+$/, 'target must be item_state.<field>'),
  value: z.unknown(),
});

export const IntentSchema = z.object({
  textSearch: z.string().min(1).optional(),
  item: z.object({ id: z.string().uuid() }).optional(),
  spatial: z.array(SpatialClauseSchema).optional(),
  filters: z.array(FilterClauseSchema).optional(),
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

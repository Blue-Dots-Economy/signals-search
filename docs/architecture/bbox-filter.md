# Bounding-box (viewport) filter

Code: `buildWhere` in `src/db/search_query.ts` (the `p.bbox` branch).

A `bbox` spatial clause ("search this area") is applied as two ANDed predicates:

```sql
s.geo && ST_MakeEnvelope(...)::geography                 -- index prefilter
AND ST_Intersects(s.geo::geometry, ST_MakeEnvelope(...))  -- exact, planar
```

## Why the exact test is planar

A map viewport is a lat/lng rectangle. A geography polygon's edges are geodesics: the arc joining two corners at the same latitude bows toward the pole, so the polygon is shifted north of the rectangle the user saw. On a 0.1° x 0.2° box at 12.9°N, a pin exactly on the southern edge fell about 2 m outside the geography polygon and was dropped, while a pin just north of the top edge was included. That is the same class of error (the list disagreeing with the map) that rules out approximating the viewport with its circumscribed circle. The planar test is correct at any box size and is boundary-inclusive.

## Why the geography prefilter exists

The geometry cast in the exact test defeats the `item_search_geo_gist` index. The geography `&&` prefilter keeps it in play, and because the geodetic box strictly contains the planar rectangle it never excludes a row the exact test would keep. Measured on 20 000 geo rows:

| predicate | plan | time |
| --- | --- | --- |
| prefilter + exact | Index Scan using `item_search_geo_gist` | 0.261 ms |
| exact alone | double Seq Scan | 240.8 ms |
| `ST_DWithin` radius (for comparison) | Bitmap Index Scan, same index | 38.6 ms |

## Why the prefilter is skipped for boxes spanning 180° or more

A geography polygon's edges follow the shorter great-circle arc. An envelope wider than 180° is read as going the other way round the globe and becomes its own complement, so the prefilter excludes everything and the ANDed query returns nothing. An envelope edge whose endpoints are exactly antipodal makes the `::geography` cast throw `Antipodal (180 degrees long) edge detected!`, which surfaces as a 500.

Measured with a point at 12.9°N, 77.6°E inside every box:

| box | prefilter | exact planar |
| --- | --- | --- |
| lng span up to 180° | matches | matches |
| lng span 180.002° and wider | no match | matches |
| lat span exactly 180° (pole to pole) | throws | matches |
| lng span 180° with an edge on the equator | throws | matches |

The prefilter is therefore applied only when both spans are strictly under 180°, which excludes every failing case and leaves realistic viewports untouched. A box that wide selects almost everything, so losing index acceleration there costs little.

A bbox contributes no ordering centre. A caller that wants nearest-first within a viewport sends `intent.orderingCenter` alongside it.

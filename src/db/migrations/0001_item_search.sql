-- NOTE: authoritative copy lives in Signals-DPG schema.sql (Plan 3); this is the dev/test mirror.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS item_search (
  item_network    text NOT NULL,
  item_domain     text NOT NULL,
  item_type       text NOT NULL,
  item_id         uuid NOT NULL,
  embedding       vector(1024),
  geo             geography(MultiPoint, 4326),
  lifecycle_status text NOT NULL DEFAULT 'draft',
  model_version   text,
  content_hash    text,
  indexed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_network, item_domain, item_type, item_id)
);

CREATE INDEX IF NOT EXISTS item_search_embedding_hnsw
  ON item_search USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS item_search_geo_gist
  ON item_search USING gist (geo);
CREATE INDEX IF NOT EXISTS item_search_live
  ON item_search (item_network, item_domain, item_type) WHERE lifecycle_status = 'live';

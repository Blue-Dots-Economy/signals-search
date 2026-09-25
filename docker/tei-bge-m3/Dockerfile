# TEI (text-embeddings-inference) with BAAI/bge-m3 baked into the image, so the
# pod never downloads the ~2.3 GB model at runtime (fast restarts, no HuggingFace
# dependency / rate-limit in the cluster). Lives here because the embedding model
# + dimension (1024, see src/db/item_search_repo.ts / EMBEDDING_DIM) is this
# service's contract; the bluedots-automation chart just references the image.
#
# The model revision is PINNED for reproducibility — bump it deliberately, in
# lockstep with the chart's embeddings.revision. The chart passes
# `--revision <BGE_M3_REVISION>` to TEI (it loads the baked snapshots/<rev> with
# HF_HUB_OFFLINE=1; without a matching --revision, TEI would try to resolve
# "main" offline and fail).
ARG BGE_M3_REVISION=5617a9f61b028005a4858fdac845db406aefb181

FROM python:3.14-slim AS dl
ARG BGE_M3_REVISION
RUN pip install --no-cache-dir "huggingface_hub[hf_transfer]"
ENV HF_HUB_ENABLE_HF_TRANSFER=1
# Whole-repo download (config, tokenizer, onnx/ + safetensors) into the HF cache
# layout. Use the stable snapshot_download API rather than the CLI, whose flags
# churn across huggingface_hub versions (the huggingface-cli -> hf rename broke
# `huggingface-cli download --cache-dir`).
#
# TEI's cache lookup (hf-hub crate, CacheRepo::get) does NOT check
# snapshots/<revision>/<file> directly — it first reads refs/<revision> to
# resolve a commit hash, then looks in snapshots/<that hash>/<file>. When
# revision is already a full commit SHA (our case, for reproducibility),
# snapshot_download has no reason to write that refs/ pointer — a SHA needs no
# resolving. Without it, EVERY file TEI's download_artifacts() asks for
# (config.json, tokenizer.json, sentence_bert_config.json, ...) is a cache
# miss, so it re-fetches all of them from huggingface.co on every pod start —
# fully defeating the "bake it in, run offline" point of this whole image, and
# fatal on a network with no route there. Write it explicitly so the cache
# lookup succeeds and nothing here ever touches the network at runtime.
RUN python -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='BAAI/bge-m3', revision='${BGE_M3_REVISION}', cache_dir='/hf')" \
 && mkdir -p "/hf/models--BAAI--bge-m3/refs" \
 && printf '%s' "${BGE_M3_REVISION}" > "/hf/models--BAAI--bge-m3/refs/${BGE_M3_REVISION}" \
 && chmod -R a+rX /hf

FROM ghcr.io/huggingface/text-embeddings-inference:cpu-1.9
# Populate TEI's huggingface_hub_cache (/data) and run fully offline.
COPY --from=dl /hf /data
ENV HF_HUB_OFFLINE=1

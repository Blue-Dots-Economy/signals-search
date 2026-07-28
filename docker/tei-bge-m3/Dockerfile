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
RUN python -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='BAAI/bge-m3', revision='${BGE_M3_REVISION}', cache_dir='/hf')" \
 && chmod -R a+rX /hf

FROM ghcr.io/huggingface/text-embeddings-inference:cpu-1.7
# Populate TEI's huggingface_hub_cache (/data) and run fully offline.
COPY --from=dl /hf /data
ENV HF_HUB_OFFLINE=1

FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV EMBEDDING_PROVIDER=transformers
ENV EMBEDDING_MODEL=onnx-community/Qwen3-Embedding-0.6B-ONNX
ENV EMBEDDING_DTYPE=q8
ENV EMBEDDING_DIMENSIONS=1024
ENV EMBEDDING_CACHE_DIR=/app/data/models/transformers
ARG WARM_EMBEDDING_MODEL=false

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile
RUN if [ "$WARM_EMBEDDING_MODEL" = "true" ]; then pnpm orca:warm-embeddings; fi
RUN pnpm build

EXPOSE 4010

CMD ["pnpm", "start:worker"]

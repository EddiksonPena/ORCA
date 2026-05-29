FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ARG WARM_EMBEDDING_MODEL=false

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile
RUN if [ "$WARM_EMBEDDING_MODEL" = "true" ]; then pnpm orca:warm-embeddings; fi
RUN pnpm build

EXPOSE 4030

CMD ["pnpm", "start:proxy"]

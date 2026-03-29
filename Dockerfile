# Stage 1: Build Next.js static export
FROM node:22-alpine AS frontend
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# Stage 2: Build Rust server binary
FROM rust:1.82-bookworm AS backend
WORKDIR /app
COPY src-tauri/ ./src-tauri/
WORKDIR /app/src-tauri
RUN cargo build --release --bin codeg-server --no-default-features

# Stage 3: Runtime
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y \
    libsqlite3-0 \
    git \
    openssh-client \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=backend /app/src-tauri/target/release/codeg-server /usr/local/bin/codeg-server
COPY --from=frontend /app/out /app/web

ENV CODEG_STATIC_DIR=/app/web
ENV CODEG_DATA_DIR=/data
ENV CODEG_PORT=3080
ENV CODEG_HOST=0.0.0.0

EXPOSE 3080
VOLUME /data

CMD ["codeg-server"]

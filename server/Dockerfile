# Verlaut Server — reproduzierbarer Multi-Stage-Build.
# WICHTIG: sqlx-Queries sind compile-time-checked. Für den Build ohne laufende
# DB muss VORHER `cargo sqlx prepare` gelaufen sein (erzeugt ./.sqlx), damit
# SQLX_OFFLINE=true greift. Siehe deploy/README.md.

# Neuere Rust-Toolchain: libsignal benötigt einen aktuellen Compiler.
FROM rust:1-slim-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
        protobuf-compiler pkg-config \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build

# Abhängigkeiten separat cachen.
COPY server/Cargo.toml server/Cargo.lock* ./server/
COPY shared ./shared
# Quellcode + committete Offline-Query-Daten.
COPY server ./server
ENV SQLX_OFFLINE=true
WORKDIR /build/server
RUN cargo build --release --locked

# ---- Runtime: minimal, non-root ----
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -r -u 10001 verlaut
COPY --from=builder /build/server/target/release/verlaut-server /usr/local/bin/verlaut-server
USER verlaut
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/verlaut-server"]

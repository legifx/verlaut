//! Verlaut Server — dummer, metadatensparsamer Relay.
//!
//! Der Server transportiert opake Envelopes, verwaltet PreKey-Bundles und
//! prüft Signaturen. Er sieht keinen Klartext und persistiert keine
//! Kontaktbeziehungen.

mod accounts;
mod config;
mod error;
mod hub;
mod prekeys;
mod proto;
mod push;
mod queue;
mod state;
mod ws;

use std::sync::Arc;
use std::time::Duration;

use axum::http::{header, HeaderValue};
use axum::routing::{get, post};
use axum::Router;
use sqlx::postgres::PgPoolOptions;
use tower_http::cors::CorsLayer;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

/// Harte Content-Security-Policy: alles nur von der eigenen Origin.
/// `wasm-unsafe-eval` ist nötig, um das libsignal-WASM zu instanziieren.
/// Keine externen CDNs, kein inline-Script.
/// `blob:` in img-src/media-src erlaubt die Anzeige/Wiedergabe lokal
/// entschlüsselter Bilder und Sprachnachrichten (Object-URLs aus Blobs) —
/// weiterhin keine externe Herkunft, nur gerätelokale Daten.
const CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; \
    style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; \
    media-src 'self' blob: data:; connect-src 'self'; \
    worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

use crate::config::Config;
use crate::hub::Hub;
use crate::state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Logging: konfigurierbar über RUST_LOG, KEINE Nutzinhalte im Log.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cfg = Config::from_env()?;

    let pg = PgPoolOptions::new()
        .max_connections(16)
        .connect(&cfg.database_url)
        .await?;
    sqlx::migrate!("./migrations").run(&pg).await?;

    let redis_client = redis::Client::open(cfg.redis_url.clone())?;
    let redis = redis::aio::ConnectionManager::new(redis_client).await?;

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()?;

    let state = AppState {
        cfg: cfg.clone(),
        pg,
        redis,
        http,
        hub: Arc::new(Hub::default()),
    };

    // TTL-Reaper: löscht abgelaufene Offline-Envelopes stündlich.
    {
        let state = state.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(3600));
            loop {
                tick.tick().await;
                match queue::reap_expired(&state).await {
                    Ok(n) if n > 0 => tracing::info!(deleted = n, "TTL-Reaper"),
                    Ok(_) => {}
                    Err(e) => tracing::warn!(error = %e, "Reaper-Fehler"),
                }
            }
        });
    }

    // CORS: `*` erlaubt jede Origin (sinnvoll im tailnet-only Betrieb, wo
    // Tailscale die Zugangskontrolle ist). Sonst strikt die eine Origin.
    let allow_origin = if cfg.allowed_origin.trim() == "*" {
        tower_http::cors::AllowOrigin::any()
    } else {
        tower_http::cors::AllowOrigin::exact(
            cfg.allowed_origin
                .parse::<axum::http::HeaderValue>()
                .map_err(|_| anyhow::anyhow!("VERLAUT_ALLOWED_ORIGIN ist keine gültige Origin"))?,
        )
    };
    let cors = CorsLayer::new()
        .allow_origin(allow_origin)
        .allow_methods([axum::http::Method::GET, axum::http::Method::POST])
        .allow_headers([
            axum::http::header::CONTENT_TYPE,
            axum::http::HeaderName::from_static("x-identity-key"),
            axum::http::HeaderName::from_static("x-auth-nonce"),
            axum::http::HeaderName::from_static("x-auth-signature"),
        ]);

    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/v1/auth/challenge", post(accounts::challenge))
        .route("/v1/accounts/register", post(accounts::register))
        .route("/v1/accounts/username", post(accounts::claim_username))
        .route("/v1/accounts/resolve/{username}", get(accounts::resolve_username))
        .route("/v1/directory", get(accounts::directory))
        .route("/v1/prekeys", post(prekeys::replenish))
        .route("/v1/prekeys/{username}", get(prekeys::fetch_by_username))
        .route("/v1/prekeys/key/{key}", get(prekeys::fetch_by_key))
        .route("/v1/ws", get(ws::ws_handler))
        .layer(RequestBodyLimitLayer::new(256 * 1024))
        .layer(cors)
        .with_state(state);

    // Gebaute PWA statisch ausliefern (SPA-Fallback auf index.html).
    let mut app = app;
    if !cfg.static_dir.is_empty() {
        let index = format!("{}/index.html", cfg.static_dir.trim_end_matches('/'));
        let serve = ServeDir::new(&cfg.static_dir).fallback(ServeFile::new(index));
        app = app.fallback_service(serve);
        tracing::info!(dir = %cfg.static_dir, "PWA wird ausgeliefert");
    }
    // Harte CSP auf alle Antworten.
    let app = app.layer(SetResponseHeaderLayer::overriding(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CSP),
    ));

    let listener = tokio::net::TcpListener::bind(&cfg.bind_addr).await?;
    tracing::info!(addr = %cfg.bind_addr, "Verlaut Server läuft");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("Shutdown");
}

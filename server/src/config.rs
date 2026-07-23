//! Konfiguration ausschließlich über ENV. Keine Secrets im Code, keine Defaults
//! für Geheimnisse. Siehe `.env.example`.

use std::time::Duration;

#[derive(Clone, Debug)]
pub struct Config {
    pub bind_addr: String,
    pub database_url: String,
    pub redis_url: String,
    pub ntfy_base_url: String,
    /// Erlaubte WS/HTTP-Origin (CORS + WS-Origin-Check). Strikt.
    pub allowed_origin: String,
    /// Maximale Envelope-Größe in Bytes (Schutz vor Ballast).
    pub max_envelope_bytes: usize,
    /// TTL für offline gepufferte Envelopes.
    pub offline_ttl: Duration,
    /// Lebensdauer einer Auth-Nonce.
    pub nonce_ttl: Duration,
    /// Verzeichnis der gebauten PWA (statische Auslieferung). Leer = keine.
    pub static_dir: String,
    /// Öffentliches Nutzer-Directory (`GET /v1/directory`). Für kleine private
    /// Deployments praktisch (alle Nutzer sehen). Privacy-Maximalisten setzen
    /// `VERLAUT_DIRECTORY_ENABLED=false` -> Endpoint liefert 404.
    pub directory_enabled: bool,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        fn req(key: &str) -> anyhow::Result<String> {
            std::env::var(key).map_err(|_| anyhow::anyhow!("ENV {key} fehlt"))
        }
        fn opt(key: &str, default: &str) -> String {
            std::env::var(key).unwrap_or_else(|_| default.to_string())
        }

        Ok(Self {
            bind_addr: opt("VERLAUT_BIND", "0.0.0.0:8080"),
            database_url: req("DATABASE_URL")?,
            redis_url: req("REDIS_URL")?,
            ntfy_base_url: opt("NTFY_BASE_URL", "http://ntfy:80"),
            allowed_origin: req("VERLAUT_ALLOWED_ORIGIN")?,
            max_envelope_bytes: opt("VERLAUT_MAX_ENVELOPE_BYTES", "65536")
                .parse()
                .unwrap_or(65_536),
            offline_ttl: Duration::from_secs(30 * 24 * 60 * 60), // 30 Tage
            nonce_ttl: Duration::from_secs(30),
            static_dir: opt("VERLAUT_STATIC_DIR", ""),
            directory_enabled: opt("VERLAUT_DIRECTORY_ENABLED", "true") != "false",
        })
    }
}

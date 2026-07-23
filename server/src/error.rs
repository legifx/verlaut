//! Zentrale Fehlertypen. WICHTIG: Fehlertexte enthalten NIE Klartext-Inhalte
//! oder Kontaktbeziehungen. Nach außen wird bewusst wenig verraten.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("unauthenticated")]
    Unauthenticated,

    #[error("bad request")]
    BadRequest,

    #[error("not found")]
    NotFound,

    #[error("conflict")]
    Conflict,

    #[error("payload too large")]
    PayloadTooLarge,

    #[allow(dead_code)] // wird in Phase 2 (tower-governor) konstruiert
    #[error("rate limited")]
    RateLimited,

    /// Interne Fehler werden geloggt (ohne sensible Daten), nach außen generisch.
    #[error("internal error")]
    Internal(#[from] anyhow::Error),
}

impl AppError {
    fn status(&self) -> StatusCode {
        match self {
            AppError::Unauthenticated => StatusCode::UNAUTHORIZED,
            AppError::BadRequest => StatusCode::BAD_REQUEST,
            AppError::NotFound => StatusCode::NOT_FOUND,
            AppError::Conflict => StatusCode::CONFLICT,
            AppError::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            AppError::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            AppError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        // Interne Details nur ins Log (ohne Nutzinhalt), Client bekommt generisch.
        if let AppError::Internal(ref e) = self {
            tracing::error!(error = %e, "interner Fehler");
        }
        (self.status(), self.to_string()).into_response()
    }
}

// sqlx-Fehler generisch mappen, ohne Query-Details nach außen zu geben.
impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        match e {
            sqlx::Error::RowNotFound => AppError::NotFound,
            other => AppError::Internal(other.into()),
        }
    }
}

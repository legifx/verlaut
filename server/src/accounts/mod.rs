//! Accounts + Auth.
//!
//! - Identität = Ed25519 Public Key (32 Byte). Kein Passwort, keine PII.
//! - Auth = Signatur-Challenge: Server gibt Nonce (ephemer in Redis), Client
//!   signiert sie mit dem Identity Private Key.
//! - Nonce ist single-use (GETDEL) und kurzlebig.

use axum::extract::{Path, State};
use axum::http::request::Parts;
use axum::http::HeaderMap;
use axum::{extract::FromRequestParts, Json};
use libsignal_core::curve::PublicKey;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

use crate::error::AppError;
use crate::state::AppState;

const NONCE_LEN: usize = 32;
/// libsignal IdentityKey: 33 Byte (0x05-Typ-Prefix + 32 Byte Curve25519).
const IDENTITY_LEN: usize = 33;

fn nonce_key(identity_key: &[u8]) -> Vec<u8> {
    let mut k = b"verlaut:nonce:".to_vec();
    k.extend_from_slice(identity_key);
    k
}

/// Verifikation einer libsignal-XEdDSA-Signatur über `msg` mit dem
/// serialisierten Identity Public Key (33 Byte). Dieselbe Funktion wie im
/// Client (`libsignal_core`), daher exakt kompatibel. XEdDSA ist selbst
/// konstante-Zeit.
pub fn verify_signature(identity_key: &[u8], msg: &[u8], signature: &[u8]) -> bool {
    match PublicKey::deserialize(identity_key) {
        Ok(pk) => pk.verify_signature(msg, signature),
        Err(_) => false,
    }
}

/// Erzeugt eine Nonce, legt sie kurzlebig in Redis ab und gibt sie zurück.
pub async fn issue_challenge(
    state: &AppState,
    identity_key: &[u8],
) -> Result<Vec<u8>, AppError> {
    if identity_key.len() != IDENTITY_LEN {
        return Err(AppError::BadRequest);
    }
    let mut nonce = vec![0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce);

    let ttl = state.cfg.nonce_ttl.as_secs() as i64;
    let mut redis = state.redis();
    redis::cmd("SET")
        .arg(nonce_key(identity_key))
        .arg(&nonce)
        .arg("EX")
        .arg(ttl)
        .query_async::<()>(&mut redis)
        .await
        .map_err(|e| AppError::Internal(e.into()))?;
    Ok(nonce)
}

/// Prüft eine Challenge-Antwort: Nonce muss existieren, passen und die
/// Signatur muss gültig sein. Nonce wird atomar konsumiert (single-use).
pub async fn verify_challenge(
    state: &AppState,
    identity_key: &[u8],
    presented_nonce: &[u8],
    signature: &[u8],
) -> Result<(), AppError> {
    if identity_key.len() != IDENTITY_LEN {
        return Err(AppError::Unauthenticated);
    }
    let mut redis = state.redis();
    // GETDEL: atomar lesen + löschen -> Nonce ist danach verbraucht.
    let stored: Option<Vec<u8>> = redis::cmd("GETDEL")
        .arg(nonce_key(identity_key))
        .query_async(&mut redis)
        .await
        .map_err(|e| AppError::Internal(e.into()))?;

    let Some(stored) = stored else {
        return Err(AppError::Unauthenticated);
    };
    // Konstante Zeit: Nonce-Gleichheit.
    if stored.len() != presented_nonce.len()
        || stored.ct_eq(presented_nonce).unwrap_u8() != 1
    {
        return Err(AppError::Unauthenticated);
    }
    if !verify_signature(identity_key, &stored, signature) {
        return Err(AppError::Unauthenticated);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Axum-Extractor: authentifizierte Identität aus signierten Headern.
//   X-Identity-Key: base64(identity pub)
//   X-Auth-Nonce:   base64(nonce)  (zuvor via /v1/auth/challenge geholt)
//   X-Auth-Signature: base64(ed25519 sig über nonce)
// ---------------------------------------------------------------------------

pub struct AuthedIdentity(pub Vec<u8>);

fn header_b64(headers: &HeaderMap, name: &str) -> Result<Vec<u8>, AppError> {
    let raw = headers.get(name).ok_or(AppError::Unauthenticated)?;
    let s = raw.to_str().map_err(|_| AppError::Unauthenticated)?;
    b64_decode(s).ok_or(AppError::Unauthenticated)
}

impl FromRequestParts<AppState> for AuthedIdentity {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let identity = header_b64(&parts.headers, "x-identity-key")?;
        let nonce = header_b64(&parts.headers, "x-auth-nonce")?;
        let signature = header_b64(&parts.headers, "x-auth-signature")?;
        verify_challenge(state, &identity, &nonce, &signature).await?;
        Ok(AuthedIdentity(identity))
    }
}

// ---------------------------------------------------------------------------
// REST-Handler
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ChallengeReq {
    pub identity_key: String, // base64
}
#[derive(Serialize)]
pub struct ChallengeResp {
    pub nonce: String,      // base64
    pub expires_in: u64,    // Sekunden
}

/// POST /v1/auth/challenge
pub async fn challenge(
    State(state): State<AppState>,
    Json(req): Json<ChallengeReq>,
) -> Result<Json<ChallengeResp>, AppError> {
    let identity = b64_decode(&req.identity_key).ok_or(AppError::BadRequest)?;
    let nonce = issue_challenge(&state, &identity).await?;
    Ok(Json(ChallengeResp {
        nonce: b64_encode(&nonce),
        expires_in: state.cfg.nonce_ttl.as_secs(),
    }))
}

#[derive(Deserialize)]
pub struct RegisterReq {
    pub identity_key: String,              // base64
    pub registration_id: i32,              // libsignal Registration-ID
    pub signed_prekey: SignedPreKeyJson,
    /// Signierter Kyber-1024-PreKey (PQXDH, zwingend).
    pub kyber_prekey: SignedPreKeyJson,
    pub one_time_prekeys: Vec<OneTimePreKeyJson>,
}
#[derive(Deserialize)]
pub struct SignedPreKeyJson {
    pub key_id: i32,
    pub public_key: String, // base64
    pub signature: String,  // base64 (Ed25519 über public_key)
}
#[derive(Deserialize)]
pub struct OneTimePreKeyJson {
    pub key_id: i32,
    pub public_key: String, // base64
}

/// POST /v1/accounts/register
/// Anlegen/Upsert eines Accounts + initiales PreKey-Material.
/// Die Signed-PreKey-Signatur wird gegen den Identity Key geprüft.
pub async fn register(
    State(state): State<AppState>,
    Json(req): Json<RegisterReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    let identity = b64_decode(&req.identity_key).ok_or(AppError::BadRequest)?;
    if identity.len() != IDENTITY_LEN {
        return Err(AppError::BadRequest);
    }
    let spk_pub = b64_decode(&req.signed_prekey.public_key).ok_or(AppError::BadRequest)?;
    let spk_sig = b64_decode(&req.signed_prekey.signature).ok_or(AppError::BadRequest)?;
    // Der Server prüft, dass der Signed PreKey wirklich vom Identity Key
    // signiert wurde — verhindert untergeschobenes Schlüsselmaterial.
    if !verify_signature(&identity, &spk_pub, &spk_sig) {
        return Err(AppError::BadRequest);
    }

    // Kyber-PreKey (PQXDH) ebenso gegen den Identity Key prüfen.
    let kyber_pub = b64_decode(&req.kyber_prekey.public_key).ok_or(AppError::BadRequest)?;
    let kyber_sig = b64_decode(&req.kyber_prekey.signature).ok_or(AppError::BadRequest)?;
    if !verify_signature(&identity, &kyber_pub, &kyber_sig) {
        return Err(AppError::BadRequest);
    }

    let mut tx = state.pg.begin().await?;
    sqlx::query!(
        "INSERT INTO accounts (identity_key, registration_id) VALUES ($1, $2)
         ON CONFLICT (identity_key) DO UPDATE
           SET registration_id = EXCLUDED.registration_id, updated_at = now()",
        &identity,
        req.registration_id
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query!(
        "INSERT INTO signed_prekeys (identity_key, key_id, public_key, signature)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (identity_key) DO UPDATE
           SET key_id = EXCLUDED.key_id,
               public_key = EXCLUDED.public_key,
               signature = EXCLUDED.signature,
               updated_at = now()",
        &identity,
        req.signed_prekey.key_id,
        &spk_pub,
        &spk_sig
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query!(
        "INSERT INTO kyber_prekeys (identity_key, key_id, public_key, signature)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (identity_key) DO UPDATE
           SET key_id = EXCLUDED.key_id,
               public_key = EXCLUDED.public_key,
               signature = EXCLUDED.signature,
               updated_at = now()",
        &identity,
        req.kyber_prekey.key_id,
        &kyber_pub,
        &kyber_sig
    )
    .execute(&mut *tx)
    .await?;

    for otpk in &req.one_time_prekeys {
        let pk = b64_decode(&otpk.public_key).ok_or(AppError::BadRequest)?;
        sqlx::query!(
            "INSERT INTO one_time_prekeys (identity_key, key_id, public_key)
             VALUES ($1, $2, $3)
             ON CONFLICT (identity_key, key_id) DO NOTHING",
            &identity,
            otpk.key_id,
            &pk
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct UsernameReq {
    pub username: String,
}

/// POST /v1/accounts/username  (auth erforderlich)
pub async fn claim_username(
    State(state): State<AppState>,
    AuthedIdentity(identity): AuthedIdentity,
    Json(req): Json<UsernameReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    // Format wird zusätzlich per DB-CHECK erzwungen.
    let uname = req.username.trim().to_lowercase();
    let res = sqlx::query!(
        "UPDATE accounts SET username = $2, updated_at = now() WHERE identity_key = $1",
        &identity,
        &uname
    )
    .execute(&state.pg)
    .await;

    match res {
        Ok(r) if r.rows_affected() == 1 => Ok(Json(serde_json::json!({ "username": uname }))),
        Ok(_) => Err(AppError::NotFound),
        // Unique-Verletzung -> Username vergeben.
        Err(sqlx::Error::Database(db)) if db.is_unique_violation() => Err(AppError::Conflict),
        Err(e) => Err(e.into()),
    }
}

/// GET /v1/accounts/resolve/{username} -> identity_key (base64)
pub async fn resolve_username(
    State(state): State<AppState>,
    Path(username): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let uname = username.to_lowercase();
    let row = sqlx::query!(
        "SELECT identity_key FROM accounts WHERE username = $1",
        &uname
    )
    .fetch_optional(&state.pg)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(serde_json::json!({
        "username": uname,
        "identity_key": b64_encode(&row.identity_key),
    })))
}

/// GET /v1/directory -> { users: [{ username, identity_key }] }
///
/// Liste aller Nutzer mit gesetztem Username. Gedacht für kleine, private
/// Deployments, damit man einander ohne vorherigen Namensaustausch findet.
/// Per `VERLAUT_DIRECTORY_ENABLED=false` abschaltbar (dann 404). Es werden
/// AUSSCHLIESSLICH öffentliche Daten geliefert (Username + Public Identity Key),
/// keine Kontaktbeziehungen, keine Metadaten.
pub async fn directory(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, AppError> {
    if !state.cfg.directory_enabled {
        return Err(AppError::NotFound);
    }
    let rows = sqlx::query!(
        "SELECT username, identity_key FROM accounts \
         WHERE username IS NOT NULL ORDER BY username"
    )
    .fetch_all(&state.pg)
    .await?;
    let users: Vec<serde_json::Value> = rows
        .into_iter()
        .filter_map(|r| {
            r.username.map(|u| {
                serde_json::json!({ "username": u, "identity_key": b64_encode(&r.identity_key) })
            })
        })
        .collect();
    Ok(Json(serde_json::json!({ "users": users })))
}

// ---------------------------------------------------------------------------
// Transport-Encoding: URL-safe base64 ohne Padding, via `base64`-Crate.
// ---------------------------------------------------------------------------

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;

pub fn b64_encode(data: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(data)
}

pub fn b64_decode(s: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(s.trim()).ok()
}

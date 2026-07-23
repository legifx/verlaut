//! WebSocket-Router: Auth-Handshake, Präsenz, Envelope-Zustellung.
//!
//! Über diesen Kanal laufen ausschließlich `Frame`-Protobufs. Der Server
//! sieht nur Routing-Hüllen und opaken Ciphertext.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use prost::Message as _;
use tokio::sync::mpsc;

use crate::accounts::{issue_challenge, verify_challenge};
use crate::proto::{
    frame::Payload, protocol_error, AuthChallenge, AuthResult, Frame, ProtocolError, ServerAck,
};
use crate::queue;
use crate::state::AppState;

/// GET /v1/ws  — Upgrade mit striktem Origin-Check.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    // WS-Origin-Check: nur erlaubte Origin darf upgraden. `*` = jede Origin
    // (tailnet-only Betrieb; Tailscale ist die Zugangskontrolle).
    if state.cfg.allowed_origin.trim() != "*" {
        if let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) {
            if origin != state.cfg.allowed_origin {
                return axum::http::StatusCode::FORBIDDEN.into_response();
            }
        }
    }
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

// Helper zum Aufbau typisierter Frames.
fn frame(id: u64, payload: Payload) -> Vec<u8> {
    Frame { id, payload: Some(payload) }.encode_to_vec()
}
fn error_frame(id: u64, code: protocol_error::Code, detail: &str) -> Vec<u8> {
    frame(
        id,
        Payload::Error(ProtocolError { code: code as i32, detail: detail.to_string() }),
    )
}

async fn recv_frame(socket: &mut WebSocket) -> Option<Frame> {
    loop {
        match socket.recv().await? {
            Ok(Message::Binary(b)) => return Frame::decode(&b[..]).ok(),
            Ok(Message::Close(_)) => return None,
            Ok(_) => continue, // Ping/Pong/Text ignorieren
            Err(_) => return None,
        }
    }
}

/// Auth-Handshake: ChallengeRequest -> Challenge -> Response -> Result.
/// Gibt die authentifizierte Identität zurück oder None.
async fn authenticate(socket: &mut WebSocket, state: &AppState) -> Option<Vec<u8>> {
    // 1. Client nennt seinen Identity Key.
    let f = recv_frame(socket).await?;
    let identity = match f.payload {
        Some(Payload::AuthChallengeRequest(req)) => req.identity_key,
        _ => return None,
    };
    let nonce = issue_challenge(state, &identity).await.ok()?;

    // 2. Server schickt die Nonce.
    let out = frame(
        f.id,
        Payload::AuthChallenge(AuthChallenge {
            nonce: nonce.clone(),
            expires_at: state.cfg.nonce_ttl.as_secs(),
        }),
    );
    socket.send(Message::Binary(out.into())).await.ok()?;

    // 3. Client signiert die Nonce.
    let f = recv_frame(socket).await?;
    let resp = match f.payload {
        Some(Payload::AuthResponse(r)) => r,
        _ => return None,
    };

    // 4. Verifizieren (single-use Nonce, konstante Zeit).
    let ok = resp.identity_key == identity
        && verify_challenge(state, &resp.identity_key, &nonce, &resp.signature)
            .await
            .is_ok();

    let out = frame(
        f.id,
        Payload::AuthResult(AuthResult {
            ok,
            reason: if ok { String::new() } else { "auth failed".into() },
        }),
    );
    let _ = socket.send(Message::Binary(out.into())).await;

    ok.then_some(identity)
}

async fn handle_socket(mut socket: WebSocket, state: AppState) {
    let Some(identity) = authenticate(&mut socket, &state).await else {
        return;
    };

    // Präsenz registrieren, gepufferte Envelopes vorbereiten.
    let mut hub_rx = state.hub.register(identity.clone());
    let pending = queue::fetch_pending(&state, &identity).await.unwrap_or_default();

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (mut sink, mut stream) = socket.split();

    // Einziger Schreiber auf den Socket.
    let writer = tokio::spawn(async move {
        while let Some(bytes) = out_rx.recv().await {
            // axum 0.8: ws::Message::Binary trägt `Bytes`.
            if sink.send(Message::Binary(bytes.into())).await.is_err() {
                break;
            }
        }
    });

    // Gepufferte Envelopes zuerst zustellen.
    for env in pending {
        let _ = out_tx.send(frame(0, Payload::Inbound(env)));
    }

    // Echtzeit-Zustellung aus dem Hub.
    let hub_tx = out_tx.clone();
    let forward = tokio::spawn(async move {
        while let Some(env) = hub_rx.recv().await {
            if hub_tx.send(frame(0, Payload::Inbound(env))).is_err() {
                break;
            }
        }
    });

    // Eingehende Frames verarbeiten.
    while let Some(Ok(msg)) = stream.next().await {
        let bytes = match msg {
            Message::Binary(b) => b,
            Message::Close(_) => break,
            _ => continue,
        };
        let Ok(f) = Frame::decode(&bytes[..]) else {
            continue;
        };
        match f.payload {
            Some(Payload::Outbound(env)) => {
                // Absender muss der authentifizierten Identität entsprechen.
                if env.source_identity_key != identity {
                    let _ = out_tx.send(error_frame(
                        f.id,
                        protocol_error::Code::Unauthenticated,
                        "source mismatch",
                    ));
                    continue;
                }
                match queue::accept_outbound(&state, env).await {
                    Ok(()) => {
                        let _ = out_tx.send(frame(
                            f.id,
                            Payload::ServerAck(ServerAck { frame_id: f.id }),
                        ));
                    }
                    Err(e) => {
                        let _ = out_tx.send(error_frame(
                            f.id,
                            protocol_error::Code::BadRequest,
                            &e.to_string(),
                        ));
                    }
                }
            }
            Some(Payload::DeliveryAck(ack)) => {
                let _ = queue::ack_delete(&state, &identity, &ack.envelope_id).await;
            }
            // Alles andere in dieser Phase ignorieren.
            _ => {}
        }
    }

    // Aufräumen.
    state.hub.unregister(&identity);
    forward.abort();
    writer.abort();
}

// Damit `into_response()` auf StatusCode verfügbar ist.
use axum::response::IntoResponse;

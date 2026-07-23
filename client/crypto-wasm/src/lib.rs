//! Verlaut Client-Krypto (WASM). Dünne wasm-bindgen-Fassade über `core`
//! (libsignal, PQXDH). KEINE eigene Krypto.
//!
//! Die InMem-Store-Futures sind stets sofort fertig, daher werden sie synchron
//! ausgepollt (`now_or_never`) — die JS-API ist damit synchron (kein Promise).

pub mod core;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use futures_util::future::FutureExt;
use libsignal_protocol::ProtocolAddress;
use std::time::{Duration, SystemTime};
use wasm_bindgen::prelude::*;

use crate::core::{device_one, Protocol, PublicBundle};

fn b64e(x: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(x)
}
fn b64d(s: &str) -> Result<Vec<u8>, JsError> {
    URL_SAFE_NO_PAD.decode(s).map_err(|_| JsError::new("ungültiges base64"))
}
fn now_from_ms(ms: f64) -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_millis(ms as u64)
}
/// Adressname einer Partei = base64url(Identity Key) — deterministisch,
/// beide Seiten berechnen denselben Namen ohne Absprache.
fn addr(identity: &[u8]) -> ProtocolAddress {
    ProtocolAddress::new(b64e(identity), device_one())
}
fn jerr<E: std::fmt::Display>(e: E) -> JsError {
    JsError::new(&e.to_string())
}

/// Ein Verlaut-Client (eine Identität/ein Gerät). Hält alle libsignal-Stores.
#[wasm_bindgen]
pub struct VerlautClient {
    inner: Protocol,
}

#[wasm_bindgen]
impl VerlautClient {
    /// Neue Identität erzeugen.
    #[wasm_bindgen(constructor)]
    pub fn new() -> VerlautClient {
        VerlautClient { inner: Protocol::generate() }
    }

    /// Gespeicherte Identität wiederherstellen (Reload).
    #[wasm_bindgen(js_name = fromIdentity)]
    pub fn from_identity(identity: &[u8], registration_id: u32) -> Result<VerlautClient, JsError> {
        Ok(VerlautClient { inner: Protocol::from_serialized(identity, registration_id).map_err(jerr)? })
    }

    /// Serialisiertes Identity-Keypair (privat) zur lokalen Speicherung.
    #[wasm_bindgen(js_name = exportIdentity)]
    pub fn export_identity(&self) -> Vec<u8> {
        self.inner.identity_serialized()
    }

    /// Serialisierter Identity Public Key (33 Byte).
    #[wasm_bindgen(js_name = identityKey)]
    pub fn identity_key(&self) -> Vec<u8> {
        self.inner.identity_public()
    }

    #[wasm_bindgen(js_name = registrationId)]
    pub fn registration_id(&self) -> u32 {
        self.inner.registration_id
    }

    /// XEdDSA-Signatur über eine Server-Nonce (Auth-Challenge).
    pub fn sign(&self, nonce: &[u8]) -> Vec<u8> {
        self.inner.sign(nonce)
    }

    /// Erzeugt PreKeys (Curve OTPK, Signed Curve, Signed Kyber), speichert die
    /// privaten Teile lokal und liefert die fertige `/v1/accounts/register`-
    /// JSON (base64url-Felder) zum direkten POST an den Server.
    #[wasm_bindgen(js_name = createRegistration)]
    pub fn create_registration(&mut self) -> Result<String, JsError> {
        let b: PublicBundle = self
            .inner
            .create_bundle(1)
            .now_or_never()
            .expect("InMem-Future ist sofort fertig");
        let sk = |id: u32, pk: &[u8], sig: &[u8]| {
            serde_json::json!({ "key_id": id as i64, "public_key": b64e(pk), "signature": b64e(sig) })
        };
        let body = serde_json::json!({
            "identity_key": b64e(&b.identity_key),
            "registration_id": b.registration_id as i64,
            "signed_prekey": sk(b.signed_pre_key_id, &b.signed_pre_key_public, &b.signed_pre_key_signature),
            "kyber_prekey": sk(b.kyber_pre_key_id, &b.kyber_pre_key_public, &b.kyber_pre_key_signature),
            "one_time_prekeys": [
                { "key_id": b.pre_key_id as i64, "public_key": b64e(&b.pre_key_public) }
            ],
        });
        Ok(body.to_string())
    }

    /// Baut aus der Server-Bundle-JSON (`GET /v1/prekeys/...`) die PQXDH-Session
    /// zum Empfänger auf. `now_ms` = Date.now().
    #[wasm_bindgen(js_name = processBundle)]
    pub fn process_bundle(&mut self, server_bundle_json: &str, now_ms: f64) -> Result<(), JsError> {
        let v: serde_json::Value =
            serde_json::from_str(server_bundle_json).map_err(jerr)?;

        let s = |val: &serde_json::Value, k: &str| -> Result<String, JsError> {
            val[k].as_str().map(String::from).ok_or_else(|| JsError::new("feld fehlt"))
        };
        let n = |val: &serde_json::Value, k: &str| -> Result<u32, JsError> {
            val[k].as_u64().map(|x| x as u32).ok_or_else(|| JsError::new("zahl fehlt"))
        };

        let identity = b64d(&s(&v, "identity_key")?)?;
        let spk = &v["signed_prekey"];
        let kyber = &v["kyber_prekey"];
        let otpk = &v["one_time_prekey"];

        // OTPK optional (Vorrat evtl. erschöpft): leer -> None im Bundle.
        let (pre_key_id, pre_key_public) = if otpk.is_null() {
            (0u32, Vec::new())
        } else {
            (n(otpk, "key_id")?, b64d(&s(otpk, "public_key")?)?)
        };

        let bundle = PublicBundle {
            registration_id: n(&v, "registration_id")?,
            device_id: 1,
            pre_key_id,
            pre_key_public,
            signed_pre_key_id: n(spk, "key_id")?,
            signed_pre_key_public: b64d(&s(spk, "public_key")?)?,
            signed_pre_key_signature: b64d(&s(spk, "signature")?)?,
            kyber_pre_key_id: n(kyber, "key_id")?,
            kyber_pre_key_public: b64d(&s(kyber, "public_key")?)?,
            kyber_pre_key_signature: b64d(&s(kyber, "signature")?)?,
            identity_key: identity.clone(),
        };

        let remote = addr(&identity);
        let local = addr(&self.inner.identity_public());
        self.inner
            .process_bundle(&remote, &local, &bundle, now_from_ms(now_ms))
            .now_or_never()
            .expect("InMem sofort fertig")
            .map_err(jerr)
    }

    /// Verschlüsselt Klartext für `peer_identity` -> JSON `{isPrekey, body}`
    /// (body = base64url-Ciphertext für den Envelope).
    pub fn encrypt(
        &mut self,
        peer_identity: &[u8],
        plaintext: &[u8],
        now_ms: f64,
    ) -> Result<String, JsError> {
        let remote = addr(peer_identity);
        let local = addr(&self.inner.identity_public());
        let (is_prekey, body) = self
            .inner
            .encrypt(&remote, &local, plaintext, now_from_ms(now_ms))
            .now_or_never()
            .expect("InMem sofort fertig")
            .map_err(jerr)?;
        Ok(serde_json::json!({ "isPrekey": is_prekey, "body": b64e(&body) }).to_string())
    }

    /// Entschlüsselt einen Envelope-Ciphertext von `peer_identity`.
    pub fn decrypt(
        &mut self,
        peer_identity: &[u8],
        is_prekey: bool,
        body_b64: &str,
    ) -> Result<Vec<u8>, JsError> {
        let remote = addr(peer_identity);
        let local = addr(&self.inner.identity_public());
        let body = b64d(body_b64)?;
        self.inner
            .decrypt(&remote, &local, &body, is_prekey)
            .now_or_never()
            .expect("InMem sofort fertig")
            .map_err(jerr)
    }
}

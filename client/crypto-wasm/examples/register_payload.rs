//! Erzeugt mit echtem libsignal-Code eine Registrierungs-Payload (XEdDSA-
//! Signaturen + Kyber) und gibt sie als JSON aus — zum Verifizieren gegen den
//! laufenden Server per curl.
//!
//! Zeile 1: register-JSON. Zeile 2: identity_key (base64url) für den Fetch.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use verlaut_crypto_wasm::core::Protocol;

fn b(x: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(x)
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut alice = Protocol::generate();
    let bundle = alice.create_bundle(1).await;

    let sk = |id: u32, pk: &[u8], sig: &[u8]| {
        serde_json::json!({ "key_id": id, "public_key": b(pk), "signature": b(sig) })
    };

    let body = serde_json::json!({
        "identity_key": b(&bundle.identity_key),
        "signed_prekey": sk(bundle.signed_pre_key_id, &bundle.signed_pre_key_public, &bundle.signed_pre_key_signature),
        "kyber_prekey": sk(bundle.kyber_pre_key_id, &bundle.kyber_pre_key_public, &bundle.kyber_pre_key_signature),
        "one_time_prekeys": [
            { "key_id": bundle.pre_key_id, "public_key": b(&bundle.pre_key_public) }
        ],
    });

    println!("{}", serde_json::to_string(&body).unwrap());
    println!("{}", b(&bundle.identity_key));
}

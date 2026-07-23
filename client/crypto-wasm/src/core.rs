//! Krypto-Kernlogik über libsignal (PQXDH: X3DH + Kyber-1024 + Double Ratchet).
//! KEINE eigene Krypto — nur Aufrufe der offiziellen libsignal-API.
//!
//! Diese Datei ist bewusst plattformunabhängig (nativ testbar). Die
//! wasm-bindgen-Fassade in lib.rs ruft nur hier hinein und reicht `now` als
//! Zeitstempel aus JS herein (auf wasm gibt es kein SystemTime::now()).

use std::time::SystemTime;

use libsignal_protocol::{
    message_decrypt, message_encrypt, process_prekey_bundle, CiphertextMessage, DeviceId,
    GenericSignedPreKey, IdentityKeyPair, InMemSignalProtocolStore, KyberPreKeyRecord,
    KyberPreKeyStore, PreKeyBundle, PreKeyRecord, PreKeyStore, ProtocolAddress, SignedPreKeyRecord,
    SignedPreKeyStore,
};
use libsignal_protocol::{kem, KeyPair, Timestamp};
use rand::rngs::OsRng;
use rand::{CryptoRng, Rng, TryRngCore};

/// Infallible CSPRNG (Web Crypto auf wasm, /dev/urandom nativ).
fn rng() -> impl Rng + CryptoRng {
    OsRng.unwrap_err()
}

/// Einziges Gerät in Phase 1.
pub fn device_one() -> DeviceId {
    DeviceId::new(1).expect("device 1 gültig")
}

/// Öffentliche Bundle-Felder, wie sie über den Server wandern (alles öffentlich).
pub struct PublicBundle {
    pub registration_id: u32,
    pub device_id: u32,
    pub pre_key_id: u32,
    pub pre_key_public: Vec<u8>,
    pub signed_pre_key_id: u32,
    pub signed_pre_key_public: Vec<u8>,
    pub signed_pre_key_signature: Vec<u8>,
    pub kyber_pre_key_id: u32,
    pub kyber_pre_key_public: Vec<u8>,
    pub kyber_pre_key_signature: Vec<u8>,
    pub identity_key: Vec<u8>,
}

/// Ein Protokoll-Zustand (Identität + alle Stores) einer Partei/eines Geräts.
pub struct Protocol {
    identity: IdentityKeyPair,
    pub registration_id: u32,
    pub store: InMemSignalProtocolStore,
}

impl Protocol {
    /// Neue Identität erzeugen.
    pub fn generate() -> Self {
        let mut r = rng();
        let identity = IdentityKeyPair::generate(&mut r);
        // gültige Registration-ID (1..16380), wie bei Signal.
        let registration_id: u32 = r.random_range(1..16380);
        let store = InMemSignalProtocolStore::new(identity, registration_id)
            .expect("store init");
        Self { identity, registration_id, store }
    }

    /// Stellt eine gespeicherte Identität wieder her (Reload-Persistenz).
    /// ACHTUNG: stellt nur Identität + Registration-ID her; Sessions/PreKeys
    /// leben (noch) nur im Speicher und werden bei Bedarf neu aufgebaut.
    pub fn from_serialized(
        identity: &[u8],
        registration_id: u32,
    ) -> Result<Self, libsignal_protocol::SignalProtocolError> {
        let identity = IdentityKeyPair::try_from(identity)?;
        let store = InMemSignalProtocolStore::new(identity, registration_id)?;
        Ok(Self { identity, registration_id, store })
    }

    /// Serialisiertes Identity-Keypair (privat!) für die lokale Persistenz.
    pub fn identity_serialized(&self) -> Vec<u8> {
        self.identity.serialize().to_vec()
    }

    /// Serialisierter Identity Public Key (33 Byte, Signal-Typ-Prefix).
    pub fn identity_public(&self) -> Vec<u8> {
        self.identity.identity_key().serialize().to_vec()
    }

    /// XEdDSA-Signatur über `msg` mit dem Identity Private Key
    /// (für Server-Auth-Challenge + PreKey-Signaturen).
    pub fn sign(&self, msg: &[u8]) -> Vec<u8> {
        let mut r = rng();
        self.identity
            .private_key()
            .calculate_signature(msg, &mut r)
            .expect("sign")
            .to_vec()
    }

    /// Erzeugt PreKeys (Curve OTPK, Signed Curve PreKey, Signed Kyber PreKey),
    /// speichert die privaten Teile lokal und liefert die öffentlichen Felder.
    pub async fn create_bundle(&mut self, device_id: u32) -> PublicBundle {
        let mut r = rng();

        let pre_key_pair = KeyPair::generate(&mut r);
        let signed_pre_key_pair = KeyPair::generate(&mut r);
        let kyber_pre_key_pair = kem::KeyPair::generate(kem::KeyType::Kyber1024, &mut r);

        let signed_pub = signed_pre_key_pair.public_key.serialize();
        let signed_sig = self
            .identity
            .private_key()
            .calculate_signature(&signed_pub, &mut r)
            .expect("sign spk");

        let kyber_pub = kyber_pre_key_pair.public_key.serialize();
        let kyber_sig = self
            .identity
            .private_key()
            .calculate_signature(&kyber_pub, &mut r)
            .expect("sign kyber");

        // Key-IDs im positiven i32-Bereich (Server-Spalte ist INTEGER/i32).
        let pre_key_id: u32 = r.random_range(1..=0x7FFF_FFFF);
        let signed_pre_key_id: u32 = r.random_range(1..=0x7FFF_FFFF);
        let kyber_pre_key_id: u32 = r.random_range(1..=0x7FFF_FFFF);
        let now = Timestamp::from_epoch_millis(0);

        // private Teile lokal persistieren
        self.store
            .save_pre_key(pre_key_id.into(), &PreKeyRecord::new(pre_key_id.into(), &pre_key_pair))
            .await
            .expect("save pk");
        self.store
            .save_signed_pre_key(
                signed_pre_key_id.into(),
                &SignedPreKeyRecord::new(signed_pre_key_id.into(), now, &signed_pre_key_pair, &signed_sig),
            )
            .await
            .expect("save spk");
        self.store
            .save_kyber_pre_key(
                kyber_pre_key_id.into(),
                &KyberPreKeyRecord::new(kyber_pre_key_id.into(), now, &kyber_pre_key_pair, &kyber_sig),
            )
            .await
            .expect("save kyber");

        PublicBundle {
            registration_id: self.registration_id,
            device_id,
            pre_key_id,
            pre_key_public: pre_key_pair.public_key.serialize().to_vec(),
            signed_pre_key_id,
            signed_pre_key_public: signed_pub.to_vec(),
            signed_pre_key_signature: signed_sig.to_vec(),
            kyber_pre_key_id,
            kyber_pre_key_public: kyber_pub.to_vec(),
            kyber_pre_key_signature: kyber_sig.to_vec(),
            identity_key: self.identity.identity_key().serialize().to_vec(),
        }
    }

    /// Baut aus öffentlichen Bundle-Feldern ein PreKeyBundle und etabliert die
    /// X3DH/PQXDH-Session zum Empfänger.
    pub async fn process_bundle(
        &mut self,
        remote: &ProtocolAddress,
        local: &ProtocolAddress,
        b: &PublicBundle,
        now: SystemTime,
    ) -> Result<(), libsignal_protocol::SignalProtocolError> {
        use libsignal_protocol::{IdentityKey, PublicKey};
        // One-Time-PreKey ist optional (Vorrat kann erschöpft sein).
        let pre_key = if b.pre_key_public.is_empty() {
            None
        } else {
            Some((b.pre_key_id.into(), PublicKey::deserialize(&b.pre_key_public)?))
        };
        let bundle = PreKeyBundle::new(
            b.registration_id,
            device_one(),
            pre_key,
            b.signed_pre_key_id.into(),
            PublicKey::deserialize(&b.signed_pre_key_public)?,
            b.signed_pre_key_signature.clone(),
            b.kyber_pre_key_id.into(),
            kem::PublicKey::deserialize(&b.kyber_pre_key_public)?,
            b.kyber_pre_key_signature.clone(),
            IdentityKey::decode(&b.identity_key)?,
        )?;
        let mut r = rng();
        process_prekey_bundle(
            remote,
            local,
            &mut self.store.session_store,
            &mut self.store.identity_store,
            &bundle,
            now,
            &mut r,
        )
        .await
    }

    pub async fn encrypt(
        &mut self,
        remote: &ProtocolAddress,
        local: &ProtocolAddress,
        plaintext: &[u8],
        now: SystemTime,
    ) -> Result<(bool, Vec<u8>), libsignal_protocol::SignalProtocolError> {
        let mut r = rng();
        let ct = message_encrypt(
            plaintext,
            remote,
            local,
            &mut self.store.session_store,
            &mut self.store.identity_store,
            now,
            &mut r,
        )
        .await?;
        // is_prekey = erste Nachricht (PreKeySignalMessage) vs. etablierte Session.
        let is_prekey = matches!(ct, CiphertextMessage::PreKeySignalMessage(_));
        Ok((is_prekey, ct.serialize().to_vec()))
    }

    /// `is_prekey` unterscheidet PreKeySignalMessage (erster Kontakt) von
    /// SignalMessage (etablierte Session).
    pub async fn decrypt(
        &mut self,
        remote: &ProtocolAddress,
        local: &ProtocolAddress,
        ciphertext: &[u8],
        is_prekey: bool,
    ) -> Result<Vec<u8>, libsignal_protocol::SignalProtocolError> {
        use libsignal_protocol::{PreKeySignalMessage, SignalMessage};
        let msg = if is_prekey {
            CiphertextMessage::PreKeySignalMessage(PreKeySignalMessage::try_from(ciphertext)?)
        } else {
            CiphertextMessage::SignalMessage(SignalMessage::try_from(ciphertext)?)
        };
        let mut r = rng();
        message_decrypt(
            &msg,
            remote,
            local,
            &mut self.store.session_store,
            &mut self.store.identity_store,
            &mut self.store.pre_key_store,
            &self.store.signed_pre_key_store,
            &mut self.store.kyber_pre_key_store,
            &mut r,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(name: &str) -> ProtocolAddress {
        ProtocolAddress::new(name.to_string(), device_one())
    }

    #[tokio::test]
    async fn full_pqxdh_roundtrip() {
        let now = SystemTime::now();
        let mut alice = Protocol::generate();
        let mut bob = Protocol::generate();

        let alice_addr = addr("alice");
        let bob_addr = addr("bob");

        // Bob veröffentlicht ein Bundle; Alice baut daraus die Session.
        let bob_bundle = bob.create_bundle(1).await;
        alice
            .process_bundle(&bob_addr, &alice_addr, &bob_bundle, now)
            .await
            .expect("process bundle");

        // Alice -> Bob (erste Nachricht = PreKeySignalMessage)
        let m1 = b"Hallo Bob, das ist Ende-zu-Ende + Post-Quantum.";
        let (pk1, ct1) = alice.encrypt(&bob_addr, &alice_addr, m1, now).await.expect("enc1");
        assert!(pk1, "erste Nachricht ist PreKeySignalMessage");
        let pt1 = bob.decrypt(&alice_addr, &bob_addr, &ct1, pk1).await.expect("dec1");
        assert_eq!(&pt1, m1, "Bob entschlüsselt Alices Nachricht");

        // Bob -> Alice (Antwort = SignalMessage, Session etabliert)
        let m2 = b"Angekommen, entschluesselt, alles gut.";
        let (pk2, ct2) = bob.encrypt(&alice_addr, &bob_addr, m2, now).await.expect("enc2");
        let pt2 = alice.decrypt(&bob_addr, &alice_addr, &ct2, pk2).await.expect("dec2");
        assert_eq!(&pt2, m2, "Alice entschlüsselt Bobs Antwort");

        // Signatur-Selbsttest (XEdDSA über Nonce, wie Server-Auth).
        let nonce = [7u8; 32];
        let sig = alice.sign(&nonce);
        let ok = alice
            .identity
            .identity_key()
            .public_key()
            .verify_signature(&nonce, &sig);
        assert!(ok, "XEdDSA-Signatur verifiziert");
    }
}

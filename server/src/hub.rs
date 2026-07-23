//! In-Process-Präsenzregister für Echtzeit-Zustellung (Single-Instance Phase 1).
//!
//! Jede authentifizierte WS-Verbindung registriert einen Kanal unter ihrem
//! Identity Key. `deliver` schiebt einen bereits gepufferten Envelope an eine
//! online Verbindung. Cross-Instance-Fan-out (Redis Pub/Sub) ist ein späterer
//! Skalierungsschritt — die Durabilität hängt NICHT hieran (siehe queue.rs:
//! erst persistieren, dann zustellen, auf ACK löschen).

use std::collections::HashMap;
use std::sync::Mutex;

use tokio::sync::mpsc;

use crate::proto::Envelope;

#[derive(Default)]
pub struct Hub {
    conns: Mutex<HashMap<Vec<u8>, mpsc::UnboundedSender<Envelope>>>,
}

impl Hub {
    /// Registriert eine Verbindung und liefert den Empfänger-Stream.
    /// Eine zweite Verbindung mit demselben Key verdrängt die erste
    /// (Multi-Device kommt später).
    pub fn register(&self, identity: Vec<u8>) -> mpsc::UnboundedReceiver<Envelope> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.conns.lock().unwrap().insert(identity, tx);
        rx
    }

    pub fn unregister(&self, identity: &[u8]) {
        self.conns.lock().unwrap().remove(identity);
    }

    /// True, wenn zugestellt (Empfänger online + Kanal offen).
    pub fn deliver(&self, identity: &[u8], env: Envelope) -> bool {
        let guard = self.conns.lock().unwrap();
        match guard.get(identity) {
            Some(tx) => tx.send(env).is_ok(),
            None => false,
        }
    }

    #[allow(dead_code)] // Presence-Abfrage für Phase 2 (Sealed Sender / Typing)
    pub fn is_online(&self, identity: &[u8]) -> bool {
        self.conns.lock().unwrap().contains_key(identity)
    }
}

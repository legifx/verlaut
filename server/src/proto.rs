//! Von `build.rs` (prost) aus `shared/proto/envelope.proto` generierte Typen.
//! Handgeschriebenes Wire-Parsing gibt es bewusst nicht.

pub mod v1 {
    include!(concat!(env!("OUT_DIR"), "/verlaut.v1.rs"));
}

pub use v1::{
    frame, protocol_error, AuthChallenge, AuthResult, Envelope, Frame, ProtocolError, ServerAck,
};

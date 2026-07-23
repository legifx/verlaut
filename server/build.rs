// Kompiliert das gemeinsame Wire-Format (shared/proto/envelope.proto) zu Rust.
// Kein eigenes Format, kein Handgeschriebenes Parsing — prost erzeugt die Typen.
fn main() {
    let proto = "../shared/proto/envelope.proto";
    println!("cargo:rerun-if-changed={proto}");
    prost_build::compile_protos(&[proto], &["../shared/proto"])
        .expect("envelope.proto konnte nicht kompiliert werden");
}

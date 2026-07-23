// Protobuf-Frames (Wire-Format) via protobufjs, aus envelope.proto.
import protobuf from "protobufjs";
import protoSrc from "./envelope.proto?raw";

// 64-Bit-Felder als JS-Number (unsere IDs/Timestamps passen sicher in 2^53).
(protobuf.util as any).Long = null;
protobuf.configure();

const root = protobuf.parse(protoSrc).root;
export const Frame = root.lookupType("verlaut.v1.Frame");
export const Envelope = root.lookupType("verlaut.v1.Envelope");

/** Envelope.Type-Enum. */
export const EnvType = { UNKNOWN: 0, PREKEY: 1, CIPHERTEXT: 2, ATTACHMENT: 3 } as const;

export function encodeFrame(obj: Record<string, unknown>): Uint8Array {
  const err = Frame.verify(obj);
  if (err) throw new Error("Frame.verify: " + err);
  return Frame.encode(Frame.create(obj)).finish();
}

/** Dekodiert und liefert die Message-Instanz (oneof über `.payload`). */
export function decodeFrame(bytes: Uint8Array): any {
  return Frame.decode(bytes);
}

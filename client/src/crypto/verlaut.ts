// Lädt das libsignal-WASM (web-Target) und stellt VerlautClient bereit.
import init, { VerlautClient } from "./pkg/verlaut_crypto_wasm.js";

let ready: Promise<void> | null = null;

/** Muss einmal vor jeder Krypto-Nutzung aufgerufen werden. */
export function initCrypto(): Promise<void> {
  if (!ready) ready = init().then(() => undefined);
  return ready;
}

export { VerlautClient };

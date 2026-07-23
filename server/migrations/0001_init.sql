-- Verlaut Phase 1 — Schema.
-- Grundsatz: NUR öffentliche Keys, PreKey-Material und Offline-Zustell-Puffer.
-- KEINE Kontaktlisten, KEINE Nachrichtenhistorie, KEIN Klartext, KEINE PII.

-- ---------------------------------------------------------------------------
-- Accounts: Identität = Ed25519 Public Key. Username optional/änderbar.
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
    identity_key    BYTEA PRIMARY KEY,              -- 33 Byte libsignal IdentityKey (0x05-prefixed)
    username        TEXT UNIQUE,                    -- optional, unique, änderbar
    registration_id INTEGER NOT NULL DEFAULT 0,     -- libsignal Registration-ID (fürs Bundle)
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT identity_key_len CHECK (octet_length(identity_key) = 33),
    CONSTRAINT username_shape CHECK (
        username IS NULL OR username ~ '^[a-z0-9_]{3,32}$'
    )
);

-- ---------------------------------------------------------------------------
-- Signed PreKey: genau einer pro Account, rotierbar (X3DH mittelfristiger Key).
-- ---------------------------------------------------------------------------
CREATE TABLE signed_prekeys (
    identity_key BYTEA PRIMARY KEY REFERENCES accounts(identity_key) ON DELETE CASCADE,
    key_id       INTEGER NOT NULL,
    public_key   BYTEA   NOT NULL,                  -- X25519 pub
    signature    BYTEA   NOT NULL,                  -- Ed25519 sig über public_key
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- One-Time PreKeys: Vorrat, wird beim Fetch VERBRAUCHT (gelöscht).
-- ---------------------------------------------------------------------------
CREATE TABLE one_time_prekeys (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    identity_key BYTEA   NOT NULL REFERENCES accounts(identity_key) ON DELETE CASCADE,
    key_id       INTEGER NOT NULL,
    public_key   BYTEA   NOT NULL,                  -- X25519 pub
    UNIQUE (identity_key, key_id)
);

CREATE INDEX idx_otpk_by_identity ON one_time_prekeys (identity_key);

-- ---------------------------------------------------------------------------
-- Signed Kyber PreKey (PQXDH / Post-Quantum): einer pro Account (last-resort),
-- rotierbar. libsignal verlangt ihn zwingend im PreKey-Bundle.
-- ---------------------------------------------------------------------------
CREATE TABLE kyber_prekeys (
    identity_key BYTEA PRIMARY KEY REFERENCES accounts(identity_key) ON DELETE CASCADE,
    key_id       INTEGER NOT NULL,
    public_key   BYTEA   NOT NULL,                  -- serialisierter Kyber-1024 pub
    signature    BYTEA   NOT NULL,                  -- XEdDSA sig über public_key
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Offline-Puffer: Envelopes für gerade nicht verbundene Empfänger.
-- Serialisierter Envelope als opaker Blob. 30-Tage-TTL, Reaper löscht.
-- ---------------------------------------------------------------------------
CREATE TABLE offline_envelopes (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    destination_identity_key BYTEA       NOT NULL,
    payload                  BYTEA       NOT NULL,  -- serialisierter Envelope (opak)
    server_timestamp         TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at               TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_offline_by_dest    ON offline_envelopes (destination_identity_key, server_timestamp);
CREATE INDEX idx_offline_by_expiry  ON offline_envelopes (expires_at);

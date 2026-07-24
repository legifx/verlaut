import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import {
  useApp,
  boot,
  createAccount,
  addContact,
  refreshDirectory,
  startChat,
  selectPeer,
  sendText,
  sendImage,
  sendAudio,
} from "./app/state";
import type { StoredMessage } from "./store/db";
import { mediaUrl, startRecording, type Recorder } from "./media";
import { initUpdates, onUpdateAvailable, applyUpdate } from "./update";

export function App() {
  const booted = useApp((s) => s.booted);
  const me = useApp((s) => s.me);
  useEffect(() => {
    initUpdates();
    boot();
  }, []);
  if (!booted) return <Splash text="lädt…" />;
  return (
    <>
      <UpdateBanner />
      {me ? <Chat /> : <Onboarding />}
    </>
  );
}

function UpdateBanner() {
  const [show, setShow] = useState(false);
  useEffect(() => onUpdateAvailable(setShow), []);
  if (!show) return null;
  return (
    <div style={S.update}>
      <span>Neue Version verfügbar.</span>
      <button style={S.updateBtn} onClick={() => applyUpdate()}>
        Jetzt aktualisieren
      </button>
      <button style={S.updateDismiss} onClick={() => setShow(false)}>
        später
      </button>
    </div>
  );
}

function Splash({ text }: { text: string }) {
  return (
    <main style={S.shell}>
      <div style={S.card}>
        <div style={{ fontSize: 34 }}>🔒</div>
        <p style={S.sub}>{text}</p>
      </div>
    </main>
  );
}

function Onboarding() {
  const error = useApp((s) => s.error);
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await createAccount(username.trim().toLowerCase());
    } finally {
      setBusy(false);
    }
  };
  return (
    <main style={S.shell}>
      <div style={S.card}>
        <div style={{ fontSize: 34 }}>🔒</div>
        <h1 style={S.h1}>Verlaut</h1>
        <p style={S.sub}>Ende-zu-Ende-verschlüsselt · Post-Quantum · self-hosted</p>
        <input
          style={S.input}
          placeholder="Username wählen (a–z, 0–9, _)"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && username && submit()}
        />
        <button style={S.btn} disabled={busy || username.length < 3} onClick={submit}>
          {busy ? "erstelle…" : "Konto erstellen"}
        </button>
        {error && <p style={S.err}>{error}</p>}
        <p style={S.note}>
          Dein Schlüssel wird lokal auf diesem Gerät erzeugt und verlässt es nie. Der Server sieht
          nie Klartext.
        </p>
      </div>
    </main>
  );
}

function Chat() {
  const { me, contacts, directory, activePeer, messages, connected } = useApp();
  // Ohne Chats direkt „Alle Nutzer" zeigen, damit man sofort jemanden findet.
  const [tab, setTab] = useState<"chats" | "people">(() =>
    Object.keys(useApp.getState().contacts).length ? "chats" : "people",
  );
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activePeer]);
  useEffect(() => {
    if (tab === "people") refreshDirectory();
  }, [tab]);

  const peers = Object.keys(contacts);
  const active = activePeer ? messages[activePeer] || [] : [];
  const label = (pid: string) =>
    contacts[pid]?.username || directory.find((d) => d.peerId === pid)?.username || pid.slice(0, 10) + "…";

  return (
    <div style={S.app}>
      <aside style={S.side}>
        <div style={S.brand}>
          🔒 Verlaut
          <span title={connected ? "verbunden" : "offline"} style={{ ...S.dot, background: connected ? "#5cd6a0" : "#e0a05c" }} />
        </div>
        <div style={S.meRow}>@{me!.username}</div>
        <div style={S.tabs}>
          <button style={tabStyle(tab === "chats")} onClick={() => setTab("chats")}>
            Chats
          </button>
          <button style={tabStyle(tab === "people")} onClick={() => setTab("people")}>
            Alle Nutzer
          </button>
        </div>
        {tab === "chats" ? (
          <ChatsList peers={peers} activePeer={activePeer} label={label} />
        ) : (
          <PeopleList />
        )}
      </aside>

      <section style={S.main}>
        {!activePeer ? (
          <div style={S.placeholder}>
            {tab === "people" ? "Nutzer wählen, um zu chatten." : "Chat wählen oder unter „Alle Nutzer“ jemanden anschreiben."}
          </div>
        ) : (
          <>
            <div style={S.head}>
              {label(activePeer)} <span style={S.lock}>🔒 verschlüsselt</span>
            </div>
            <div style={S.thread}>
              {active.map((m) => (
                <Bubble key={m.id ?? m.ts} m={m} />
              ))}
              <div ref={endRef} />
            </div>
            <Composer text={text} setText={setText} />
          </>
        )}
      </section>
    </div>
  );
}

function ChatsList({
  peers,
  activePeer,
  label,
}: {
  peers: string[];
  activePeer: string | null;
  label: (pid: string) => string;
}) {
  return (
    <div style={S.list}>
      {peers.length === 0 && <div style={S.empty}>Noch keine Chats. Tab „Alle Nutzer“.</div>}
      {peers.map((pid) => (
        <div
          key={pid}
          style={{ ...S.contact, ...(pid === activePeer ? S.contactActive : {}) }}
          onClick={() => selectPeer(pid)}
        >
          {label(pid)}
        </div>
      ))}
    </div>
  );
}

function PeopleList() {
  const directory = useApp((s) => s.directory);
  const [q, setQ] = useState("");
  // Live-Aktualisierung: neu registrierte Nutzer erscheinen ohne Reload.
  useEffect(() => {
    refreshDirectory();
    const t = setInterval(refreshDirectory, 8000);
    return () => clearInterval(t);
  }, []);
  const filtered = directory.filter((d) => d.username.includes(q.trim().toLowerCase()));
  return (
    <>
      <div style={S.addRow}>
        <input
          style={S.addInput}
          placeholder="Nutzer suchen…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            // Enter: exakten Namen direkt anschreiben (auch wenn Directory leer)
            if (e.key === "Enter" && q.trim()) addContact(q.trim().toLowerCase());
          }}
        />
      </div>
      <div style={S.list}>
        {filtered.length === 0 && <div style={S.empty}>Keine Nutzer gefunden.</div>}
        {filtered.map((d) => (
          <div
            key={d.peerId}
            style={S.contact}
            onClick={() => {
              // identity ist im Laufzeit-Cache (peerIdentity) via refreshDirectory;
              // addContact löst notfalls erneut auf.
              addContact(d.username);
            }}
          >
            @{d.username}
          </div>
        ))}
      </div>
    </>
  );
}

function Composer({ text, setText }: { text: string; setText: (s: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);
  const [rec, setRec] = useState<Recorder | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const send = () => {
    if (text.trim()) {
      sendText(text);
      setText("");
    }
  };

  const toggleRecord = async () => {
    if (rec) {
      const out = await rec.stop();
      setRec(null);
      if (out.bytes.length > 0) sendAudio(out.bytes, out.mime, out.dur);
      return;
    }
    try {
      setErr(null);
      setRec(await startRecording());
    } catch {
      setErr("Mikrofon nicht verfügbar");
    }
  };

  return (
    <div style={S.composerWrap}>
      {err && <div style={S.composerErr}>{err}</div>}
      <div style={S.composer}>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) sendImage(f);
            e.target.value = "";
          }}
        />
        <input
          ref={camRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) sendImage(f);
            e.target.value = "";
          }}
        />
        <button style={S.iconBtn} title="Bild senden" onClick={() => fileRef.current?.click()}>
          📎
        </button>
        <button style={S.iconBtn} title="Kamera" onClick={() => camRef.current?.click()}>
          📷
        </button>
        <button
          style={{ ...S.iconBtn, ...(rec ? S.recActive : {}) }}
          title={rec ? "Aufnahme senden" : "Sprachnachricht"}
          onClick={toggleRecord}
        >
          {rec ? "⏹" : "🎤"}
        </button>
        <input
          style={S.msgInput}
          placeholder={rec ? "Aufnahme läuft…" : "Nachricht…"}
          value={text}
          disabled={!!rec}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <button style={S.send} onClick={send}>
          ↑
        </button>
      </div>
    </div>
  );
}

function Bubble({ m }: { m: StoredMessage }) {
  const url = useMemo(
    () => (m.media && m.mime ? mediaUrl(m.media, m.mime) : null),
    [m.media, m.mime],
  );
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  const side = m.dir === "out" ? S.out : S.in;
  if (m.kind === "image" && url) {
    return (
      <div style={{ ...S.bubble, ...side, padding: 4 }}>
        <img src={url} style={S.img} alt="Bild" />
      </div>
    );
  }
  if (m.kind === "audio" && url) {
    return (
      <div style={{ ...S.bubble, ...side, paddingBottom: 4 }}>
        <audio src={url} controls style={S.audio} />
      </div>
    );
  }
  return <div style={{ ...S.bubble, ...side }}>{m.text}</div>;
}

const glass = "rgba(255,255,255,0.04)";
const border = "1px solid rgba(255,255,255,0.08)";
function tabStyle(active: boolean): CSSProperties {
  return {
    flex: 1,
    padding: "8px 0",
    background: active ? glass : "transparent",
    border: "none",
    borderBottom: active ? "2px solid #3b82f6" : "2px solid transparent",
    color: active ? "#e6edf3" : "#8ba0b3",
    fontSize: 13,
    cursor: "pointer",
  };
}
const S: Record<string, CSSProperties> = {
  shell: { minHeight: "100dvh", display: "grid", placeItems: "center", background: "radial-gradient(1200px 800px at 50% -10%, #16202c, #0b0f14)", color: "#e6edf3", fontFamily: "Inter, system-ui, sans-serif", padding: 24 },
  card: { width: "min(400px,100%)", background: glass, border, borderRadius: 20, padding: 28, backdropFilter: "blur(12px)", textAlign: "center" },
  h1: { margin: "8px 0 2px", fontSize: 28, letterSpacing: -0.5 },
  sub: { margin: 0, color: "#9fb0c0", fontSize: 13 },
  input: { width: "100%", marginTop: 20, padding: "12px 14px", background: "rgba(0,0,0,0.25)", border, borderRadius: 12, color: "#e6edf3", fontSize: 15, boxSizing: "border-box" },
  btn: { width: "100%", marginTop: 12, padding: "12px 14px", background: "#3b82f6", border: "none", borderRadius: 12, color: "white", fontSize: 15, fontWeight: 600, cursor: "pointer" },
  err: { color: "#e06c75", fontSize: 13, marginTop: 12 },
  note: { marginTop: 18, color: "#7f95a8", fontSize: 12, lineHeight: 1.5 },

  update: { position: "fixed", top: 0, left: 0, right: 0, zIndex: 50, display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", background: "#1d4ed8", color: "white", fontSize: 13.5 },
  updateBtn: { marginLeft: "auto", padding: "6px 12px", background: "white", color: "#1d4ed8", border: "none", borderRadius: 8, fontWeight: 600, cursor: "pointer" },
  updateDismiss: { padding: "6px 10px", background: "transparent", color: "white", border: "1px solid rgba(255,255,255,0.5)", borderRadius: 8, cursor: "pointer" },

  app: { display: "flex", height: "100dvh", background: "radial-gradient(1200px 800px at 20% -10%, #16202c, #0b0f14)", color: "#e6edf3", fontFamily: "Inter, system-ui, sans-serif" },
  side: { width: 260, minWidth: 220, borderRight: border, display: "flex", flexDirection: "column", background: "rgba(0,0,0,0.15)" },
  brand: { padding: "16px 18px", fontWeight: 700, display: "flex", alignItems: "center", gap: 8 },
  dot: { width: 9, height: 9, borderRadius: "50%", marginLeft: "auto" },
  meRow: { padding: "0 18px 10px", color: "#9fb0c0", fontSize: 13 },
  tabs: { display: "flex", borderBottom: border },
  addRow: { padding: "10px 12px" },
  addInput: { width: "100%", padding: "9px 12px", background: "rgba(0,0,0,0.25)", border, borderRadius: 10, color: "#e6edf3", fontSize: 13, boxSizing: "border-box" },
  list: { flex: 1, overflowY: "auto" },
  empty: { padding: 18, color: "#7f95a8", fontSize: 13 },
  contact: { padding: "11px 18px", cursor: "pointer", fontSize: 14, borderLeft: "3px solid transparent" },
  contactActive: { background: glass, borderLeft: "3px solid #3b82f6" },

  main: { flex: 1, display: "flex", flexDirection: "column", minWidth: 0 },
  placeholder: { margin: "auto", color: "#7f95a8", padding: 24, textAlign: "center" },
  head: { padding: "16px 22px", borderBottom: border, fontWeight: 600, display: "flex", alignItems: "center", gap: 10 },
  lock: { fontSize: 12, color: "#5cd6a0", fontWeight: 400 },
  thread: { flex: 1, overflowY: "auto", padding: 22, display: "flex", flexDirection: "column", gap: 8 },
  bubble: { maxWidth: "68%", padding: "9px 13px", borderRadius: 14, fontSize: 14.5, lineHeight: 1.4, wordBreak: "break-word" },
  out: { alignSelf: "flex-end", background: "#2563eb", color: "white", borderBottomRightRadius: 4 },
  in: { alignSelf: "flex-start", background: glass, border, borderBottomLeftRadius: 4 },
  img: { display: "block", maxWidth: "min(320px, 60vw)", borderRadius: 11 },
  audio: { display: "block", width: "min(260px, 55vw)", height: 40 },

  composerWrap: { borderTop: border },
  composerErr: { padding: "6px 16px", color: "#e0a05c", fontSize: 12 },
  composer: { display: "flex", gap: 8, padding: 12, alignItems: "center" },
  iconBtn: { width: 40, height: 40, borderRadius: "50%", border, background: "rgba(0,0,0,0.2)", color: "#e6edf3", fontSize: 17, cursor: "pointer", flex: "0 0 auto" },
  recActive: { background: "#c0392b", borderColor: "#c0392b" },
  msgInput: { flex: 1, minWidth: 0, padding: "12px 16px", background: "rgba(0,0,0,0.25)", border, borderRadius: 22, color: "#e6edf3", fontSize: 15, boxSizing: "border-box" },
  send: { width: 44, height: 44, borderRadius: "50%", border: "none", background: "#3b82f6", color: "white", fontSize: 18, cursor: "pointer", flex: "0 0 auto" },
};

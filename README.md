# Tauri Tavern On The Go 📱

> *Your characters. Your voice. Anywhere.*

A custom fork of [TauriTavern](https://github.com/Darkatse/TauriTavern) built for authors, roleplayers, and anyone who wants their full AI companion setup available on their phone — synced live to their PC library, hands-free, and ready to go.

Built by **[Nicole Lane](https://github.com/NicoleLaneArt)** — indie author, heavy roleplay user, and someone who needed this to exist.

---

## What this fork adds

### 📱 Mobile-first features (Android)
- **Press-to-record voice input** — tap the mic, speak your message, tap again to send. No keyboard needed.
- **High-contrast TTS speaker button** — big, obvious, easy to tap while you're on the move
- **Group portrait character buttons** — tap a character's portrait to address them directly in group chats
- **Audio cache with Opus relabeling** — TTS audio is cached so it doesn't re-generate on replay

### 🧠 PC Digital Brain (Tailscale sync)
- Your PC runs as the "brain" — all your characters, chats, and world info live there
- Your phone connects over [Tailscale](https://tailscale.com) and uses the PC's full library as if it were local
- Changes sync both ways with a stale-chat guard — if your PC and phone both edited a chat, the newer one wins and the other reloads instead of overwriting
- Passcode-protected, Tailscale-only — your data never touches a third-party server
- Works with [Chatterbox TTS](https://github.com/resemble-ai/chatterbox) running on your PC for high-quality voice on your phone

### 📖 Story Memory Extension
A built-in extension that tracks your roleplay continuity:
- **Character Knowledge Boxes** — records what each character knows and doesn't know; secrets stay secret
- **Chapter summaries** — logs what changed each scene (decisions, reveals, relationship shifts) without copying the whole chat
- **One-click copy/export** — grab the full knowledge state to paste into Scrivener or your notes app instantly
- Designed for long-running RPGs where keeping track of who knows what actually matters

### 🛠️ PC build quality-of-life
- `.bat` launcher for Windows — one double-click to start, update, and go
- Portable Windows build (no install required)

---

## Who this is for

- Roleplay authors who want to write on their phone during a commute or in a waiting room
- Anyone using TauriTavern on PC who wants phone access without re-entering all their data
- Users of Chatterbox, Tailscale, or voice-heavy workflows
- People who need accessible, large-target mobile controls

---

## Setup

### Android (phone client)
1. Download the APK from [Releases](../../releases)
2. Install it (you may need to allow installs from unknown sources)
3. Set up Tailscale on both your phone and PC
4. In the app, go to **PC Brain** settings and enter your PC's Tailscale IP and the passcode shown on the PC

### Windows (PC host)
1. Download the portable `.exe` or `.zip` from [Releases](../../releases)
2. Run `start-tauritavern.bat` (or the exe directly)
3. Enable **PC Brain → Host mode** in settings — it shows you a passcode
4. Make sure Tailscale is running

### Story Memory Extension
The extension is included in this build. Enable it in TauriTavern → Extensions → Story Memory.

---

## Building from source

Requirements: [Rust](https://rustup.rs), [Node.js](https://nodejs.org), [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/)

```bash
git clone https://github.com/NicoleLaneArt/TauriTavern
cd TauriTavern
git checkout nicole-android-mic

# PC (Windows)
cargo tauri build

# Android
cargo tauri android build
```

For the Android APK you'll also need Android Studio and the NDK. See [Tauri's Android guide](https://v2.tauri.app/start/prerequisites/#android).

---

## License

GNU Affero General Public License v3.0 — same as the upstream project.

See [LICENSE](LICENSE).

---

## Credits

- **[TauriTavern](https://github.com/Darkatse/TauriTavern)** by [Darkatse](https://github.com/Darkatse) — the foundation this is built on. All original TauriTavern features and code are their work.
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** — the upstream project TauriTavern is itself based on
- **[Chatterbox TTS](https://github.com/resemble-ai/chatterbox)** by Resemble AI — the voice engine this pairs with
- **[Tailscale](https://tailscale.com)** — the mesh VPN that makes the PC Brain possible

---

*This is a personal fork built for my own use and shared for anyone who wants the same setup. It is not affiliated with or endorsed by Darkatse or the SillyTavern project.*

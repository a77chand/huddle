# Huddle

**An open-source safety companion for nights out.** Friends start a shared session for a concert, party, date or trip. Each person checks in on their own schedule, the group always sees who is accounted for, and when someone goes quiet or asks for help, the people who can help get a clear picture: what is known, what isn't, and what to do next.

Most safety apps are an individual panic button that sends a vague "SOS". Huddle is built around three ideas:

1. **The group, not the individual.** One shared board: who's okay, who's overdue, who asked for help, and who is already responding, so three friends don't all run to the same place while a fourth goes unnoticed.
2. **Honest escalation.** A missed check-in is a reason to look, not proof of an emergency. Phones die and venues are loud. Huddle says *"unreachable — not confirmed in danger"* and climbs a ladder you configure, instead of crying wolf.
3. **AI that makes alerts actionable, not alarming.** A voice note like *"I'm near the north entrance, please call me, don't come inside"* becomes a structured card. Open-weight models do the work, and every field quotes the speaker's own words. No model ever decides whether someone is in danger.

> Huddle is not an emergency service. If someone may be in immediate danger, call your local emergency number.

## How an alert works

| Level | When | What happens |
|---|---|---|
| 0 · Routine | Every *N* minutes (you choose) | Your phone asks **"Still okay?"** One tap, or the lock-screen button, checks you in. Scheduled on the phone, so it works offline. |
| 1 · Follow-up | Check-in missed | A louder private nudge. Your group isn't told yet. |
| 2 · Group | Grace period over | Friends get *"Cy missed a check-in. Last check-in 11:20 PM, last location 11:20 PM. Unreachable — not confirmed in danger."* One taps **I'm on it**, and everyone sees who is handling it. |
| 2b · Contacts | Nobody responds within *M* minutes (optional) | Your emergency contacts get an SMS with the same known/unknown summary, and later an **all-clear** text. A responder pauses this; anyone can escalate by hand. |
| 3 · SOS | **Hold for help**, or a discreet trigger | Immediate. Group (and contacts, if you chose) get your location and time, then any voice note or status you add. |
| — · Battery | Phone at 5% | The group gets your last location *before* you go dark, the most common reason a friend "disappears". |
| — · Nearby | Always, in the background | Phones note which friends' phones they pass near (Bluetooth). If Cy goes quiet, the alert says *"Last near Ana's phone 11:32 PM"*, even if Cy's phone is dead, because Ana's phone recorded it. |

What a responder sees (excerpt of real output from the server and models in this repo):

```
Bea asked for help
 known: SOS sent at 5:58 PM (just now).
 known: Last shared location at 5:58 PM (just now): https://maps.google.com/?q=40.75050,-73.99340
 known: They said they are: North Entrance — their words: "near the North Entrance".
 known: They asked you NOT to: come inside — their words: "Don't come inside".
 known: Preferred contact: phone call — their words: "Please call me".
 next: Contact them the way they asked: phone call.
 next: Respect: do not come inside.
 next: Tap "I'm on it" so the group knows someone is handling this.
 next: If you believe there is immediate danger, call local emergency services.
```

## Architecture

```
apps/mobile      Expo (React Native) app: iOS + Android
apps/server      Node + Fastify + SQLite: sessions, escalation clock, push/SMS, live WebSocket
packages/core    Pure TypeScript escalation engine, shared by server and app
services/ai      Python: Whisper speech-to-text + open-weight LLM grounded extraction
```

Design decisions that matter for safety:

- **The server owns escalation.** The phone of the person in trouble might be dead, so a server-side clock decides when to tell the group. The phone schedules its own "Still okay?" prompts so those work without signal.
- **AI is never on the alert path.** The SOS goes out first. The voice note is processed afterwards and only *adds* detail. If the model is down, a rules-based extractor takes over. If speech-to-text is down, the preset status still goes through.
- **Grounding.** Every extracted field must carry a quote that literally appears in the transcript, or it's dropped. A model can't invent a location or a request.
- **Deterministic summaries.** Counts, times, "what we know / don't know" and next steps come from the engine, not a model.
- **Privacy by default.** Location is shared only when you check in or ask for help. Continuous **live location** is an opt-in setting (off by default) for groups who want map-style sharing. Leaving a session wipes your location, sessions end automatically (12 h by default), and ended sessions are deleted after 24 h. Only hashes of access tokens are stored. Self-host it and nothing leaves your server.
- **Bluetooth IDs that only your group can read.** Each phone broadcasts a UUID derived from a members-only session secret, its member id and the current 15-minute window (SHA-256). Friends recognise each other, strangers see random IDs that rotate, and the server only ever learns "Ana was near Cy at 11:32", never the IDs. A sighting is *information*, not a check-in.
- **Fallbacks.** No data connection? SOS opens a pre-filled text to your contacts and friends using the phone's own SMS. Check-ins retry until they land.

## The open-weight AI

| Piece | Model | Runs on |
|---|---|---|
| Speech-to-text | Whisper `small` via faster-whisper, multilingual | CPU is fine, ~2 s per note |
| Extraction | Any instruct model behind an OpenAI-compatible API (Ollama, llama.cpp, vLLM). Default: **Gemma 3 4B** | A laptop, ~5 s per note |

Measured on the 20 hand-written voice notes in [`services/ai/evals`](services/ai/evals/voice_notes.jsonl). They include negations ("do **not** call me"), empty notes ("Help."), Spanish, Hindi-English code-switching, and statements about other people:

| Extractor | Field accuracy | Invented fields | Quotes dropped by grounding |
|---|---|---|---|
| Rules baseline | 77% | 1 | 0 |
| **Gemma 3 4B** | **89%** | 4 | 2 |

The rules baseline was written while looking at this set, so its score is optimistic. The model's "invented" fields are grounded misreadings, not fabrications: it labeled "come to the cafe" as where the speaker *is*, rather than where to meet. The responder still sees the speaker's exact words next to every field. Reproduce with `python -m evals.run_eval -v`. Thinking models (e.g. Qwen3 with default thinking) are too slow for this path. The eval flags fallbacks so they can't pass as a model score.

## Run it

**Server** (Node ≥ 22.13):

```bash
npm install
PUSH_DISABLED=1 npm run server          # http://localhost:8787
```

**AI service** (optional):

```bash
cd services/ai
python -m venv .venv && .venv/bin/pip install -e ".[speech,dev]"
ollama pull gemma3:4b
LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=gemma3:4b .venv/bin/uvicorn huddle_ai.app:app --port 8790
# then start the server with AI_URL=http://localhost:8790
```

**App:**

```bash
cd apps/mobile
EXPO_PUBLIC_SERVER_URL=http://<your-computer's-LAN-IP>:8787 npx expo start
```

Local notifications, location and voice notes work in Expo Go. Bluetooth "last seen near" is a native module ([`modules/huddle-proximity`](apps/mobile/modules/huddle-proximity)), so it needs a development build too. In Expo Go the app just shows it as unavailable. Remote push on Android needs a [development build](https://docs.expo.dev/develop/development-builds/introduction/) (`npx expo run:android` or `eas build --profile development`) and an EAS project id.

**Everything with Docker:** `cp .env.example .env && docker compose up -d && docker compose exec ollama ollama pull gemma3:4b`

**SMS** to emergency contacts uses Twilio. Set `TWILIO_*` in `.env`. Without it, contact alerts are logged.

### Discreet triggers

The app handles `huddle://sos` (3-second cancellable countdown, then alert) and `huddle://checkin`, so any OS shortcut can trigger them without opening the app:

- **iPhone:** Shortcuts → *Open URL* `huddle://sos` → assign to the **Action Button** or **Back Tap** (Settings → Accessibility → Touch → Back Tap → triple tap).
- **Android:** add a home-screen shortcut to the URL, or bind it with your launcher or Routines.

## Tests

```bash
npm test                                   # engine + server end-to-end (fake clock, fake push/SMS)
npm run typecheck
cd services/ai && .venv/bin/pytest -q      # grounding, fallback, API
```

CI runs all of the above, bundles the app for iOS and Android, and builds and boots the Docker images.

### Battery

A night out is long and people want their phones alive at 2 AM, so Huddle is built to be cheap to leave running:

- **Bluetooth Low Energy in bursts.** It advertises at the OS low-power interval and scans for 10 s every 2 min. "Last seen near" only needs a sighting every few minutes.
- **No continuous GPS by default.** Location is read once at a check-in or SOS.
- **Live location (opt-in)** uses low-power Wi-Fi/cell positioning (~100 m), reports only after you've moved ~150 m (or at most every 5 min), and lets iOS pause it when you're still. That's far cheaper than navigation-style GPS.
- **Battery saver.** In Low Power Mode or below 20%, Bluetooth and live location pause automatically. Check-ins, SOS and the 5% "last location" alert always keep working.

These are design choices, not measurements yet: real-device battery numbers belong here after field testing.

### Bluetooth: what works where

Mobile OSes restrict background Bluetooth, so here's what to expect:

| | iPhone scanning | Android scanning |
|---|---|---|
| iPhone advertiser, app open | ✅ | ✅ |
| iPhone advertiser, in background | ✅ (reads the ID over a quick GATT connection) | ❌ iOS hides background adverts from Android |
| Android advertiser | ✅ | ✅ |

Scanning is slower while the app is in the background on both platforms. On Android, turning on live location also runs a foreground service, which keeps Bluetooth scanning alive all night. Without it, Android may stop scanning after a while. Sightings are batched and uploaded every minute, and kept until they're sent.

## Roadmap

- Measure battery use on real phones over a full night, and tune the burst timings.
- A Bluetooth-only foreground service on Android, so all-night scanning doesn't require live location. Distance hints from RSSI.
- Native home-screen widget and watch complication for one-tap check-in.
- On-device transcription (whisper.cpp) so voice notes never leave the phone.
- Web link for SMS contacts to see the live incident without installing the app.
- More eval data, including real (consented) recordings in noisy venues.

## License

Apache-2.0

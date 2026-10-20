# Huddle

**An open-source safety companion for nights out.** Friends start a shared session for a concert, party, date or trip. Each person checks in on their own schedule, the group always sees who is accounted for, and when someone goes quiet or asks for help, the people who can help get a clear picture: what is known, what isn't, and what to do next.

Most safety apps are an individual panic button that sends a vague "SOS". Huddle is built around three ideas:

1. **The group, not the individual.** One shared board shows who's okay, who's overdue, who asked for help, and who is already responding, so three friends don't all run to the same place while a fourth goes unnoticed.
2. **Honest escalation.** A missed check-in is a reason to look, not proof of an emergency. Phones die and venues are loud. Huddle says *"unreachable — not confirmed in danger"* and climbs a ladder you configure, instead of crying wolf.
3. **AI that makes alerts actionable, not alarming.** A voice note like *"I'm near the north entrance, please call me, don't come inside"* becomes a structured card. Open-weight models do the work, and every field quotes the speaker's own words. No model ever decides whether someone is in danger.

> Huddle is not an emergency service. If someone may be in immediate danger, call your local emergency number.

## Features

- **Shared sessions.** Start a huddle and share a 6-character code. It ends on its own after 4–24 hours.
- **Check-ins on your own schedule.** "Still okay?" prompts are scheduled on the phone, so they work with no signal. Answer from the lock screen, or pause them ("in the cinema for 2 h").
- **SOS** from a press-and-hold button, or a discreet shortcut such as the iPhone Action Button or Back Tap.
- **Voice notes and quick statuses** ("Call me", "Don't come in") turned into clear instructions for friends.
- **"I'm on it"** coordination, so the group knows who is handling an alert.
- **Emergency contacts outside the app** get an SMS with what is known, then an all-clear when it's over.
- **Bluetooth "last seen near".** Phones quietly note which friends' phones were nearby, even with no signal.
- **Low-battery alert.** At 5% the group gets your last location before your phone dies.
- **Optional live location**, off by default, using low-power positioning.
- **Fallbacks.** No data connection? SOS opens a pre-filled text using the phone's own SMS.

## How an alert works

| Level | When | What happens |
|---|---|---|
| 0 · Routine | Every *N* minutes (you choose) | Your phone asks **"Still okay?"** One tap, or the lock-screen button, checks you in. |
| 1 · Follow-up | Check-in missed | A louder private nudge. Your group isn't told yet. |
| 2 · Group | Grace period over | Friends get *"Cy missed a check-in. Last check-in 11:20 PM. Last near Ana's phone 11:32 PM. Unreachable — not confirmed in danger."* One taps **I'm on it**, and everyone sees who is handling it. |
| 2b · Contacts | Nobody responds within *M* minutes (optional) | Your emergency contacts get an SMS with the same known/unknown summary, and later an **all-clear** text. A responder pauses this; anyone can escalate by hand. |
| 3 · SOS | **Hold for help**, or a discreet trigger | Immediate. The group (and contacts, if you chose) get your location and the time, then any voice note or status you add. |
| — · Battery | Phone at 5% | The group gets your last location *before* you go dark, the most common reason a friend "disappears". |

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

## Bluetooth "last seen near"

Indoors at a packed venue, GPS is often off by 50–100 m and the cell network jams, which is exactly when map-style location sharing fails. Bluetooth needs no network, and it answers a question maps can't: *who was she last with?*

- Each phone broadcasts an ID derived from a members-only session secret, its member id and the current 15-minute window (SHA-256). Friends recognise each other. Strangers see random IDs that change every 15 minutes.
- Sightings are matched to friends on the phone. The server only ever learns "Ana was near Cy at 11:32", never the IDs, and no location is sent.
- Because the *observer* records the sighting, it still works when the missing person's phone is dead.
- A sighting is information, not a check-in.

Mobile OSes restrict background Bluetooth, so here's what to expect:

| | iPhone scanning | Android scanning |
|---|---|---|
| iPhone advertiser, app open | ✅ | ✅ |
| iPhone advertiser, in background | ✅ (reads the ID over a quick GATT connection) | ❌ iOS hides background adverts from Android |
| Android advertiser | ✅ | ✅ |

On Android, turning on live location also runs a foreground service, which keeps Bluetooth scanning alive all night. Without it, Android may stop scanning after a while. Sightings are uploaded every minute and kept on the phone until they're sent.

## Battery and privacy

A night out is long and people want their phones alive at 2 AM, so Huddle is built to be cheap to leave running:

- **Bluetooth Low Energy in bursts.** It advertises at the OS low-power interval and scans for 10 s every 2 min.
- **No continuous GPS by default.** Location is read once at a check-in or SOS.
- **Live location is opt-in.** It uses Wi-Fi/cell positioning (~100 m) and reports only after you've moved ~150 m (or at most every 5 min). iOS can pause it when you're still.
- **Battery saver.** In Low Power Mode or below 20%, Bluetooth and live location pause automatically. Check-ins, SOS and the 5% alert always keep working.

These are design choices, not measurements yet. Real-device battery numbers will go here after field testing.

On privacy:
- Leaving a session wipes your location.
- Sessions end automatically, and ended sessions are deleted after 24 h.
- Only hashes of access tokens are stored.
- Self-host it and nothing leaves your server.

## The open-weight AI

| Piece | Model | Runs on |
|---|---|---|
| Speech-to-text | Whisper `small` via faster-whisper, multilingual | CPU is fine |
| Extraction | Any instruct model behind an OpenAI-compatible API (Ollama, llama.cpp, vLLM). Default: **Gemma 3 4B** | A laptop. About 7.5 s from audio to card in total |

Measured on the 20 hand-written voice notes in [`services/ai/evals`](services/ai/evals/voice_notes.jsonl). They include negations ("do **not** call me"), empty notes ("Help."), Spanish, Hindi-English code-switching, and statements about other people:

| Extractor | Field accuracy | Invented fields | Quotes dropped by grounding |
|---|---|---|---|
| Rules baseline | 77% | 1 | 0 |
| **Gemma 3 4B** | **89%** | 4 | 2 |

The rules baseline was written while looking at this set, so its score is optimistic. The model's "invented" fields are grounded misreadings, not fabrications: it labeled "come to the cafe" as where the speaker *is*, rather than where to meet. The responder still sees the speaker's exact words next to every field. Reproduce with `python -m evals.run_eval -v`.

Thinking models (e.g. Qwen3 with default thinking) are too slow for this path. The eval flags fallbacks so they can't pass as a model score.

## Architecture

```
apps/mobile                      Expo (React Native) app: iOS + Android
apps/mobile/modules/
  huddle-proximity               Native Bluetooth module (Swift + Kotlin)
apps/server                      Node + Fastify + SQLite: sessions, escalation clock, push/SMS, live WebSocket
packages/core                    Pure TypeScript escalation engine, shared by server and app
services/ai                      Python: Whisper speech-to-text + open-weight LLM grounded extraction
```

Design decisions that matter for safety:

- **The server owns escalation.** The phone of the person in trouble might be dead, so a server-side clock decides when to tell the group. The phone schedules its own "Still okay?" prompts so those work without signal.
- **AI is never on the alert path.** The SOS goes out first. The voice note is processed afterwards and only *adds* detail. If the model is down, a rules-based extractor takes over. If speech-to-text is down, the preset status still goes through.
- **Grounding.** Every extracted field must carry a quote that literally appears in the transcript, or it's dropped. A model can't invent a location or a request.
- **Deterministic summaries.** Counts, times, "what we know / don't know" and next steps come from the engine, not a model.

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
EXPO_PUBLIC_SERVER_URL=http://<your-computer's-LAN-IP>:8787 npx expo run:ios   # or run:android
```

Use a [development build](https://docs.expo.dev/develop/development-builds/introduction/) (`npx expo run:ios|android`, or `eas build --profile development`). Bluetooth, background live location and Android push all need native code that Expo Go doesn't include. In Expo Go (`npx expo start`), check-ins, SOS, location and voice notes still work, and the app labels the rest as unavailable. Push notifications also need an EAS project id.

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

CI runs all of the above and bundles the app. It also compiles full native Android (Gradle) and iOS (Xcode) builds, including the Bluetooth module, and builds and boots the Docker images.

## Status

Verified:
- 30 automated tests across the engine, server and AI service.
- End-to-end runs with real Whisper and Gemma models on spoken English and Spanish.
- Native builds compile on both platforms.

Not yet field-tested on real phones: push delivery, Bluetooth range and timing, background behaviour, and battery use over a full night. That's the next step.

## Roadmap

- Measure battery use on real phones over a full night, and tune the Bluetooth burst timings.
- A Bluetooth-only foreground service on Android, so all-night scanning doesn't require live location. Distance hints from RSSI.
- Native home-screen widget and watch complication for one-tap check-in.
- On-device transcription (whisper.cpp) so voice notes never leave the phone.
- Web link for SMS contacts to see the live incident without installing the app.
- More eval data, including real (consented) recordings in noisy venues.

## License

Apache-2.0

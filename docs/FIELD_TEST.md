# Field test

How to turn one night out into real numbers for battery, Bluetooth and alert timing.

## Before

1. **Deploy the server** so it keeps running while you're out: `fly deploy` (see [`fly.toml`](../fly.toml)), or run `npm run server` on an always-on machine.
2. **Build the app** for everyone: `cd apps/mobile && eas build --profile preview` (Android gives an APK you can send; iOS needs devices registered with `eas device:create`). Expo Go won't do: Bluetooth, background location and on-device AI need the native build.
3. On every phone, under **Your details**:
   - turn on **Field-test mode**
   - set a short check-in interval (e.g. 20 min) so you get several prompts
   - optionally download the **on-device AI** models (on Wi-Fi)
4. **Split the group** so the battery numbers mean something. For example:
   - A: Bluetooth on, live location off
   - B: Bluetooth on, live location on
   - C: Bluetooth off, live location off (baseline)
5. Note each phone's model and starting battery. Avoid charging during the test where you can (charging time is excluded automatically anyway).

## During

- Answer some "Still okay?" prompts quickly. Let one person miss one on purpose to test the full overdue → group alert path.
- Try one test SOS with a voice note ("I'm by the bar, don't come in, text me"), then mark safe.
- Walk away from the group for 10+ minutes, then come back, to check that "last seen near" updates.

## After

```bash
# From any member's token:
curl -H "Authorization: Bearer <token>" "https://<server>/v1/report?format=md"
# Or on the server:
node apps/server/src/report.ts --db /data/huddle.db
```

The report shows:
- **Alert delivery:** median, p95 and worst-case time from the moment an alert was due to the moment it was sent, per channel, plus the delivery rate.
- **Battery:** drain per hour for each phone with charging time excluded, labelled with which features were on.
- **Bluetooth:** sightings per phone, friends seen, and how often the radio was actually on.
- **Check-ins:** prompts, how many were answered within the grace period, and median response time.

Paste the tables into the README's *Battery* and *Status* sections, replacing the "design choices, not measurements" note.

## Known gaps

- On iOS, field-test samples only arrive while the app is open or kept awake by live location. Gaps longer than 2 hours are skipped, not counted as drain.
- Push delivery time is measured until Expo accepts the message, not until it appears on the phone.

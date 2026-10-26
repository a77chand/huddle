# Privacy policy

*Last updated: October 2026. This is a plain-language policy for the open-source Huddle app and the reference server in this repository. If you run your own server, you are the operator: adapt this to your situation and local law.*

Huddle exists to help friends look out for each other. It collects as little as it can, keeps it for as short a time as it can, and encrypts what matters most so the server can't read it.

## What is collected, and why

| Data | Why | Who can read it | Kept for |
|---|---|---|---|
| Your name and (optional) phone number | So friends know who's who and can tap to call you | Members of your huddle | The huddle |
| Check-in times, alert stage, who is responding | To raise alerts if you go quiet, even when your phone is dead | Your huddle, and the server | The huddle |
| Battery level | To warn your group before your phone dies | Your huddle, and the server | The huddle |
| **Your location** | At check-ins and SOS, and continuously only if you turn on live location | **Only your huddle**: it's end-to-end encrypted, and the server stores ciphertext | The huddle |
| **Your latest location, readable by the server** | Only if you allow "Include my location in emergency texts", and only so the server can text your emergency contacts when your phone may be dead | The server, and your emergency contacts if they're texted | The huddle |
| **Voice notes and statuses** | To tell friends what you need | **Only your huddle**, end-to-end encrypted. With on-device AI the audio never leaves your phone; with server AI it's processed and the result is returned to your phone to encrypt, never stored | The huddle |
| Emergency contacts (name, phone) | To text them if you choose | The server | The huddle |
| The live link in a contact's text | Lets your contacts follow the incident (status, what's known, who's responding, the all-clear). It shows only what their text could, and no friends' phone numbers | Anyone holding that unguessable link | Stops working when the huddle ends |
| Bluetooth "near" records | So friends can see who you were last near | Your huddle, and the server (member IDs and times only, no location) | The huddle |
| Push notification token | To deliver alerts to your phone | The server, and Expo's push service | The huddle |
| Field-test samples (opt-in) | Battery and radio state for testing, no location or audio | The server operator | The huddle |

"The huddle" means: a huddle ends automatically (after 4–24 hours, as chosen), and **everything about it, including keys, logs and measurements, is deleted 24 hours after it ends**. When you leave a huddle, your locations are wiped immediately and the group key changes, so you can't read anything shared afterwards.

## What is not collected

- No accounts, emails or passwords.
- No advertising or analytics SDKs, and no tracking across apps.
- No location history beyond your latest shared position.
- Huddle never sells or shares data for advertising.

## Third parties

- **Expo push service** (Expo / 650 Industries) delivers notifications to your phone. It sees the notification text, which in encrypted huddles contains names and times but never locations or messages. See [expo.dev/privacy](https://expo.dev/privacy).
- **Twilio** sends SMS to emergency contacts, if the server operator configured it. It sees the text sent.
- **Model downloads.** If you turn on on-device AI, the app downloads model files from Hugging Face and GitHub. Your voice notes are not sent anywhere.

## Your choices

- Bluetooth "last seen near", live location, on-device AI, field-test mode and the location in emergency texts are all settings you can turn off.
- Location, Bluetooth, microphone and notifications use your phone's permission system and can be revoked at any time in the phone's Settings.
- Leaving a huddle removes you from it immediately.

## Security

Locations, voice-note cards and statuses are end-to-end encrypted with keys the server never sees. [SECURITY.md](SECURITY.md) explains how, and what it does and doesn't protect against.

## Not an emergency service

Huddle helps friends coordinate. It doesn't contact emergency services, and it can't guarantee delivery of alerts. If someone may be in immediate danger, call your local emergency number.

## Children

Huddle isn't intended for children under 13.

## Contact

Questions or requests: open an issue at [github.com/a77chand/huddle](https://github.com/a77chand/huddle/issues), or contact the operator of the server your group uses.

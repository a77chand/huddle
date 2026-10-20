# Security and privacy

Huddle handles some of the most sensitive data there is: where someone is when they might be unsafe. This page says what is protected, from whom, and where the limits are.

## End-to-end encryption

New huddles are end-to-end encrypted.

| Encrypted on the phone (the server stores only ciphertext) | Readable by the server (it needs these to raise alerts when a phone is dead) |
|---|---|
| Locations: check-ins, SOS, live, low-battery | Names, optional phone numbers |
| Voice-note cards and transcripts | Check-in times, alert stage, who is responding |
| SOS / status messages | Battery level |
| | Bluetooth "near" records (member IDs and times only) |

**How it works** ([`packages/core/src/e2e.ts`](../packages/core/src/e2e.ts)):

- Each phone generates an **X25519** key pair. Only the public key goes to the server.
- The group shares a random 256-bit key per **epoch**. Phones hand it to each other *sealed* to the recipient's public key (ephemeral X25519 → HKDF-SHA256 → XChaCha20-Poly1305). The server relays these sealed keys but can't open them.
- Fields are encrypted with **XChaCha20-Poly1305**. The associated data binds each ciphertext to its huddle, member and field, so a stored location can't be moved to another person or field without failing to decrypt.
- **When someone leaves, the epoch advances.** The first remaining phone online shares a fresh key with everyone else, so the person who left can't read anything new.
- **Bluetooth IDs** in encrypted huddles are derived from the group key, so the server can't compute anyone's rotating IDs.
- Libraries: [`@noble/curves`, `@noble/ciphers`, `@noble/hashes`](https://paulmillr.com/noble/), which are audited, dependency-free and pure JavaScript. The same code runs on phones and in the tests.

**Emergency texts are the one deliberate exception.** Contacts outside the app have no keys, and the server must be able to text them even if your phone is dead. So the server can include your location only if you allow it ("Include my location in emergency texts", on by default). If you allow it, the server keeps **only your latest** location, uses it **only** for those texts, and deletes it when the huddle ends. Turn it off and contacts get times, not places.

**Server-side AI** in an encrypted huddle processes the voice note and returns the card to your phone, which encrypts it before it's stored. The server never stores the result. With **on-device AI**, the audio never leaves your phone at all.

## Threat model

| Threat | Protected? |
|---|---|
| Database leak, backup theft, a curious operator, a demand for stored records | **Yes.** Stored locations, cards and statuses are ciphertext. |
| Network eavesdropping | Yes: TLS, plus E2E for sensitive fields. |
| Someone outside the group tracking a phone over Bluetooth | Yes. The IDs look random and rotate every 15 minutes. |
| A former member reading new data | Yes. Keys rotate on leave. |
| **An actively malicious server** that substitutes public keys during the key exchange | **Partly.** Joining by **invite link** carries the key directly, without the server. Members can also compare **safety codes** (a public-key fingerprint, shown on each friend's page) in person. Without either, a malicious server could intercept the key exchange. |
| A compromised phone | No. A member's phone can read everything that member can. |
| Metadata (who is in a huddle, when people check in) | No. The server needs it for escalation. |

## Other protections

- Sessions end automatically (12 h by default), and ended sessions are deleted after 24 h, including keys, diagnostics and delivery logs.
- Only SHA-256 hashes of access tokens are stored. Join codes are rate-limited against guessing.
- Location is shared at check-ins and SOS by default. Live location is opt-in.
- Self-host it (Docker / Fly.io) and nothing leaves your own server.

Found a problem? Please open a GitHub issue marked **security**, or contact the maintainer privately before disclosing.

# LoRa Chat web app

**Live: <https://ricardobertolin.github.io/lora_chat_app/>**

A browser client for the `lora_chat` firmware. One codebase runs on desktop and
Android; it picks its USB transport at runtime.

This folder is named `docs/` because GitHub Pages can only publish from a repo's
root or from `/docs` - nothing else. Push to `main` and the site rebuilds in
about a minute.

| Platform | Browser | Transport |
| --- | --- | --- |
| Windows / Linux desktop | Chrome, Edge | Web Serial (uses the existing COM port) |
| Android | Chrome | WebUSB (drives the CP2102 directly) |
| Either, no cable | Chrome, Edge | Web Bluetooth (Nordic UART Service) |
| iPhone | - | Not possible; iOS has none of the three APIs |

Firefox and Safari support none of them on any platform.

Cable is the default and Bluetooth is never chosen automatically, because a
board already on USB should keep using it. Switch in **Set > Link**; the choice
is remembered. Over Bluetooth the browser's chooser lists the board as
`LoRaChat-<name>`.

**The firmware speaks one protocol on both pipes.** `lora_chat` emits
newline-delimited UTF-8 at 115200 over USB and notifies the identical lines over
BLE, so everything above `transport.js` is unaware of which is in use - the app
is `chat.py` rewritten in JavaScript either way.

## Version

The running build reports itself next to the title in the header, and in the
diagnostics line.

Installed copies update themselves: the service worker is registered with
`updateViaCache: 'none'`, which stops the browser handing back a cached `sw.js`
and never noticing a release at all - that alone is why an installed app could
sit on an old build indefinitely. It also re-checks every thirty minutes and
whenever the app returns to the foreground. When a new worker takes over, the
page reloads, unless a board is connected or a transfer is running, in which
case a bar appears and the reload waits for you.

**On every change: bump `VERSION` in `version.js` and the matching `CACHE` name
in `sw.js`.** They live in two files that cannot import each other - one is a
module, the other a service worker - so `test/version.test.mjs` fails the build
if they drift. Reusing a cache name across releases leaves installed copies
serving the old build forever.

## Files

| Path | What it is |
| --- | --- |
| `index.html` | Markup and styling. |
| `app.js` | UI wiring. |
| `protocol.js` | Parses the firmware's serial lines. No browser APIs, so it is unit-testable. |
| `transport.js` | Web Serial, WebUSB/CP210x and Web Bluetooth implementations behind one interface. |
| `position.js` | Position encoding and great-circle maths. Also browser-free and unit-tested. |
| `crypto.js` | AES-GCM encryption and passphrase key derivation. |
| `history.js` | Chat history persistence and capping. |
| `survey.js` | Probe bookkeeping, delivery ratio and link-margin maths. |
| `audio.js` | Chirps and the ring tone, synthesised with WebAudio - no assets. |
| `presence.js` | Who is on the channel, and when they went quiet. |
| `radar.js` | Ring scaling and the north-up projection for the radar. |
| `messaging.js` | Sequence numbers, acknowledgements and nicknames. |
| `outbox.js` | Messages waiting for a radio, persisted. |
| `theme.js` | The accent colour, shared between CSS, canvas and WebGL. |
| `version.js` | The version string. Bump it, and `CACHE` in `sw.js`, on every change. |
| `fragment.js` | Splits a blob across packets and reassembles it, with resend requests. |
| `media.js` | Dithering, ADPCM, and the LoRa airtime formula. |
| `backdrop.js` | The wireframe backdrop. Binds to the UI by observation, so app.js does not know it exists. |
| `vendor/` | three.js and the display font, held locally so the app runs offline. |
| `sw.js`, `manifest.webmanifest` | PWA shell, so it installs and runs offline. |
| `serve.py` | Local dev server on localhost. |
| `make_icons.py` | Regenerates the PNG icons. Stdlib only. |
| `test/` | `npm test` (26 tests) |

## Position sharing

Tap **Pos**. A position is sent as an ordinary chat message with a marker:

```
!POS -23.550520 -46.633309 12
```

so the **firmware needs no changes** - the board relays it like any other text,
and the receiving app renders a peer update instead of a chat bubble. Peers are
listed with distance and compass bearing from wherever you are.

Two sources, because they suit different machines:

| Source | For | Notes |
| --- | --- | --- |
| **Use GPS** | Phones | Real GNSS, works with no internet. Fixes worse than 100 m are rejected. |
| **Set manually** | Desktops, fixed nodes | Type the coordinates once; stored in `localStorage` and restored on reload. |

**Desktop geolocation is deliberately not trusted.** A PC has no GNSS, so the
browser falls back to WiFi or IP lookup - kilometres out, and it needs internet,
which is exactly what you will not have where LoRa is useful. A base station
does not move, so typing its coordinates is both more accurate and always
available. The 100 m accuracy gate is what stops an IP-derived guess from
quietly becoming a map pin.

**Share** starts a 60-second broadcast. At SF9 a position costs about a third of
a second of airtime, so it stays negligible for a handful of nodes.

### Radar

Below the roster, a north-up radar plots everyone whose position you have.
Rings snap to round numbers and rescale to fit the furthest contact; a stale
node greys out rather than disappearing.

**Bearing genuinely needs GPS at both ends.** A single omnidirectional antenna
gives a distance estimate and nothing else - direction requires a directional
antenna or several receivers. So a peer with no position is listed in the roster
but not plotted, rather than guessed at.

## Who is on the channel

Raw LoRa has no association step: anyone on the same frequency and sync word
simply hears you. Presence is therefore inferred.

- Connecting broadcasts `!HI`, and repeats it every two minutes so a node that
  arrives mid-session learns about everyone within a couple of minutes.
- **Any** traffic counts as a sign of life, so the announce is a backstop rather
  than the mechanism.
- Disconnecting broadcasts `!BYE`. Closing the tab does too, so a closed browser
  does not look like a node that crashed.
- Five minutes of silence marks a node **quiet**. It stays in the roster, greyed,
  because on LoRa "gone" and "behind a hill" look identical.

## Look

The "silvercase" theme: black, acid green `#d8ff2f`, square corners everywhere,
uppercase letterspaced labels, and a rotating wireframe backdrop that is dormant
while disconnected, wakes when a board attaches, and fires a shockwave on each
received packet.

The backdrop reads the UI rather than being driven by it - a `MutationObserver`
on the status pill and the log - so `app.js` carries no knowledge of it and the
theme can be swapped by replacing `index.html` and `backdrop.js` alone.

Three departures from the original design, all so it survives the field:

- **three.js is vendored** into `vendor/` instead of imported from a CDN. An
  offline app cannot fetch its own renderer.
- **The font is vendored** as a 10 kB Latin subset rather than pulled from
  Google Fonts. It sits behind the local CJK faces in the stack, so it is what
  Android actually renders.
- **The animation stops when the page is hidden.** A WebGL loop running in your
  pocket while the phone also powers the board is a poor trade on a range walk.
  `prefers-reduced-motion` gets a single static frame.

`vendor/three.module.min.js` is 670 kB, which dominates the install size. It is
cached once and never fetched again, but if that matters more than the backdrop,
delete `backdrop.js` and its `<script>` tag - nothing else references it.

## Nicknames, delivery and the outbox

**Set -> Nickname** replaces `8424` with a name, everywhere: chat, roster and
radar. It travels on the presence announcement rather than a message of its own,
so it costs no extra airtime and a late arrival learns it within two minutes.
The MAC-derived name stays available on hover, since that is what identifies the
board.

Every message carries a sequence number and gets a status in its header:

| Status | Meaning |
| --- | --- |
| `sending` | Handed to the board |
| `sent` | On the air |
| `delivered` | The other end acknowledged it |
| `no ack` | Nothing came back within 25 seconds |
| `failed` | The board would not take it |

Acknowledgements name the **original sender**, not the acknowledger - on a
broadcast channel an unaddressed ack becomes ambiguous the moment a third node
joins.

Anything that fails, goes unacknowledged, or is typed while disconnected lands
in the **outbox** and is sent when a board is attached. The composer therefore
stays usable offline. The count sits on the **Set** button; the queue survives a
reload, and holds 50 messages, dropping the oldest rather than refusing new ones.

## Sharing a channel

**Set -> Share setup** shows a QR code and a link carrying frequency, spreading
factor, bandwidth, power and the passphrase. **Scan setup** reads one with the
camera. Scanning applies the passphrase and sends the matching `/bw`, `/power`,
`/sf` and `/freq` to the board - which then propagates them to the other end
with the usual rollback if the link dies.

This replaces the worst friction in the project: matching four radio settings
and a passphrase by hand, with **no feedback when you get it wrong** - a
mismatch looks exactly like nobody being there.

The payload rides in the URL **fragment**, which browsers never send to a
server, so the passphrase stays on the two devices. The app strips it from the
address bar immediately after applying, to keep it out of history. Anyone who
can see the code can join, so treat it like the password it contains.

Scanning uses the browser's native `BarcodeDetector`. Where that is missing, the
link still works - send it by any other means and opening it does the same job.

## Encryption

**Set** -> type a shared passphrase -> **Enable**, on both ends. Messages then go
out as:

```
!ENC <base64 of IV || AES-256-GCM ciphertext || tag>
```

The board relays that like any other text, so the **firmware needs no changes**.
GCM authenticates as well as encrypts: a wrong key, a tampered packet or a
truncated one fails to decrypt rather than producing plausible garbage.
Decrypted messages show a lock in the header.

What it does **not** hide: the sender name, which the firmware prefixes outside
the ciphertext, and the fact that a transmission happened.

Two honest caveats:

- **Fixed salt.** Both ends must derive the same key having exchanged nothing,
  which rules out a random per-conversation salt. So the passphrase alone
  determines the key - identical passphrases give identical keys. 200k PBKDF2
  iterations and a strong passphrase are what carry the security.
- **The passphrase is stored in `localStorage`** so it survives reloads. Anyone
  with the unlocked device can read it. This protects against listening on the
  air, not against someone holding your phone.

Airtime roughly doubles: 28 bytes of IV and tag plus base64's 4/3 expansion, so
a 40-character message goes from about 0.35 s to 0.7 s at SF9.

`/commands` are never encrypted - the board would not recognise them.

## History and appearance

The last 300 messages are kept in `localStorage` and replayed on load, below an
`--- earlier ---` divider. Only real messages are stored; diagnostics, positions
and radio chatter are not.

**Set -> Keep** turns saving off entirely, and clears what is already there -
switching it off should not leave the previous conversation on disk. **Clear**
wipes the log without changing the setting.

**Set -> Accent** changes the green, either from the swatches or the colour
picker. It reaches the CSS, the radar canvas, the WebGL backdrop and the browser
tab icon, which are four unrelated renderers - hence `theme.js` broadcasting an
event rather than the settings panel reaching into each of them.

The **installed** home-screen icon cannot follow: Android bakes it from the
manifest at install time, so only the browser tab recolours. Reinstalling picks
up the current colour.

## Link test

**Test** -> **Start**. It sends `!PING n` at a fixed interval; the other app
auto-replies `!PONG n`, and the statistics build up live:

| Reported | Meaning |
| --- | --- |
| delivery | Replies over probes that got a verdict. In-flight probes are excluded, so the figure does not dip after every send |
| RSSI / SNR / RTT | min, mean and max |
| margin | **The number that matters.** SNR above the floor for the current SF |
| distance | From shared positions, when both ends have one |

A segmented **meter** above the numbers tracks link margin live: full scale is
25 dB, which is roughly a desk test at SF9, so a full green bar means as good as
it gets and an empty one means the link is about to drop. It turns amber under
10 dB and red under 3.

Sound gives you the same thing without looking: a low tick as each probe goes
out, a higher one when the reply lands. A tick with no answer is a lost packet,
so you can walk with the phone in a pocket and hear the link degrade.

**Export CSV** dumps every probe: `seq, sent_at_ms, delivered, rtt_ms, rssi_dbm,
snr_db, sf`.

### Why margin, and not RSSI

Two reasons RSSI misleads at range:

- **Survivor bias.** You only see RSSI for packets that *arrived*. At the edge,
  the weak ones vanish and the average quietly improves - the link looks
  healthiest just before it dies. Delivery ratio is the honest measure.
- LoRa demodulates **below** the noise floor, so SNR predicts success better.
  Each SF has a hard limit: SF7 -7.5 dB, SF9 -12.5 dB, SF12 -20 dB.

`margin = SNR - floor`, and it tells you how much further you can go:
`d2/d1 = 10^(margin / 10n)`, with *n* around 2 in free space, 3 suburban, 4+
dense urban. The app reports that multiplier at n=3.

### Making the numbers mean something

- **Both antennas vertical.** Cross-polarisation can cost 20 dB, more than the
  whole SF7-to-SF12 range.
- **Off the ground**, waist height or higher - ground blocks the Fresnel zone.
- **Consistent posture.** Your body absorbs 900 MHz; against your chest is
  several dB down on held out.
- **At least 20 probes** per point. Fading makes a single sample meaningless.
- **Fix the power** with `/power`, or you are comparing nothing.

Run the test at each `/sf` to find the fastest setting that still delivers from
where you are.

## Sound and calling

A short two-note chirp on each received message; a quieter tick for probe
replies. **Set -> Sound** toggles it, and the choice is remembered.

**Call** asks for confirmation first - it rings insistently at the other end and
the button sits between two others - then rings repeatedly until they answer,
for when the phone is in a pocket. Their app shows an Answer banner and rings until answered or
dismissed. **Any** message from them also ends the call - replying is answering.

Answer and Dismiss both reply over the air (`!CALLOK` / `!CALLNO`) so the caller
stops repeating. A dismissal additionally keeps this end quiet for a minute, in
case that reply was lost and the next `!CALL` arrives anyway. If the caller
simply gives up, the ringing stops on its own after four missed repeats.

Browsers refuse to make noise before the first interaction with the page, so the
audio context is unlocked on the first tap.

## Sending images and audio

**Med** -> pick a file, or **Rec** to record. You get an airtime estimate and a
confirmation before anything goes out, because a few seconds of sound can hold
the channel for minutes.

| | Encoding | Size | At SF9 |
| --- | --- | --- | --- |
| Image | 1-bit Floyd-Steinberg dither | 128x64 = 1 kB | ~15 s |
| Image | as above | 192x144 = 3.4 kB | ~50 s |
| Audio | 4-bit IMA ADPCM, 4 kHz | 2 kB per second | ~30 s per second of sound |

Dithering rather than a threshold, because at one bit a threshold destroys every
gradient. The sender sees the dithered result in the log before it goes, so
there are no surprises about what arrived.

**Drop to `/sf 7` before sending media.** It is roughly four times faster than
SF9 and you almost certainly do not need SF12's range for this.

Progress appears in its own strip under the header, with a fill bar and a Cancel
button - **not** in the chat log. A thirty-fragment image reporting each step
would bury the conversation it is part of. The log gets one line when a transfer
starts and one when it finishes or fails; everything between goes to the strip.

### How it works

Blobs are split into `!B<id>.<seq>.<total>.<kind><enc> <chunk>` lines of at most
180 characters - the firmware caps a line at 200 and prefixes the node name.
After the last one the sender emits `!BE<id>`; the receiver replies
`!BR<id> 3,7,12` for anything missing, and the sender resends. Three rounds,
then it gives up.

Two decisions worth knowing:

- **The blob is encrypted once, not per fragment.** Encrypting each line would
  add 28 bytes plus base64 expansion to every one and roughly halve throughput.
  The headers stay in the clear as a result - sequence numbers and a one-letter
  kind, no more than the sender name already leaks.
- **Sending is paced by the board's own `>>` echo**, not a fixed delay. The
  firmware transmits synchronously, so dumping thirty lines into a 256-byte
  serial buffer would simply lose most of them.

### On audio quality

ADPCM is not a speech codec. It is fixed at 4 bits per sample, so 4 kHz audio
costs 2 kB per second - about thirty times slower than real time at SF9.

The right answer is **Codec2**, the vocoder ham radio uses for HF digital voice,
which runs at 700-1600 bit/s. Ten seconds of speech would be roughly 875 bytes
instead of 20 kB, near real time even at SF9. It needs a WASM build vendored in,
which is why it is not here yet.

## Radio commands

Anything typed starting with `/` is handled by the board instead of being sent:

```
/status        /sf 7..12      /freq 868.0
/bw 125        /power -9..22  /revert       /help
```

Both boards switch together - the change is broadcast on the old settings first,
then applied at both ends - and **rolls back automatically after 30 seconds if
nothing is heard**, so a bad setting cannot strand a board out of reach. The app
shows the boards' `!CFG` chatter as notes rather than chat bubbles.

## Desktop

```powershell
cd webapp
python serve.py
```

Opens <http://localhost:8000>. Click **Connect** and pick the CP210x device.

`localhost` counts as a secure context, which is what Web Serial requires - a
plain `file://` open will not work.

**Only one program can hold a COM port.** Close the Arduino IDE Serial Monitor
and any `chat.py` before connecting, or the port will not appear.

## Android

Open <https://ricardobertolin.github.io/lora_chat_app/> in **Chrome** and plug the
board in with a **USB-C OTG cable** - the phone acts as USB host and powers the
board, so no battery is needed.

The HTTPS matters: WebUSB refuses to run outside a secure context, and a phone
cannot reach your PC's `localhost`. That is the whole reason for publishing to
Pages rather than just running `serve.py`.

Then **Add to home screen**. The service worker caches everything, so after the
first load it runs with no internet at all - which is the point, since there is
no connectivity where LoRa is useful.

Bump `CACHE` in `sw.js` whenever you change a file, or the service worker will
keep serving the old copy.

## Two people, no internet

```
[Android + board] <--LoRa--> [board + desktop]
     USB-C OTG                     USB
```

Each end needs a board running `lora_chat` on matching radio settings. There is
no router, no server and no SIM in the path - the LoRa link is the network.

## Troubleshooting

Tap **?** in the header for diagnostics: which transport was chosen, whether Web
Serial/WebUSB exist, and a picker that lists *any* USB device the browser can
see. If that one is empty too, the browser sees no USB device at all and the
problem is the cable or USB host mode - not this app.

### Cables

A USB-C to USB-C **charger** cable often carries power and CC only, with no USB
2.0 data pair. The board lights up and still cannot be found, because the CP2102
needs D+/D-. Use a cable known to carry data - the one you flash the board with
from the PC - and a USB-C OTG adapter if it is USB-A on the other end.

| Symptom | Cause |
| --- | --- |
| Board powers on, picker empty | Charge-only cable, or the phone is not acting as USB host |
| No device in the picker (desktop) | Something else holds the COM port |
| Connects, no banner | Board did not reset; press its RST button |
| Garbled text | Wrong baud - the board must be on 115200 |
| "Web Serial and WebUSB unavailable" | Firefox or Safari; use Chrome |
| Messages send but never arrive | The two boards disagree on frequency or SF |
| Bluetooth chooser lists nothing | Board's Bluetooth is off (`/bt on`) or it is out of range; the OLED shows `bt` when advertising |
| Bluetooth connects then drops | Pairing went stale after a reflash - run `/bt forget` on the board and remove it from the OS Bluetooth list |

## Status

Working on hardware: **Web Serial** on Windows desktop and **WebUSB** on
Android, both chatting through a Heltec V3.

**Web Bluetooth** is implemented on both sides and the firmware is verified
advertising, but the over-the-air link has not been tested on a phone yet - the
desktop it was built on has no Bluetooth radio.

Unit-tested (`npm test`, 101 tests): the serial line parser against output
captured from real sessions, position encoding and great-circle maths,
encryption against Node's WebCrypto (round-trip, wrong key, tampering,
truncation, unicode), history capping and corrupt-storage handling, survey
statistics (in-flight probes excluded from delivery ratio, duplicate replies
rejected, margin and range factor), fragmentation (line limits, out-of-order
arrival, duplicate and foreign fragments, resend batching), and the media
codecs (airtime against published figures, dither density and gradients, ADPCM
round-trip above 20 dB SNR).

Confirmed on hardware: `!PING`/`!PONG`/`!CALL` relay between two boards with
RSSI and SNR intact, and a full-size 180-character fragment survives the
firmware unmodified.

Not covered by tests: the two transports, WebAudio, MediaRecorder and the DOM,
which need a real browser.

If Android ever stops enumerating the board, the CP2102 setup in `transport.js`
(`IFC_ENABLE`, `SET_BAUDRATE`, `SET_LINE_CTL`, `SET_MHS`, per Silicon Labs
AN571) is the place to look - but check the cable first.

# Smartphone model - pocket LoRa modem

The board becomes a pocket "modem" for a phone. It runs `lora_chat`
(this folder) and the phone runs the web app, connected either over a
short USB-C OTG cable or over Bluetooth LE. The web app lives in
`../docs` because GitHub Pages can only serve the repository root or a
folder literally named `docs` - that folder is this model's other half,
not a separate project.

## Flash

```powershell
..\flash.ps1 -Role chat -Port COM4
```

Then open <https://ricardobertolin.github.io/lora_chat_app/> on the
phone (Android Chrome, WebUSB) or on a desktop (Web Serial), plug the
board in and hit connect.

## What the firmware does

- Relays lines to LoRa and back, from USB or Bluetooth alike - they are
  one pipe, and a line arriving on either is handled identically.
  Everything smart (nicknames, acks, fragments, encryption, positions)
  is the app's job, so the firmware almost never needs reflashing.
- Advertises a Nordic UART Service as `LoRaChat-<name>`. On by default,
  `/bt off` to disable, `/bt forget` to drop paired phones. The OLED
  shows `bt` when advertising and boxes it when a phone is attached.
- Radio settings are adjustable at runtime (`/help` on a serial
  monitor). Both ends switch together and roll back if the link dies.
- The OLED mirrors the last message and signal strength, blanks itself
  after a minute to save the battery, and wakes on the PRG button or on
  any traffic.
- PRG does the power management: tap wakes the screen, 1.2 s blanks it,
  3 s toggles Bluetooth, 6 s is a real power off (deep sleep, hold PRG
  to wake). The screen names the action while you hold the button.
- Battery voltage shows on the OLED and in `/status` when a LiPo is
  attached.

## Hardware (per `../modelos-hardware.md`, model 1)

- LiPo 3.7 V 1000-2000 mAh, SH1.25-2 plug. Check polarity: Heltec's
  connector is reversed relative to many ready-made batteries.
- Short USB-C to USB-C data cable (10-20 cm). Optional now that
  Bluetooth works, but still the faster and more reliable link.
- Small slide switch to cut the battery. Less essential now that a 6 s
  hold on PRG gives a real power off, but still the only way to get the
  draw to a true zero.
- 915 MHz 5 dBi SMA whip antenna (the ~2 dBi stock one is the range
  bottleneck).
- 3D case shaped like a powerbank, ~80 x 45 x 20 mm: OLED window,
  PRG/RST holes, side USB-C, SMA on top, battery bay behind a thin
  wall, velcro area to stick behind the phone.

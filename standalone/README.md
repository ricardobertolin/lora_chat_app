# Standalone model - GPS tracker on the board's own screen

No phone, no laptop. Each board carries its own GNSS module and battery,
broadcasts its position every 30 s, and shows the most recently heard
peer on the OLED: distance, bearing, age of the last packet and RSSI.
USB is only for flashing and charging.

The radio protocol is the one `lora_chat` and the web app already
speak (`NAME: !POS lat lon accuracy`), so a tracker appears on the web
app's radar, a phone user appears on the tracker's screen, and trackers
follow the `!CFG` retune messages a chat node sends.

## Flash

```powershell
..\flash.ps1 -Role tracker -Port COM4,COM6
```

## Wiring the GNSS module (ATGM336H or u-blox NEO-M8N, UART, 3.3 V)

| Module pin | Board pin | Note |
| --- | --- | --- |
| TX | GPIO 47 | `PIN_GPS_RX` in the sketch |
| RX | GPIO 48 | `PIN_GPS_TX`; optional, only needed to configure the module |
| VCC | Vext | 3.3 V, switched on by the firmware at boot |
| GND | GND | |

Default 9600 baud NMEA works out of the box; the sketch reads RMC and
GGA and ignores the rest. Mount the module's ceramic antenna facing up
and as far from the LoRa antenna as the case allows.

## Testing before the GPS modules arrive

Set `FAKE_FIX` to `1` and give each board different `FAKE_LAT` /
`FAKE_LON` a known distance apart. The whole radio side, screens and
distance math can be checked on the bench; the GPS is the last piece
in, not the first.

## Screens (PRG button cycles; a press while blank only wakes it)

1. **PEER** - who was heard last, how long ago, distance (big), compass
   bearing, their reported accuracy, RSSI/SNR. Without an own fix it
   shows the peer's raw coordinates instead.
2. **ME** - own lat/lon, altitude, satellites, HDOP, age of the fix,
   countdown to the next beacon.
3. **RADIO** - frequency, SF/BW/power, TX/RX counters, last RSSI.
4. **SYS** - battery voltage, uptime, NMEA counters (or FAKE_FIX
   notice), last non-position payload heard.

The screen blanks after 2 minutes; PRG or a fresh peer packet wakes it.
Up to 4 peers are tracked; one older than 10 minutes is dropped.

## Hardware (per `../modelos-hardware.md`, model 2a)

- GNSS module: ATGM336H or u-blox NEO-M8N (UART, 3.3 V).
- LiPo 3.7 V 1000 mAh, SH1.25-2 plug (polarity note applies here too).
- Slide switch, 915 MHz 5 dBi SMA whip.
- 3D case shaped like a large keyfob, ~65 x 40 x 18 mm: OLED window,
  PRG hole, GPS on top facing up, SMA on top, USB-C on the side,
  lanyard loop.

// Heltec WiFi LoRa 32 (V3) - standalone GPS tracker. No phone, no laptop.
//
// Flash this SAME sketch to every tracker. Each board reads its own GNSS
// module over UART, broadcasts its position every BEACON_MS, and shows the
// most recently heard peer on the OLED: distance, bearing, age and RSSI.
// The PRG button cycles the screens: PEER -> ME -> RADIO -> SYSTEM.
//
// The radio protocol is byte-for-byte the one lora_chat and the web app
// already speak: a position is the plain-text payload
//   NAME: !POS <lat> <lon> <accuracy_m>
// so a tracker shows up on the web app's radar, and the web app's positions
// show up on a tracker's screen. Trackers also follow the !CFG retune
// messages a chat board sends, with the same roll-back-if-silent safety net.
//
// USB is only for flashing and charging. The serial output still mirrors
// everything in lora_chat's line format, so plugging a tracker into the web
// app or monitor.py keeps working for free.
//
// No GPS module yet? Set FAKE_FIX to 1 and give each board a different
// FAKE_LAT/FAKE_LON: the whole radio side can be tested on the bench first.

#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <RadioLib.h>
#include <SPI.h>
#include <Wire.h>
#include <esp_mac.h>

// SX1262 wiring on the V3 (same as lora_chat).
#define PIN_LORA_NSS 8
#define PIN_LORA_DIO1 14
#define PIN_LORA_RST 12
#define PIN_LORA_BUSY 13
#define PIN_LORA_SCK 9
#define PIN_LORA_MISO 11
#define PIN_LORA_MOSI 10

// Radio settings. Every node on the channel must agree on all of these, and
// they must match lora_chat's defaults so mixed networks work out of the box.
#define LORA_FREQ_MHZ 915.0
#define LORA_BW_KHZ 125.0
#define LORA_SF 9
#define LORA_CR 7
#define LORA_SYNC_WORD 0x12
#define LORA_POWER_DBM 14
#define LORA_PREAMBLE 8
#define LORA_TCXO_V 1.8

// GNSS module (ATGM336H, NEO-M8N, most others) on UART1. GPIO 47/48 are in
// Heltec's recommended free-pin list for this board. Wire: module TX -> 47,
// module RX -> 48, VCC -> Vext (3.3 V, switched on below), GND -> GND.
#define PIN_GPS_RX 47  // board reads the module's TX here
#define PIN_GPS_TX 48
#define GPS_BAUD 9600

// Bench mode: pretend the fix below is real. Give the two boards different
// coordinates a known distance apart and check the PEER screen agrees.
#define FAKE_FIX 0
#define FAKE_LAT -23.550520
#define FAKE_LON -46.633308

// How often to broadcast our position. A random 0-5 s of jitter is added so
// two trackers on the same interval do not collide forever.
#define BEACON_MS 30000
#define BEACON_JITTER_MS 5000

// A peer this stale is dropped from the screen (it may have gone out of
// range, or off).
#define PEER_EXPIRE_MS 600000

// Leave empty to name the board from its MAC, same as lora_chat.
#define NODE_NAME ""

#define PIN_BUTTON 0  // PRG cycles screens; first press just wakes the OLED
#define OLED_SLEEP_MS 120000  // 0 = never blank

// Battery sense (see lora_chat for the divider note).
#define PIN_ADC_CTRL 37
#define PIN_VBAT 1
#define ADC_CTRL_ON LOW
#define VBAT_DIVIDER 4.9f

#define OLED_W 128
#define OLED_H 64
#define OLED_ADDR 0x3C

#define POS_PREFIX "!POS"
#define CFG_PREFIX "!CFG "

SX1262 radio = new Module(PIN_LORA_NSS, PIN_LORA_DIO1, PIN_LORA_RST, PIN_LORA_BUSY);
Adafruit_SSD1306 oled(OLED_W, OLED_H, &Wire, -1);
HardwareSerial gpsSerial(1);

static char nodeName[16];
static volatile bool packetWaiting = false;
static bool oledOk = false;
static bool oledAwake = true;
static uint32_t oledLastActive = 0;
static uint32_t txCount = 0;
static uint32_t rxCount = 0;
static uint32_t nextBeaconAt = 0;

enum Screen { SCR_PEER, SCR_ME, SCR_RADIO, SCR_SYS, SCR_COUNT };
static Screen screen = SCR_PEER;

// Our own GNSS state ------------------------------------------------------
struct Fix {
  bool valid = false;
  double lat = 0, lon = 0;
  float altM = 0;
  float hdop = 99;
  uint8_t sats = 0;
  uint32_t at = 0;  // millis() of the last valid RMC
};
static Fix fix;
static uint32_t nmeaOk = 0, nmeaBad = 0;

// The peers we have heard -------------------------------------------------
#define MAX_PEERS 4
struct Peer {
  char name[16];
  double lat, lon;
  uint16_t acc;
  float rssi, snr;
  uint32_t heardAt;
  bool used;
};
static Peer peers[MAX_PEERS];
static int lastPeer = -1;  // index of the most recently heard one

static String lastText = "";  // last non-position payload, for the SYS screen

// Radio config, shared with lora_chat's retune protocol -------------------
struct RadioCfg {
  float freq;
  float bw;
  uint8_t sf;
  int8_t power;
};
static RadioCfg cfg = {LORA_FREQ_MHZ, LORA_BW_KHZ, LORA_SF, LORA_POWER_DBM};
static RadioCfg prevCfg = cfg;
#define REVERT_AFTER_MS 30000
static uint32_t revertAt = 0;
static float lastRssi = 0, lastSnr = 0;

IRAM_ATTR void onDio1Rise() {
  packetWaiting = true;
}

// Geometry ----------------------------------------------------------------

static const double EARTH_RADIUS_M = 6371000.0;
static double rad(double d) { return d * PI / 180.0; }

static double distanceM(double lat1, double lon1, double lat2, double lon2) {
  double dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  double s = sin(dLat / 2) * sin(dLat / 2) +
             cos(rad(lat1)) * cos(rad(lat2)) * sin(dLon / 2) * sin(dLon / 2);
  return 2 * EARTH_RADIUS_M * asin(min(1.0, sqrt(s)));
}

static double bearingDeg(double lat1, double lon1, double lat2, double lon2) {
  double dLon = rad(lon2 - lon1);
  double y = sin(dLon) * cos(rad(lat2));
  double x = cos(rad(lat1)) * sin(rad(lat2)) - sin(rad(lat1)) * cos(rad(lat2)) * cos(dLon);
  double b = atan2(y, x) * 180.0 / PI;
  return fmod(b + 360.0, 360.0);
}

static const char *COMPASS[16] = {"N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                                  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"};

static const char *compassPoint(double bearing) {
  return COMPASS[((int)lround(bearing / 22.5)) % 16];
}

static void formatDistance(double m, char *out, size_t n) {
  if (m < 1000) snprintf(out, n, "%dm", (int)lround(m));
  else if (m < 10000) snprintf(out, n, "%.2fkm", m / 1000.0);
  else snprintf(out, n, "%dkm", (int)lround(m / 1000.0));
}

static void formatAge(uint32_t ms, char *out, size_t n) {
  uint32_t s = ms / 1000;
  if (s < 60) snprintf(out, n, "%lus", (unsigned long)s);
  else if (s < 3600) snprintf(out, n, "%lum", (unsigned long)(s / 60));
  else snprintf(out, n, "%luh", (unsigned long)(s / 3600));
}

// NMEA parsing ------------------------------------------------------------
// Just RMC (validity, lat, lon) and GGA (sats, HDOP, altitude), with the
// checksum verified. Anything else the module chats about is ignored.

static char nmeaBuf[120];
static size_t nmeaLen = 0;

static bool nmeaChecksumOk(const char *s) {
  // "$....*hh" - XOR of everything between $ and *.
  const char *star = strrchr(s, '*');
  if (s[0] != '$' || !star || strlen(star) < 3) return false;
  uint8_t sum = 0;
  for (const char *p = s + 1; p < star; p++) sum ^= (uint8_t)*p;
  return sum == (uint8_t)strtol(star + 1, nullptr, 16);
}

// ddmm.mmmm (or dddmm.mmmm) plus N/S/E/W into signed degrees.
static bool parseCoord(const char *val, const char *hemi, double &out) {
  if (!val[0] || !hemi[0]) return false;
  double raw = atof(val);
  double degrees = floor(raw / 100.0);
  double minutes = raw - degrees * 100.0;
  out = degrees + minutes / 60.0;
  if (hemi[0] == 'S' || hemi[0] == 'W') out = -out;
  return true;
}

// Splits on commas in place. Empty fields become empty strings.
static int splitFields(char *s, char *fields[], int maxFields) {
  int n = 0;
  fields[n++] = s;
  for (char *p = s; *p && n < maxFields; p++) {
    if (*p == ',' || *p == '*') {
      *p = '\0';
      fields[n++] = p + 1;
    }
  }
  return n;
}

static void handleSentence(char *s) {
  if (!nmeaChecksumOk(s)) {
    nmeaBad++;
    return;
  }
  nmeaOk++;

  char *f[24];
  int n = splitFields(s, f, 24);
  const char *type = f[0];  // "$GPRMC", "$GNRMC", ...
  if (strlen(type) != 6) return;

  if (!strcmp(type + 3, "RMC") && n > 6) {
    // f[2] status, f[3]/f[4] lat, f[5]/f[6] lon
    bool valid = f[2][0] == 'A';
    double lat, lon;
    if (valid && parseCoord(f[3], f[4], lat) && parseCoord(f[5], f[6], lon)) {
      bool firstFix = !fix.valid;
      fix.valid = true;
      fix.lat = lat;
      fix.lon = lon;
      fix.at = millis();
      if (firstFix) {
        Serial.printf("~~ GPS fix acquired: %.6f %.6f\n", lat, lon);
        // Announce ourselves right away instead of sitting on it for 30 s.
        nextBeaconAt = millis() + 1000;
        drawScreen();
      }
    } else if (!valid && fix.valid && millis() - fix.at > 10000) {
      fix.valid = false;  // fix lost for a while, stop claiming we have one
      drawScreen();
    }
  } else if (!strcmp(type + 3, "GGA") && n > 9) {
    // f[7] sats, f[8] HDOP, f[9] altitude
    if (f[7][0]) fix.sats = (uint8_t)atoi(f[7]);
    if (f[8][0]) fix.hdop = atof(f[8]);
    if (f[9][0]) fix.altM = atof(f[9]);
  }
}

static void pollGps() {
#if FAKE_FIX
  if (!fix.valid) {
    fix.valid = true;
    fix.lat = FAKE_LAT;
    fix.lon = FAKE_LON;
    fix.sats = 99;
    fix.hdop = 1.0;
    nextBeaconAt = millis() + 1000;
    Serial.println("~~ FAKE_FIX active - broadcasting the compiled-in position");
  }
  fix.at = millis();
#else
  while (gpsSerial.available()) {
    char c = gpsSerial.read();
    if (c == '\n' || c == '\r') {
      if (nmeaLen > 0) {
        nmeaBuf[nmeaLen] = '\0';
        handleSentence(nmeaBuf);
        nmeaLen = 0;
      }
    } else if (nmeaLen < sizeof(nmeaBuf) - 1) {
      nmeaBuf[nmeaLen++] = c;
    } else {
      nmeaLen = 0;  // oversized garbage, resync on the next newline
    }
  }
#endif
}

// Battery + OLED sleep (same approach as lora_chat) -----------------------

static float batteryVolts() {
  digitalWrite(PIN_ADC_CTRL, ADC_CTRL_ON);
  delay(2);
  uint32_t mv = analogReadMilliVolts(PIN_VBAT);
  digitalWrite(PIN_ADC_CTRL, ADC_CTRL_ON == LOW ? HIGH : LOW);
  float v = (mv / 1000.0f) * VBAT_DIVIDER;
  return v >= 2.5f ? v : 0.0f;
}

static void oledWake() {
  oledLastActive = millis();
  if (oledOk && !oledAwake) {
    oled.ssd1306_command(SSD1306_DISPLAYON);
    oledAwake = true;
  }
}

static void oledSleepCheck() {
  if (!oledOk || !oledAwake || OLED_SLEEP_MS == 0) return;
  if (millis() - oledLastActive >= OLED_SLEEP_MS) {
    oled.ssd1306_command(SSD1306_DISPLAYOFF);
    oledAwake = false;
  }
}

static void oledPowerOn() {
  pinMode(Vext, OUTPUT);
  digitalWrite(Vext, LOW);  // also powers the GPS module wired to Vext
  delay(100);
  pinMode(RST_OLED, OUTPUT);
  digitalWrite(RST_OLED, LOW);
  delay(20);
  digitalWrite(RST_OLED, HIGH);
  delay(20);
}

// Screens -----------------------------------------------------------------

static void drawHeader(const char *title) {
  oled.setCursor(0, 0);
  oled.print(nodeName);
  oled.setCursor(48, 0);
  oled.print(title);
  float vbat = batteryVolts();
  if (vbat > 0) {
    oled.setCursor(104, 0);
    oled.printf("%.1fV", vbat);
  }
  oled.drawFastHLine(0, 10, OLED_W, SSD1306_WHITE);
}

static void drawPeerScreen() {
  drawHeader("PEER");
  if (lastPeer < 0) {
    oled.setCursor(0, 24);
    oled.print("listening...");
    oled.setCursor(0, 36);
    oled.printf("RX %lu so far", rxCount);
    return;
  }
  Peer &p = peers[lastPeer];

  char age[8];
  formatAge(millis() - p.heardAt, age, sizeof(age));
  oled.setCursor(0, 14);
  oled.printf("%s  %s ago  %.0fdBm", p.name, age, p.rssi);

  if (fix.valid) {
    double d = distanceM(fix.lat, fix.lon, p.lat, p.lon);
    double b = bearingDeg(fix.lat, fix.lon, p.lat, p.lon);
    char dist[12];
    formatDistance(d, dist, sizeof(dist));
    oled.setTextSize(2);
    oled.setCursor(0, 26);
    oled.print(dist);
    oled.setTextSize(1);
    oled.setCursor(0, 46);
    oled.printf("%s (%03d deg true)", compassPoint(b), (int)lround(b));
  } else {
    oled.setCursor(0, 26);
    oled.printf("%.5f", p.lat);
    oled.setCursor(0, 36);
    oled.printf("%.5f", p.lon);
    oled.setCursor(0, 46);
    oled.print("no own fix yet");
  }
  oled.setCursor(0, 56);
  oled.printf("+/-%um  SNR %.0f", p.acc, p.snr);
}

static void drawMeScreen() {
  drawHeader("ME");
  if (!fix.valid) {
    oled.setCursor(0, 24);
    oled.print("waiting for fix");
    oled.setCursor(0, 36);
    oled.printf("sats %u  NMEA %lu", fix.sats, (unsigned long)nmeaOk);
    return;
  }
  char age[8];
  formatAge(millis() - fix.at, age, sizeof(age));
  oled.setCursor(0, 14);
  oled.printf("%.6f", fix.lat);
  oled.setCursor(0, 24);
  oled.printf("%.6f", fix.lon);
  oled.setCursor(0, 36);
  oled.printf("alt %.0fm  sats %u", fix.altM, fix.sats);
  oled.setCursor(0, 46);
  oled.printf("HDOP %.1f  fix %s ago", fix.hdop, age);
  oled.setCursor(0, 56);
  long tillBeacon = (long)(nextBeaconAt - millis());
  if (tillBeacon > 0) oled.printf("next beacon %lds", tillBeacon / 1000);
  else oled.print("beacon due");
}

static void drawRadioScreen() {
  drawHeader("RADIO");
  oled.setCursor(0, 14);
  oled.printf("%.3f MHz", cfg.freq);
  oled.setCursor(0, 24);
  oled.printf("SF%u  BW %.0f  %ddBm", cfg.sf, cfg.bw, cfg.power);
  oled.setCursor(0, 36);
  oled.printf("TX %lu  RX %lu", txCount, rxCount);
  oled.setCursor(0, 46);
  if (rxCount > 0) oled.printf("last RSSI %.0f SNR %.1f", lastRssi, lastSnr);
  else oled.print("nothing heard yet");
  if (revertAt) {
    oled.setCursor(0, 56);
    oled.print("retune pending...");
  }
}

static void drawSysScreen() {
  drawHeader("SYS");
  float vbat = batteryVolts();
  oled.setCursor(0, 14);
  if (vbat > 0) oled.printf("battery %.2f V", vbat);
  else oled.print("on USB power");
  oled.setCursor(0, 24);
  oled.printf("up %lum", (unsigned long)(millis() / 60000));
  oled.setCursor(0, 36);
#if FAKE_FIX
  oled.print("GPS: FAKE_FIX");
#else
  oled.printf("NMEA ok %lu bad %lu", (unsigned long)nmeaOk, (unsigned long)nmeaBad);
#endif
  if (lastText.length()) {
    oled.setCursor(0, 46);
    String t = lastText;
    if (t.length() > 42) t = t.substring(0, 41) + "~";
    oled.print(t);
  }
}

static void drawScreen() {
  if (!oledOk) return;
  oledWake();
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(1);
  switch (screen) {
    case SCR_PEER: drawPeerScreen(); break;
    case SCR_ME: drawMeScreen(); break;
    case SCR_RADIO: drawRadioScreen(); break;
    default: drawSysScreen(); break;
  }
  oled.display();
}

static void halt(const char *what, int code) {
  Serial.printf("%s failed, code %d - halting\n", what, code);
  if (oledOk) {
    oled.clearDisplay();
    oled.setTextColor(SSD1306_WHITE);
    oled.setTextSize(1);
    oled.setCursor(0, 0);
    oled.println("HALTED");
    oled.println();
    oled.println(what);
    oled.printf("code %d", code);
    oled.display();
  }
  while (true) delay(1000);
}

// Radio config + retune following (lora_chat's protocol) ------------------

static const float VALID_BW[] = {7.8, 10.4, 15.6, 20.8, 31.25, 41.7, 62.5, 125.0, 250.0, 500.0};

static bool validCfg(const RadioCfg &c) {
  if (c.sf < 7 || c.sf > 12) return false;
  if (c.freq < 150.0 || c.freq > 960.0) return false;
  if (c.power < -9 || c.power > 22) return false;
  for (float bw : VALID_BW) {
    if (fabsf(bw - c.bw) < 0.01f) return true;
  }
  return false;
}

static int applyCfg(const RadioCfg &c) {
  int state = radio.setFrequency(c.freq);
  if (state == RADIOLIB_ERR_NONE) state = radio.setBandwidth(c.bw);
  if (state == RADIOLIB_ERR_NONE) state = radio.setSpreadingFactor(c.sf);
  if (state == RADIOLIB_ERR_NONE) state = radio.setOutputPower(c.power);
  packetWaiting = false;
  radio.startReceive();
  return state;
}

static bool parseCfgMessage(const String &msg, RadioCfg &out) {
  out = cfg;
  int sf, pwr;
  float freq, bw;
  if (sscanf(msg.c_str(), CFG_PREFIX "SF %d FREQ %f BW %f PWR %d", &sf, &freq, &bw, &pwr) != 4) {
    return false;
  }
  out.sf = (uint8_t)sf;
  out.freq = freq;
  out.bw = bw;
  out.power = (int8_t)pwr;
  return validCfg(out);
}

static void rollback() {
  revertAt = 0;
  cfg = prevCfg;
  applyCfg(cfg);
  Serial.println("!! nothing heard after the retune - rolled back");
  drawScreen();
}

// TX and RX ---------------------------------------------------------------

static void sendPayload(const String &text) {
  String payload = String(nodeName) + ": " + text;
  int state = radio.transmit(payload.c_str());
  if (state == RADIOLIB_ERR_NONE) {
    Serial.printf(">> %s\n", text.c_str());
    txCount++;
  } else {
    Serial.printf("!! send failed, code %d\n", state);
  }
  // transmit() raises DIO1 on TxDone; drop it so we don't read a phantom.
  packetWaiting = false;
  radio.startReceive();
}

static void sendBeaconScheduled() {
  nextBeaconAt = millis() + BEACON_MS + (esp_random() % BEACON_JITTER_MS);
}

static void sendBeacon() {
  if (!fix.valid) return;
  uint16_t acc = (uint16_t)max(3L, lround(fix.hdop * 5.0));  // rough metres
  char msg[64];
  snprintf(msg, sizeof(msg), POS_PREFIX " %.6f %.6f %u", fix.lat, fix.lon, acc);
  sendBeaconScheduled();
  sendPayload(msg);
}

// "NAME: !POS lat lon acc" -> updates the peer table. Returns false for
// anything that is not a well-formed position.
static bool handlePosition(const String &payload) {
  int at = payload.indexOf(": ");
  if (at <= 0) return false;
  String name = payload.substring(0, at);
  String rest = payload.substring(at + 2);
  if (!rest.startsWith(POS_PREFIX)) return false;

  double lat, lon;
  int acc;
  if (sscanf(rest.c_str(), POS_PREFIX " %lf %lf %d", &lat, &lon, &acc) != 3) return false;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180 || acc < 0) return false;

  // Reuse the sender's slot, else a free one, else the stalest.
  int slot = -1;
  for (int i = 0; i < MAX_PEERS; i++) {
    if (peers[i].used && name.equals(peers[i].name)) { slot = i; break; }
  }
  if (slot < 0) {
    for (int i = 0; i < MAX_PEERS; i++) {
      if (!peers[i].used) { slot = i; break; }
    }
  }
  if (slot < 0) {
    slot = 0;
    for (int i = 1; i < MAX_PEERS; i++) {
      if (peers[i].heardAt < peers[slot].heardAt) slot = i;
    }
  }

  Peer &p = peers[slot];
  strncpy(p.name, name.c_str(), sizeof(p.name) - 1);
  p.name[sizeof(p.name) - 1] = '\0';
  p.lat = lat;
  p.lon = lon;
  p.acc = (uint16_t)acc;
  p.rssi = lastRssi;
  p.snr = lastSnr;
  p.heardAt = millis();
  p.used = true;
  lastPeer = slot;
  return true;
}

static void expirePeers() {
  for (int i = 0; i < MAX_PEERS; i++) {
    if (peers[i].used && millis() - peers[i].heardAt > PEER_EXPIRE_MS) {
      peers[i].used = false;
      if (lastPeer == i) lastPeer = -1;
    }
  }
  if (lastPeer < 0) {
    // Fall back to the freshest survivor, if any.
    for (int i = 0; i < MAX_PEERS; i++) {
      if (peers[i].used && (lastPeer < 0 || peers[i].heardAt > peers[lastPeer].heardAt)) {
        lastPeer = i;
      }
    }
  }
}

static void pollRadio() {
  if (!packetWaiting) return;
  packetWaiting = false;

  String msg;
  int state = radio.readData(msg);
  if (state == RADIOLIB_ERR_NONE) {
    lastRssi = radio.getRSSI();
    lastSnr = radio.getSNR();
    Serial.printf("<< %s  (RSSI %.1f dBm, SNR %.1f dB)\n", msg.c_str(), lastRssi, lastSnr);
    rxCount++;

    // Hearing anything at all confirms a pending retune worked.
    if (revertAt) {
      revertAt = 0;
      Serial.println("~~ retune confirmed");
    }

    int marker = msg.indexOf(CFG_PREFIX);
    RadioCfg next;
    if (marker >= 0 && parseCfgMessage(msg.substring(marker), next)) {
      RadioCfg old = cfg;
      cfg = next;
      if (applyCfg(cfg) == RADIOLIB_ERR_NONE) {
        prevCfg = old;
        revertAt = millis() + REVERT_AFTER_MS;
        Serial.printf("~~ following retune to %.3f MHz SF%u\n", cfg.freq, cfg.sf);
      } else {
        cfg = old;
        applyCfg(cfg);
      }
      drawScreen();
      return;  // applyCfg re-armed the receiver
    }

    if (handlePosition(msg)) {
      if (screen == SCR_PEER) drawScreen();  // fresh peer data, show it
    } else {
      // Chat, acks, fragments... not for us, but note it on the SYS screen.
      lastText = msg;
      if (screen == SCR_SYS || screen == SCR_RADIO) drawScreen();
    }
  } else if (state == RADIOLIB_ERR_CRC_MISMATCH) {
    Serial.println("!! packet dropped, CRC mismatch");
  } else {
    Serial.printf("!! readData() failed, code %d\n", state);
  }
  radio.startReceive();
}

static void pollButton() {
  static bool wasDown = false;
  static uint32_t lastEdge = 0;
  bool down = digitalRead(PIN_BUTTON) == LOW;
  if (down != wasDown && millis() - lastEdge > 30) {
    lastEdge = millis();
    wasDown = down;
    if (down) {
      if (oledOk && !oledAwake) {
        drawScreen();  // asleep: this press only wakes, next one cycles
      } else {
        screen = (Screen)((screen + 1) % SCR_COUNT);
        drawScreen();
      }
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(2000);

  pinMode(PIN_BUTTON, INPUT_PULLUP);
  pinMode(PIN_ADC_CTRL, OUTPUT);
  digitalWrite(PIN_ADC_CTRL, ADC_CTRL_ON == LOW ? HIGH : LOW);

  strncpy(nodeName, NODE_NAME, sizeof(nodeName) - 1);
  if (nodeName[0] == '\0') {
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(nodeName, sizeof(nodeName), "%02X%02X", mac[4], mac[5]);
  }

  // Same banner as lora_chat so the web app and monitor.py stay compatible.
  Serial.printf("\n=== LoRa chat - this board is \"%s\" ===\n", nodeName);
  Serial.println("~~ standalone GPS tracker firmware");

  oledPowerOn();
  Wire.begin(SDA_OLED, SCL_OLED);
  Wire.setClock(400000);
  oledOk = oled.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  if (!oledOk) {
    Serial.println("!! OLED not found at 0x3C, continuing without it");
  }

  gpsSerial.begin(GPS_BAUD, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);

  SPI.begin(PIN_LORA_SCK, PIN_LORA_MISO, PIN_LORA_MOSI, PIN_LORA_NSS);
  int state = radio.begin(LORA_FREQ_MHZ, LORA_BW_KHZ, LORA_SF, LORA_CR,
                          LORA_SYNC_WORD, LORA_POWER_DBM, LORA_PREAMBLE,
                          LORA_TCXO_V, false);
  if (state != RADIOLIB_ERR_NONE) halt("radio.begin()", state);

  radio.setDio2AsRfSwitch(true);
  radio.setPacketReceivedAction(onDio1Rise);
  state = radio.startReceive();
  if (state != RADIOLIB_ERR_NONE) halt("startReceive()", state);

  Serial.printf("on %.1f MHz, SF%d. Beaconing every %d s once there is a fix.\n",
                cfg.freq, cfg.sf, BEACON_MS / 1000);

  sendBeaconScheduled();
  drawScreen();
}

void loop() {
  pollRadio();
  pollGps();
  pollButton();
  expirePeers();

  if (fix.valid && (int32_t)(millis() - nextBeaconAt) >= 0) {
    sendBeacon();
    if (screen == SCR_ME) drawScreen();
  }

  if (revertAt && (int32_t)(millis() - revertAt) >= 0) {
    rollback();
  }

  // Ages and countdowns on screen go stale in seconds; redraw them slowly.
  // The periodic tick must not count as activity, or the panel never sleeps.
  static uint32_t lastTick = 0;
  if (oledAwake && millis() - lastTick > 5000) {
    lastTick = millis();
    uint32_t keep = oledLastActive;
    drawScreen();
    oledLastActive = keep;
  }
  oledSleepCheck();
}

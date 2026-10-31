// Heltec WiFi LoRa 32 (V3) - two-way LoRa chat over the serial monitor.
//
// Flash this SAME sketch to both boards - there is no sender/receiver role.
// Type a line in the Serial Monitor (115200 baud) and press Enter: it goes out
// over LoRa and appears on the other board's monitor. Anything the other board
// sends shows up here.
//
//   >> hello there            <- what this board sent
//   << 8424: hi back  (RSSI -25.0 dBm, SNR 10.5 dB)   <- what it heard
//
// The onboard OLED mirrors the last message and its signal strength, so you can
// unplug a board, walk it around and watch RSSI fall off without a laptop.

#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <RadioLib.h>
#include <SPI.h>
#include <Wire.h>
#include <esp_mac.h>

// SX1262 wiring on the V3. Heltec's variant header calls the SX1262's DIO1 pin
// "DIO0" (GPIO14) for backwards compatibility with the SX127x V2 boards.
#define PIN_LORA_NSS 8
#define PIN_LORA_DIO1 14
#define PIN_LORA_RST 12
#define PIN_LORA_BUSY 13
#define PIN_LORA_SCK 9
#define PIN_LORA_MISO 11
#define PIN_LORA_MOSI 10

// Radio settings. Both boards must agree on every one of these.
#define LORA_FREQ_MHZ 915.0
#define LORA_BW_KHZ 125.0
#define LORA_SF 9
#define LORA_CR 7
#define LORA_SYNC_WORD 0x12
#define LORA_POWER_DBM 14
#define LORA_PREAMBLE 8
#define LORA_TCXO_V 1.8  // the V3 clocks the SX1262 from a 1.8 V TCXO

// Leave empty to name each board after the last 2 bytes of its MAC, which keeps
// the firmware identical on both. Set e.g. "ALICE" to pin a name to this board.
#define NODE_NAME ""

#define MAX_MSG_LEN 200
// If the Serial Monitor's line ending is set to "No Line Ending" we never see a
// newline, so a short lull in the input stream also counts as end-of-message.
#define INPUT_IDLE_MS 80

// Onboard SSD1306. Vext, RST_OLED, SDA_OLED and SCL_OLED come from the board
// variant header (GPIO 36 / 21 / 17 / 18).
#define OLED_W 128
#define OLED_H 64
#define OLED_ADDR 0x3C
#define OLED_COLS 21  // 128 px / 6 px per char at text size 1
#define MSG_LINES 3   // how many wrapped lines of the last message we show

// On battery the OLED is the biggest steady drain after the ESP32 itself, so
// blank it after a quiet spell. Any message, or a press of the PRG button,
// turns it back on. 0 disables the timeout.
#define OLED_SLEEP_MS 60000
#define PIN_BUTTON 0  // PRG

// Battery sense: GPIO37 low connects VBAT through 390k/100k onto GPIO1.
// If this always reads 0.0 V with a battery attached, your board revision
// gates the divider the other way - change ADC_CTRL_ON to HIGH.
#define PIN_ADC_CTRL 37
#define PIN_VBAT 1
#define ADC_CTRL_ON LOW
#define VBAT_DIVIDER 4.9f  // (390k + 100k) / 100k

SX1262 radio = new Module(PIN_LORA_NSS, PIN_LORA_DIO1, PIN_LORA_RST, PIN_LORA_BUSY);
Adafruit_SSD1306 oled(OLED_W, OLED_H, &Wire, -1);  // reset handled by hand below

static char nodeName[16];
static volatile bool packetWaiting = false;

static char inBuf[MAX_MSG_LEN + 1];
static size_t inLen = 0;
static uint32_t lastCharAt = 0;

static bool oledOk = false;
static bool oledAwake = true;
static uint32_t oledLastActive = 0;
static String lastMsg = "waiting...";
static bool lastWasRx = false;
static float lastRssi = 0;
static float lastSnr = 0;
static uint32_t txCount = 0;
static uint32_t rxCount = 0;

// Runtime radio settings --------------------------------------------------
// Changing frequency or spreading factor on one board alone kills the link
// instantly - you can no longer reach the other board to tell it. So a change
// is broadcast first, applied by both ends, and rolled back automatically if
// nothing is heard afterwards.
struct RadioCfg {
  float freq;
  float bw;
  uint8_t sf;
  int8_t power;
};

static RadioCfg cfg = {LORA_FREQ_MHZ, LORA_BW_KHZ, LORA_SF, LORA_POWER_DBM};
static RadioCfg prevCfg = cfg;

#define REVERT_AFTER_MS 30000
static uint32_t revertAt = 0;  // 0 = nothing pending
static uint32_t probeAt = 0;   // 0 = no probe scheduled

// Over-the-air control messages. The app renders these as notes, not chat.
#define CFG_PREFIX "!CFG "
#define CFG_PROBE "!CFGOK"

IRAM_ATTR void onDio1Rise() {
  packetWaiting = true;
}

// The OLED sits behind the Vext switch, which is active LOW. Powering it up
// before Wire.begin() is what most "my V3 screen is dead" reports come down to.
static void oledPowerOn() {
  pinMode(Vext, OUTPUT);
  digitalWrite(Vext, LOW);
  delay(100);

  pinMode(RST_OLED, OUTPUT);
  digitalWrite(RST_OLED, LOW);
  delay(20);
  digitalWrite(RST_OLED, HIGH);
  delay(20);
}

// Returns 0 when no battery is attached (USB power reads well under 2.5 V).
static float batteryVolts() {
  digitalWrite(PIN_ADC_CTRL, ADC_CTRL_ON);
  delay(2);  // let the divider settle
  uint32_t mv = analogReadMilliVolts(PIN_VBAT);
  digitalWrite(PIN_ADC_CTRL, ADC_CTRL_ON == LOW ? HIGH : LOW);
  float v = (mv / 1000.0f) * VBAT_DIVIDER;
  return v >= 2.5f ? v : 0.0f;
}

// Every draw counts as activity and turns a sleeping panel back on, so the
// screen is lit exactly when something on it changed recently.
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

static void drawScreen() {
  if (!oledOk) {
    return;
  }
  oledWake();

  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(1);

  oled.setCursor(0, 0);
  oled.print(nodeName);
  oled.setCursor(54, 0);
  oled.printf("%.1f/SF%u", cfg.freq, cfg.sf);
  oled.drawFastHLine(0, 10, OLED_W, SSD1306_WHITE);

  // Body: the last message, truncated to what fits so it can never push the
  // stats off the bottom of the panel.
  oled.setCursor(0, 14);
  String body = String(lastWasRx ? "< " : "> ") + lastMsg;
  size_t room = OLED_COLS * MSG_LINES;
  if (body.length() > room) {
    body = body.substring(0, room - 1) + "~";
  }
  oled.print(body);

  if (lastWasRx) {
    oled.setCursor(0, 44);
    oled.printf("RSSI %.0f  SNR %.1f", lastRssi, lastSnr);
  }

  oled.setCursor(0, 56);
  oled.printf("TX %lu  RX %lu", txCount, rxCount);
  float vbat = batteryVolts();
  if (vbat > 0) {
    oled.setCursor(104, 56);
    oled.printf("%.1fV", vbat);
  }
  oled.display();
}

// Stop here, but say why on the screen as well - a board that failed while
// running on battery has no serial monitor attached to complain to.
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
  while (true) {
    delay(1000);
  }
}

// Bandwidths the SX1262 actually supports, in kHz.
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

  // The setters drop the radio to standby, so listening has to be restarted.
  packetWaiting = false;
  radio.startReceive();
  return state;
}

static void printCfg(const char *tag) {
  Serial.printf("%s %.3f MHz, SF%u, BW %.1f kHz, %d dBm\n", tag, cfg.freq, cfg.sf,
                cfg.bw, cfg.power);
}

static void rawSend(const String &payload) {
  int state = radio.transmit(payload.c_str());
  if (state != RADIOLIB_ERR_NONE) {
    Serial.printf("!! send failed, code %d\n", state);
  }
  packetWaiting = false;
  radio.startReceive();
}

// Arms the rollback and schedules a small probe, so both ends have something to
// hear. The delay is randomised so two boards switching together do not
// transmit on top of each other.
static void armRevert(const RadioCfg &old) {
  prevCfg = old;
  revertAt = millis() + REVERT_AFTER_MS;
  probeAt = millis() + 300 + (esp_random() % 900);
  Serial.printf("~~ reverting in %lu s unless the link comes back\n",
                (unsigned long)(REVERT_AFTER_MS / 1000));
}

static void confirmCfg() {
  if (revertAt == 0) return;
  revertAt = 0;
  printCfg("~~ link confirmed on");
}

static void rollback() {
  revertAt = 0;
  probeAt = 0;
  RadioCfg broken = cfg;
  cfg = prevCfg;
  int state = applyCfg(cfg);
  Serial.printf("!! nothing heard after the change - rolled back (code %d)\n", state);
  printCfg("~~ back on");
  lastMsg = "reverted";
  lastWasRx = false;
  drawScreen();
  (void)broken;
}

// Applies a change locally and arms the rollback. Used by both the command
// handler and by an incoming !CFG from the other board.
static bool changeCfg(const RadioCfg &next, bool announce) {
  if (!validCfg(next)) {
    Serial.println("!! invalid setting, ignored");
    return false;
  }
  RadioCfg old = cfg;

  // Announce on the OLD settings, while the other board can still hear us.
  if (announce) {
    String msg = String(CFG_PREFIX) + "SF " + next.sf + " FREQ " + String(next.freq, 3) +
                 " BW " + String(next.bw, 2) + " PWR " + next.power;
    rawSend(msg);
  }

  cfg = next;
  int state = applyCfg(cfg);
  if (state != RADIOLIB_ERR_NONE) {
    cfg = old;
    applyCfg(cfg);
    Serial.printf("!! could not apply, code %d - unchanged\n", state);
    return false;
  }
  printCfg("~~ now on");
  armRevert(old);
  drawScreen();
  return true;
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

static void showHelp() {
  Serial.println("commands:");
  Serial.println("  /status          show the current radio settings");
  Serial.println("  /sf 7..12        spreading factor (higher = further, slower)");
  Serial.println("  /freq 902.5      frequency in MHz");
  Serial.println("  /bw 125          bandwidth in kHz (7.8 .. 500)");
  Serial.println("  /power -9..22    transmit power in dBm");
  Serial.println("  /revert          undo the last change");
  Serial.println("both boards switch together, and roll back if the link drops");
}

// Returns true if the line was a command and must not go out over the air.
static bool handleCommand(const char *line) {
  if (line[0] != '/') return false;

  char verb[16] = {0};
  float value = 0;
  int got = sscanf(line + 1, "%15s %f", verb, &value);
  if (got < 1) return true;

  if (!strcmp(verb, "help")) {
    showHelp();
  } else if (!strcmp(verb, "status")) {
    printCfg("~~ on");
    Serial.printf("~~ node %s, TX %lu, RX %lu\n", nodeName, txCount, rxCount);
    float vbat = batteryVolts();
    if (vbat > 0) {
      Serial.printf("~~ battery %.2f V\n", vbat);
    } else {
      Serial.println("~~ battery not detected (USB power?)");
    }
  } else if (!strcmp(verb, "revert")) {
    if (revertAt == 0) {
      Serial.println("!! nothing to revert");
    } else {
      rollback();
    }
  } else if (got < 2) {
    Serial.printf("!! /%s needs a value - try /help\n", verb);
  } else if (!strcmp(verb, "sf")) {
    RadioCfg next = cfg;
    next.sf = (uint8_t)value;
    changeCfg(next, true);
  } else if (!strcmp(verb, "freq")) {
    RadioCfg next = cfg;
    next.freq = value;
    changeCfg(next, true);
  } else if (!strcmp(verb, "bw")) {
    RadioCfg next = cfg;
    next.bw = value;
    changeCfg(next, true);
  } else if (!strcmp(verb, "power")) {
    RadioCfg next = cfg;
    next.power = (int8_t)value;
    changeCfg(next, true);
  } else {
    Serial.printf("!! unknown command /%s - try /help\n", verb);
  }
  return true;
}

static void sendLine() {
  if (inLen == 0) {
    return;
  }
  inBuf[inLen] = '\0';
  inLen = 0;

  if (handleCommand(inBuf)) {
    return;
  }

  String payload = String(nodeName) + ": " + inBuf;
  int state = radio.transmit(payload.c_str());
  if (state == RADIOLIB_ERR_NONE) {
    Serial.printf(">> %s\n", inBuf);
    txCount++;
    lastMsg = inBuf;
    lastWasRx = false;
  } else {
    Serial.printf("!! send failed, code %d\n", state);
    lastMsg = "send failed";
    lastWasRx = false;
  }
  drawScreen();

  // transmit() raises DIO1 on TxDone, which sets the same flag the RX path
  // uses - drop it so we don't read a phantom packet.
  packetWaiting = false;
  radio.startReceive();
}

static void pollSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    lastCharAt = millis();

    if (c == '\r') {
      continue;
    }
    if (c == '\n') {
      sendLine();
      continue;
    }
    if (inLen < MAX_MSG_LEN) {
      inBuf[inLen++] = c;
    }
    if (inLen == MAX_MSG_LEN) {
      sendLine();  // full packet, ship it rather than truncating
    }
  }

  if (inLen > 0 && millis() - lastCharAt > INPUT_IDLE_MS) {
    sendLine();
  }
}

static void pollRadio() {
  if (!packetWaiting) {
    return;
  }
  packetWaiting = false;

  String msg;
  int state = radio.readData(msg);
  if (state == RADIOLIB_ERR_NONE) {
    lastRssi = radio.getRSSI();
    lastSnr = radio.getSNR();
    Serial.printf("<< %s  (RSSI %.1f dBm, SNR %.1f dB)\n", msg.c_str(),
                  lastRssi, lastSnr);
    rxCount++;
    lastMsg = msg;
    lastWasRx = true;

    // Hearing anything at all proves the settings still work.
    confirmCfg();

    // The name prefix the sender added sits in front of the marker.
    int marker = msg.indexOf(CFG_PREFIX);
    if (marker >= 0) {
      RadioCfg next;
      // A chat message that merely contains "!CFG " parses as nothing and
      // falls through to the normal path, which re-arms the receiver.
      if (parseCfgMessage(msg.substring(marker), next)) {
        RadioCfg old = cfg;
        cfg = next;
        int st = applyCfg(cfg);
        if (st == RADIOLIB_ERR_NONE) {
          printCfg("~~ other board switched us to");
          armRevert(old);
        } else {
          cfg = old;
          applyCfg(cfg);
          Serial.printf("!! could not follow the change, code %d\n", st);
        }
        drawScreen();
        return;  // applyCfg already re-armed the receiver
      }
    }
  } else if (state == RADIOLIB_ERR_CRC_MISMATCH) {
    Serial.println("!! packet dropped, CRC mismatch");
    lastMsg = "CRC mismatch";
    lastWasRx = false;
  } else {
    Serial.printf("!! readData() failed, code %d\n", state);
    lastMsg = "RX error";
    lastWasRx = false;
  }
  drawScreen();
  radio.startReceive();
}

void setup() {
  // A LoRa transmit blocks for hundreds of ms at high SF while the phone keeps
  // writing; the default 256-byte buffer can drop input in that window.
  Serial.setRxBufferSize(1024);
  Serial.begin(115200);
  delay(2000);  // give the USB bridge time to enumerate before the first print

  pinMode(PIN_BUTTON, INPUT_PULLUP);
  pinMode(PIN_ADC_CTRL, OUTPUT);
  digitalWrite(PIN_ADC_CTRL, ADC_CTRL_ON == LOW ? HIGH : LOW);

  strncpy(nodeName, NODE_NAME, sizeof(nodeName) - 1);
  if (nodeName[0] == '\0') {
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(nodeName, sizeof(nodeName), "%02X%02X", mac[4], mac[5]);
  }

  Serial.printf("\n=== LoRa chat - this board is \"%s\" ===\n", nodeName);

  oledPowerOn();
  Wire.begin(SDA_OLED, SCL_OLED);
  Wire.setClock(400000);
  oledOk = oled.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  if (oledOk) {
    oled.setRotation(0);
    drawScreen();
  } else {
    // Not fatal - the serial chat works fine without a screen.
    Serial.println("!! OLED not found at 0x3C, continuing without it");
  }

  SPI.begin(PIN_LORA_SCK, PIN_LORA_MISO, PIN_LORA_MOSI, PIN_LORA_NSS);

  int state = radio.begin(LORA_FREQ_MHZ, LORA_BW_KHZ, LORA_SF, LORA_CR,
                          LORA_SYNC_WORD, LORA_POWER_DBM, LORA_PREAMBLE,
                          LORA_TCXO_V, false);
  if (state != RADIOLIB_ERR_NONE) {
    halt("radio.begin()", state);
  }

  radio.setDio2AsRfSwitch(true);  // the V3 switches its RF frontend from DIO2
  radio.setPacketReceivedAction(onDio1Rise);

  state = radio.startReceive();
  if (state != RADIOLIB_ERR_NONE) {
    halt("startReceive()", state);
  }

  Serial.printf("on %.1f MHz, SF%d. Type a message and press Enter.\n", cfg.freq,
                cfg.sf);
  Serial.println("/help lists the radio commands.");
}

// PRG wakes the screen and refreshes the stats it shows. Edge-triggered with a
// debounce, so holding it does not redraw in a loop.
static void pollButton() {
  static bool wasDown = false;
  static uint32_t lastEdge = 0;
  bool down = digitalRead(PIN_BUTTON) == LOW;
  if (down != wasDown && millis() - lastEdge > 30) {
    lastEdge = millis();
    wasDown = down;
    if (down) {
      drawScreen();
    }
  }
}

void loop() {
  pollRadio();
  pollSerial();
  pollButton();
  oledSleepCheck();

  // Give the other board something to hear after a settings change.
  if (probeAt && (int32_t)(millis() - probeAt) >= 0) {
    probeAt = 0;
    rawSend(String(nodeName) + ": " + CFG_PROBE);
  }

  // Nothing came back on the new settings, so they are unusable - go back.
  if (revertAt && (int32_t)(millis() - revertAt) >= 0) {
    rollback();
  }
}

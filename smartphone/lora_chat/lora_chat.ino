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
//
// The same line-oriented conversation is also published over Bluetooth LE as a
// Nordic UART Service, so the web app can talk to the board with no cable (and
// any generic BLE terminal app can too). USB and BLE are the same pipe: a line
// arriving on either is handled identically, and every line the board prints
// goes to both.

#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <NimBLEDevice.h>
#include <Preferences.h>
#include <RadioLib.h>
#include <SPI.h>
#include <Wire.h>
#include <esp_mac.h>
#include <esp_sleep.h>

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

// How long PRG has to be held for each action. A plain tap just wakes the
// screen, so nothing destructive can happen by brushing the button. The screen
// names the action while you hold, which is the only discoverable way to put
// four functions on one button.
#define HOLD_SCREEN_MS 1200  // blank the screen now
#define HOLD_BT_MS 3000      // bluetooth on/off
#define HOLD_OFF_MS 6000     // deep sleep, PRG wakes it again

// Battery sense: GPIO37 low connects VBAT through 390k/100k onto GPIO1.
// If this always reads 0.0 V with a battery attached, your board revision
// gates the divider the other way - change ADC_CTRL_ON to HIGH.
#define PIN_ADC_CTRL 37
#define PIN_VBAT 1
#define ADC_CTRL_ON LOW
#define VBAT_DIVIDER 4.9f  // (390k + 100k) / 100k

// Bluetooth LE ------------------------------------------------------------
// Nordic UART Service UUIDs. Not invented here on purpose: picking the de-facto
// standard means off-the-shelf BLE terminal apps can drive the board too, which
// is the quickest way to tell a radio problem from an app problem.
#define NUS_SERVICE "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define NUS_RX_CHAR "6e400002-b5a3-f393-e0a9-e50e24dcca9e"  // phone writes here
#define NUS_TX_CHAR "6e400003-b5a3-f393-e0a9-e50e24dcca9e"  // board notifies here

// Outgoing bytes are queued rather than pushed from inside print(), because a
// notify costs milliseconds and print() is called from the middle of the radio
// path. The queue drains a few packets per loop().
#define BLE_TX_QUEUE 4096
// Inbound bytes cross from the NimBLE task to loop(), so this one needs a lock.
#define BLE_RX_QUEUE 1024

SX1262 radio = new Module(PIN_LORA_NSS, PIN_LORA_DIO1, PIN_LORA_RST, PIN_LORA_BUSY);
Adafruit_SSD1306 oled(OLED_W, OLED_H, &Wire, -1);  // reset handled by hand below

static char nodeName[16];
static volatile bool packetWaiting = false;

// One line assembler per pipe. They must not share a buffer: USB needs an idle
// timeout (the Serial Monitor can be set to send no newline at all) and BLE
// must not have one, because the app writes a line in 20-byte chunks and a
// LoRa transmit blocks for ~230 ms at SF9. A shared buffer let that timeout
// fire between two chunks and transmit half a line.
struct LineIn {
  char buf[MAX_MSG_LEN + 1];
  size_t len;
  uint32_t lastCharAt;
};

static LineIn usbIn = {{0}, 0, 0};
static LineIn bleIn = {{0}, 0, 0};

static bool oledOk = false;
static bool oledAwake = true;
static uint32_t oledLastActive = 0;
static String lastMsg = "waiting...";
static bool lastWasRx = false;
static float lastRssi = 0;
static float lastSnr = 0;
static uint32_t txCount = 0;
static uint32_t rxCount = 0;
static String holdHint;        // what releasing PRG would do right now
static bool holdSwallow = false;  // the press that woke the screen does nothing else

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

// Bluetooth LE bridge -----------------------------------------------------
//
// BLE carries exactly the same newline-terminated lines as USB, so nothing
// above this layer knows or cares which pipe a message came from.

static void feedChar(LineIn &in, char c);  // defined with the serial input
static void powerDown();  // defined with the button, reached by /off too

static Preferences prefs;
static bool bleEnabled = true;
static NimBLEServer *bleServer = nullptr;
static NimBLECharacteristic *bleTx = nullptr;
static volatile uint16_t bleConn = BLE_HS_CONN_HANDLE_NONE;
static volatile uint16_t bleMtu = 23;

static uint8_t bleTxBuf[BLE_TX_QUEUE];
static size_t bleTxHead = 0, bleTxTail = 0;  // both touched only from loop()

static portMUX_TYPE bleRxLock = portMUX_INITIALIZER_UNLOCKED;
static uint8_t bleRxBuf[BLE_RX_QUEUE];
static volatile size_t bleRxHead = 0, bleRxTail = 0;

static bool bleConnected() {
  return bleEnabled && bleConn != BLE_HS_CONN_HANDLE_NONE;
}

// Dropping the oldest output would corrupt a line already half-sent, so a full
// queue drops the newest instead and the reader just misses a diagnostic.
static void bleQueueTx(const uint8_t *data, size_t len) {
  if (!bleConnected()) return;
  for (size_t i = 0; i < len; i++) {
    size_t next = (bleTxHead + 1) % BLE_TX_QUEUE;
    if (next == bleTxTail) return;
    bleTxBuf[bleTxHead] = data[i];
    bleTxHead = next;
  }
}

// Mirrors everything the sketch prints to USB onto BLE as well. Serial stays
// the primary so a board with no phone attached behaves exactly as before.
class SerialAndBle : public Print {
 public:
  size_t write(uint8_t c) override {
    Serial.write(c);
    bleQueueTx(&c, 1);
    return 1;
  }
  size_t write(const uint8_t *buf, size_t len) override {
    Serial.write(buf, len);
    bleQueueTx(buf, len);
    return len;
  }
};

static SerialAndBle out;

class BleServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *s, NimBLEConnInfo &info) override {
    bleConn = info.getConnHandle();
    bleMtu = 23;
    // A stale queue from a previous phone would arrive as a burst of
    // half-finished lines the new one cannot parse, and half a line left in
    // the inbound buffer would be transmitted glued to the next one.
    bleTxHead = bleTxTail = 0;
    bleIn.len = 0;
  }
  void onDisconnect(NimBLEServer *s, NimBLEConnInfo &info, int reason) override {
    bleConn = BLE_HS_CONN_HANDLE_NONE;
    if (bleEnabled) NimBLEDevice::startAdvertising();
  }
  void onMTUChange(uint16_t mtu, NimBLEConnInfo &info) override { bleMtu = mtu; }
};

class BleRxCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *c, NimBLEConnInfo &info) override {
    // Runs on the NimBLE task: copy out and get off this thread quickly.
    const std::string v = c->getValue();
    portENTER_CRITICAL(&bleRxLock);
    for (char ch : v) {
      size_t next = (bleRxHead + 1) % BLE_RX_QUEUE;
      if (next == bleRxTail) break;  // overrun, drop the rest
      bleRxBuf[bleRxHead] = (uint8_t)ch;
      bleRxHead = next;
    }
    portEXIT_CRITICAL(&bleRxLock);
  }
};

static BleServerCallbacks bleServerCallbacks;
static BleRxCallbacks bleRxCallbacks;

static void bleStart() {
  char name[24];
  snprintf(name, sizeof(name), "LoRaChat-%s", nodeName);
  NimBLEDevice::init(name);
  NimBLEDevice::setMTU(247);
  // Bond and encrypt, but "just works" rather than a passkey: the board has a
  // screen but the pairing prompt Web Bluetooth raises is the browser's, and
  // demanding a code there is the single most common reason a phone silently
  // fails to connect. Message privacy is the app's passphrase, not this link.
  NimBLEDevice::setSecurityAuth(true, false, true);
  NimBLEDevice::setSecurityIOCap(BLE_HS_IO_NO_INPUT_OUTPUT);

  bleServer = NimBLEDevice::createServer();
  bleServer->setCallbacks(&bleServerCallbacks, false);

  NimBLEService *svc = bleServer->createService(NUS_SERVICE);
  bleTx = svc->createCharacteristic(
      NUS_TX_CHAR, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::READ_ENC | NIMBLE_PROPERTY::NOTIFY);
  NimBLECharacteristic *rx = svc->createCharacteristic(
      NUS_RX_CHAR,
      NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR | NIMBLE_PROPERTY::WRITE_ENC,
      MAX_MSG_LEN + 32);
  rx->setCallbacks(&bleRxCallbacks);
  svc->start();

  NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
  adv->setName(name);
  adv->addServiceUUID(NUS_SERVICE);
  adv->enableScanResponse(true);
  adv->start();
  out.printf("~~ bluetooth on, advertising as \"%s\"\n", name);
}

static void bleStop() {
  bleConn = BLE_HS_CONN_HANDLE_NONE;
  bleTxHead = bleTxTail = 0;
  bleServer = nullptr;
  bleTx = nullptr;
  if (NimBLEDevice::isInitialized()) NimBLEDevice::deinit(true);
  out.println("~~ bluetooth off");
}

static void bleSetEnabled(bool on) {
  if (on == bleEnabled && (on == (bleServer != nullptr))) return;
  bleEnabled = on;
  prefs.putBool("bt", on);
  if (on) bleStart();
  else bleStop();
}

static void bleForget() {
  if (!NimBLEDevice::isInitialized()) {
    out.println("!! bluetooth is off, nothing to forget");
    return;
  }
  NimBLEDevice::deleteAllBonds();
  if (bleServer) {
    for (uint8_t i = 0; i < bleServer->getConnectedCount(); i++) {
      bleServer->disconnect(bleServer->getPeerInfo(i));
    }
  }
  out.println("~~ bluetooth pairings cleared - pair the phone again");
}

// Drains both directions. Called every loop(), so the budget keeps a long
// backlog from starving the radio.
static void blePump() {
  if (!bleEnabled) return;

  // Inbound: feed the same line assembler the serial port uses.
  while (true) {
    uint8_t c;
    portENTER_CRITICAL(&bleRxLock);
    bool got = bleRxTail != bleRxHead;
    if (got) {
      c = bleRxBuf[bleRxTail];
      bleRxTail = (bleRxTail + 1) % BLE_RX_QUEUE;
    }
    portEXIT_CRITICAL(&bleRxLock);
    if (!got) break;
    feedChar(bleIn, (char)c);
  }

  // Outbound: at most a few notifications per loop, each up to one MTU.
  if (!bleConnected() || !bleTx) return;
  const size_t chunk = bleMtu > 3 ? bleMtu - 3 : 20;
  for (int budget = 4; budget > 0 && bleTxTail != bleTxHead; budget--) {
    uint8_t packet[256];
    size_t n = 0;
    while (n < chunk && n < sizeof(packet) && bleTxTail != bleTxHead) {
      packet[n++] = bleTxBuf[bleTxTail];
      bleTxTail = (bleTxTail + 1) % BLE_TX_QUEUE;
    }
    if (!bleTx->notify(packet, n, bleConn)) break;  // retry on the next loop
  }
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
  oled.setCursor(42, 0);
  oled.printf("%.1f/SF%u", cfg.freq, cfg.sf);
  // Top right: "bt" greyed when advertising, boxed when a phone is on it.
  if (bleEnabled) {
    if (bleConnected()) {
      oled.fillRect(113, 0, 15, 9, SSD1306_WHITE);
      oled.setTextColor(SSD1306_BLACK);
    }
    oled.setCursor(115, 0);
    oled.print("bt");
    oled.setTextColor(SSD1306_WHITE);
  }
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

  // Held-button prompt, inverted along the bottom so it cannot be mistaken for
  // a message. It replaces the counters only while the button is down.
  if (holdHint.length()) {
    oled.fillRect(0, 54, OLED_W, 10, SSD1306_WHITE);
    oled.setTextColor(SSD1306_BLACK);
    oled.setCursor(2, 56);
    oled.print(holdHint);
    oled.setTextColor(SSD1306_WHITE);
  }
  oled.display();
}

// Blank the panel now rather than waiting out OLED_SLEEP_MS.
static void oledOff() {
  if (!oledOk || !oledAwake) return;
  oled.ssd1306_command(SSD1306_DISPLAYOFF);
  oledAwake = false;
}

// Stop here, but say why on the screen as well - a board that failed while
// running on battery has no serial monitor attached to complain to.
static void halt(const char *what, int code) {
  out.printf("%s failed, code %d - halting\n", what, code);
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
  out.printf("%s %.3f MHz, SF%u, BW %.1f kHz, %d dBm\n", tag, cfg.freq, cfg.sf,
                cfg.bw, cfg.power);
}

static void rawSend(const String &payload) {
  int state = radio.transmit(payload.c_str());
  if (state != RADIOLIB_ERR_NONE) {
    out.printf("!! send failed, code %d\n", state);
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
  out.printf("~~ reverting in %lu s unless the link comes back\n",
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
  out.printf("!! nothing heard after the change - rolled back (code %d)\n", state);
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
    out.println("!! invalid setting, ignored");
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
    out.printf("!! could not apply, code %d - unchanged\n", state);
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
  out.println("commands:");
  out.println("  /status          show the current radio settings");
  out.println("  /sf 7..12        spreading factor (higher = further, slower)");
  out.println("  /freq 902.5      frequency in MHz");
  out.println("  /bw 125          bandwidth in kHz (7.8 .. 500)");
  out.println("  /power -9..22    transmit power in dBm");
  out.println("  /revert          undo the last change");
  out.println("  /bt on|off       bluetooth radio (remembered across reboots)");
  out.println("  /bt forget       drop paired phones");
  out.println("  /off             deep sleep; hold PRG to wake");
  out.println("both boards switch together, and roll back if the link drops");
  out.println("PRG button: tap = wake screen, hold 1.2s = screen off,");
  out.println("            3s = bluetooth on/off, 6s = power off");
}

// Returns true if the line was a command and must not go out over the air.
static bool handleCommand(const char *line) {
  if (line[0] != '/') return false;

  char verb[16] = {0};
  float value = 0;
  int got = sscanf(line + 1, "%15s %f", verb, &value);
  if (got < 1) return true;

  // /bt takes a word, not a number, so it is read separately from `value`.
  char word[16] = {0};
  sscanf(line + 1, "%*15s %15s", word);

  if (!strcmp(verb, "help")) {
    showHelp();
  } else if (!strcmp(verb, "off")) {
    powerDown();
  } else if (!strcmp(verb, "bt")) {
    if (!strcmp(word, "on")) {
      bleSetEnabled(true);
    } else if (!strcmp(word, "off")) {
      bleSetEnabled(false);
    } else if (!strcmp(word, "forget")) {
      bleForget();
    } else {
      out.printf("~~ bluetooth %s%s - try /bt on, /bt off or /bt forget\n",
                    bleEnabled ? "on" : "off", bleConnected() ? ", phone connected" : "");
    }
  } else if (!strcmp(verb, "status")) {
    printCfg("~~ on");
    out.printf("~~ node %s, TX %lu, RX %lu\n", nodeName, txCount, rxCount);
    out.printf("~~ bluetooth %s%s\n", bleEnabled ? "on" : "off",
                  bleConnected() ? ", phone connected" : "");
    float vbat = batteryVolts();
    if (vbat > 0) {
      out.printf("~~ battery %.2f V\n", vbat);
    } else {
      out.println("~~ battery not detected (USB power?)");
    }
  } else if (!strcmp(verb, "revert")) {
    if (revertAt == 0) {
      out.println("!! nothing to revert");
    } else {
      rollback();
    }
  } else if (got < 2) {
    out.printf("!! /%s needs a value - try /help\n", verb);
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
    out.printf("!! unknown command /%s - try /help\n", verb);
  }
  return true;
}

static void sendLine(LineIn &in) {
  if (in.len == 0) {
    return;
  }
  in.buf[in.len] = '\0';
  in.len = 0;

  if (handleCommand(in.buf)) {
    return;
  }

  String payload = String(nodeName) + ": " + in.buf;
  int state = radio.transmit(payload.c_str());
  if (state == RADIOLIB_ERR_NONE) {
    out.printf(">> %s\n", in.buf);
    txCount++;
    lastMsg = in.buf;
    lastWasRx = false;
  } else {
    out.printf("!! send failed, code %d\n", state);
    lastMsg = "send failed";
    lastWasRx = false;
  }
  drawScreen();

  // transmit() raises DIO1 on TxDone, which sets the same flag the RX path
  // uses - drop it so we don't read a phantom packet.
  packetWaiting = false;
  radio.startReceive();
}

static void feedChar(LineIn &in, char c) {
  in.lastCharAt = millis();

  if (c == '\r') {
    return;
  }
  if (c == '\n') {
    sendLine(in);
    return;
  }
  if (in.len < MAX_MSG_LEN) {
    in.buf[in.len++] = c;
  }
  if (in.len == MAX_MSG_LEN) {
    sendLine(in);  // full packet, ship it rather than truncating
  }
}

static void pollSerial() {
  while (Serial.available()) {
    feedChar(usbIn, (char)Serial.read());
  }

  // USB only. A terminal set to "No Line Ending" never sends one, so a lull
  // has to count as end-of-message. BLE always terminates its lines, so
  // applying this there would cut messages in half instead.
  if (usbIn.len > 0 && millis() - usbIn.lastCharAt > INPUT_IDLE_MS) {
    sendLine(usbIn);
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
    out.printf("<< %s  (RSSI %.1f dBm, SNR %.1f dB)\n", msg.c_str(),
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
          out.printf("!! could not follow the change, code %d\n", st);
        }
        drawScreen();
        return;  // applyCfg already re-armed the receiver
      }
    }
  } else if (state == RADIOLIB_ERR_CRC_MISMATCH) {
    out.println("!! packet dropped, CRC mismatch");
    lastMsg = "CRC mismatch";
    lastWasRx = false;
  } else {
    out.printf("!! readData() failed, code %d\n", state);
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

  out.printf("\n=== LoRa chat - this board is \"%s\" ===\n", nodeName);

  oledPowerOn();
  Wire.begin(SDA_OLED, SCL_OLED);
  Wire.setClock(400000);
  oledOk = oled.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  if (oledOk) {
    oled.setRotation(0);
    drawScreen();
  } else {
    // Not fatal - the serial chat works fine without a screen.
    out.println("!! OLED not found at 0x3C, continuing without it");
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

  // Last, so a BLE stack that misbehaves cannot stop the radio coming up.
  prefs.begin("lorachat", false);
  bleEnabled = prefs.getBool("bt", true);
  if (bleEnabled) bleStart();
  else out.println("~~ bluetooth off (/bt on to enable)");
  drawScreen();

  out.printf("on %.1f MHz, SF%d. Type a message and press Enter.\n", cfg.freq,
                cfg.sf);
  out.println("/help lists the radio commands.");
  out.println("PRG: tap = screen, hold 3s = bluetooth, hold 6s = power off.");
}

// Everything off and into deep sleep. This is as close to a power switch as a
// board with no power switch gets: the CPU, the radio and Bluetooth all stop,
// and only the RTC stays alive watching PRG. Waking is a fresh boot, so the
// radio comes back on the settings in flash, not whatever /sf left it on.
static void powerDown() {
  out.println("~~ powering down - hold PRG to wake");

  if (oledOk) {
    oled.clearDisplay();
    oled.setTextColor(SSD1306_WHITE);
    oled.setTextSize(1);
    oled.setCursor(0, 24);
    oled.println("  OFF - hold PRG");
    oled.println("     to wake");
    oled.display();
    delay(1200);
  }
  oledOff();

  radio.sleep();  // otherwise the SX1262 keeps drawing receive current
  if (NimBLEDevice::isInitialized()) NimBLEDevice::deinit(true);
  digitalWrite(Vext, HIGH);  // cut the OLED rail (active LOW)

  // Arming a low-level wake while the button is still down would wake us
  // immediately, so wait for the release first.
  while (digitalRead(PIN_BUTTON) == LOW) delay(10);
  delay(100);

  // PRG is GPIO0, which is in the S3's RTC domain and so can wake from deep
  // sleep. 0 = wake when it is pulled low again.
  esp_sleep_enable_ext0_wakeup((gpio_num_t)PIN_BUTTON, 0);
  esp_deep_sleep_start();
}

// PRG is the only control on the board, so it carries four actions chosen by
// how long it is held. Edge-triggered with a debounce; the hint on screen is
// refreshed only when the wording changes, not every loop.
static void pollButton() {
  static bool wasDown = false;
  static uint32_t lastEdge = 0, pressAt = 0;
  bool down = digitalRead(PIN_BUTTON) == LOW;

  if (down != wasDown && millis() - lastEdge > 30) {
    lastEdge = millis();
    wasDown = down;
    if (down) {
      // A press on a dark screen only turns it back on. Without this, reaching
      // for the board in the dark could silently switch Bluetooth off.
      holdSwallow = !oledAwake;
      pressAt = millis();
      drawScreen();
    } else {
      uint32_t held = millis() - pressAt;
      holdHint = "";
      if (holdSwallow) {
        drawScreen();
      } else if (held >= HOLD_OFF_MS) {
        powerDown();
      } else if (held >= HOLD_BT_MS) {
        bleSetEnabled(!bleEnabled);
        drawScreen();
      } else if (held >= HOLD_SCREEN_MS) {
        oledOff();
      } else {
        drawScreen();
      }
    }
  }

  if (down && !holdSwallow) {
    uint32_t held = millis() - pressAt;
    String want;
    if (held >= HOLD_OFF_MS) want = "release: power off";
    else if (held >= HOLD_BT_MS) want = bleEnabled ? "release: bluetooth off" : "release: bluetooth on";
    else if (held >= HOLD_SCREEN_MS) want = "release: screen off";
    if (want != holdHint) {
      holdHint = want;
      drawScreen();
    }
  }
}

void loop() {
  pollRadio();
  pollSerial();
  blePump();
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

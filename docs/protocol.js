// Parses the serial lines lora_chat prints. Kept free of browser APIs so it can
// be unit-tested under node (see test/protocol.test.mjs).
//
// The firmware emits:
//   === LoRa chat - this board is "8424" ===
//   on 915.0 MHz, SF9. Type a message and press Enter.
//   >> hello there
//   << 3D2C: hi back  (RSSI -23.0 dBm, SNR 11.5 dB)
//   !! send failed, code -706

const BANNER_RE = /^===\s*LoRa chat - this board is "(.+)"\s*===$/;
const RADIO_RE = /^on\s+([\d.]+)\s+MHz,\s+SF(\d+)\./;
// The firmware reports settings on a "~~" line after any change or /status:
//   ~~ now on 915.000 MHz, SF10, BW 125.0 kHz, 14 dBm
// Tracking these is what lets the app compute link margin for the current SF.
const CFG_RE = /^~~\s+.*?([\d.]+)\s+MHz,\s+SF(\d+),\s+BW\s+([\d.]+)\s+kHz,\s+(-?\d+)\s+dBm/;
// Greedy payload plus an anchored tail, so a message containing "  (RSSI" of
// its own still splits at the real suffix the firmware appended.
// "~~ battery 4.05 V", or "~~ battery not detected (USB power?)" with no cell
// fitted. Pulled out of the generic "~~" notes so polling it does not fill the
// log with one line every refresh.
const BATT_RE = /^~~\s+battery\s+([\d.]+)\s*V\b/;
const BATT_NONE_RE = /^~~\s+battery\s+not detected/;
const RECV_RE = /^<<\s(.*)\s{2}\(RSSI\s(-?[\d.]+)\sdBm,\sSNR\s(-?[\d.]+)\sdB\)$/;
const SENT_RE = /^>>\s(.*)$/;
const ERROR_RE = /^!!\s(.*)$/;

export function parseLine(raw) {
  const line = String(raw).replace(/\r/g, '').trim();
  if (!line) return null;

  const banner = BANNER_RE.exec(line);
  if (banner) return { kind: 'banner', node: banner[1], text: line };

  const radio = RADIO_RE.exec(line);
  if (radio) {
    return {
      kind: 'radio',
      freq: parseFloat(radio[1]),
      sf: parseInt(radio[2], 10),
      text: line,
    };
  }

  // Before CFG_RE: a battery line is also a "~~" note, and must not be mistaken
  // for one carrying radio settings.
  const batt = BATT_RE.exec(line);
  if (batt) return { kind: 'battery', mv: Math.round(parseFloat(batt[1]) * 1000), text: line };
  if (BATT_NONE_RE.test(line)) return { kind: 'battery', mv: 0, text: line };

  const cfgLine = CFG_RE.exec(line);
  if (cfgLine) {
    return {
      kind: 'cfg',
      freq: parseFloat(cfgLine[1]),
      sf: parseInt(cfgLine[2], 10),
      bw: parseFloat(cfgLine[3]),
      power: parseInt(cfgLine[4], 10),
      text: line,
    };
  }

  const recv = RECV_RE.exec(line);
  if (recv) {
    const { from, text } = splitSender(recv[1]);
    return {
      kind: 'recv',
      from,
      text,
      rssi: parseFloat(recv[2]),
      snr: parseFloat(recv[3]),
    };
  }

  const sent = SENT_RE.exec(line);
  if (sent) return { kind: 'sent', text: sent[1] };

  const err = ERROR_RE.exec(line);
  if (err) return { kind: 'error', text: err[1] };

  return { kind: 'system', text: line };
}

// Payloads are "NAME: message". NODE_NAME has no colon in it, so the first
// ": " is the separator; anything else is treated as an unnamed message.
function splitSender(payload) {
  const at = payload.indexOf(': ');
  if (at <= 0) return { from: null, text: payload };
  return { from: payload.slice(0, at), text: payload.slice(at + 2) };
}

// -80 dBm and up is a comfortable link; below -100 is nearly out of range.
export function signalLevel(rssi) {
  if (rssi === null || rssi === undefined) return 'none';
  if (rssi >= -80) return 'good';
  if (rssi >= -100) return 'fair';
  return 'weak';
}

// Splits a byte stream into lines across chunk boundaries.
export class LineSplitter {
  constructor(onLine) {
    this.onLine = onLine;
    this.buf = '';
    this.decoder = new TextDecoder();
  }

  push(chunk) {
    this.buf += this.decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.trim()) this.onLine(line);
    }
    // A board mid-sentence can leave a partial line buffered forever; cap it so
    // binary noise on a wrong baud rate cannot grow without bound.
    if (this.buf.length > 4096) this.buf = '';
  }
}

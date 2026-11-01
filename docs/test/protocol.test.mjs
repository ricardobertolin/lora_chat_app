// node --test test/protocol.test.mjs
// Lines below are copied verbatim from real COM4/COM6 sessions.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLine, signalLevel, LineSplitter } from '../protocol.js';

test('parses a received message with signal stats', () => {
  const r = parseLine('<< 3D2C: and this is COM6 answering  (RSSI -23.0 dBm, SNR 11.5 dB)');
  assert.equal(r.kind, 'recv');
  assert.equal(r.from, '3D2C');
  assert.equal(r.text, 'and this is COM6 answering');
  assert.equal(r.rssi, -23);
  assert.equal(r.snr, 11.5);
});

test('parses a sent echo', () => {
  assert.deepEqual(parseLine('>> hello from the COM4 board'), {
    kind: 'sent',
    text: 'hello from the COM4 board',
  });
});

test('parses the battery line without mistaking it for a radio note', () => {
  const r = parseLine('~~ battery 4.05 V');
  assert.equal(r.kind, 'battery');
  assert.equal(r.mv, 4050);

  const none = parseLine('~~ battery not detected (USB power?)');
  assert.equal(none.kind, 'battery');
  assert.equal(none.mv, 0);

  // Both are "~~" notes, so the settings line must still win its own match.
  assert.equal(parseLine('~~ now on 915.000 MHz, SF10, BW 125.0 kHz, 14 dBm').kind, 'cfg');
});

test('parses the banner and pulls out the node name', () => {
  const r = parseLine('=== LoRa chat - this board is "8424" ===');
  assert.equal(r.kind, 'banner');
  assert.equal(r.node, '8424');
});

test('parses the radio settings line', () => {
  const r = parseLine('on 915.0 MHz, SF9. Type a message and press Enter.');
  assert.equal(r.kind, 'radio');
  assert.equal(r.freq, 915);
  assert.equal(r.sf, 9);
});

test('parses firmware errors', () => {
  assert.deepEqual(parseLine('!! send failed, code -706'), {
    kind: 'error',
    text: 'send failed, code -706',
  });
  assert.equal(parseLine('!! packet dropped, CRC mismatch').kind, 'error');
});

test('parses the firmware settings lines in all their wordings', () => {
  for (const line of [
    '~~ now on 915.000 MHz, SF10, BW 125.0 kHz, 14 dBm',
    '~~ on 915.000 MHz, SF10, BW 125.0 kHz, 14 dBm',
    '~~ back on 915.000 MHz, SF10, BW 125.0 kHz, 14 dBm',
    '~~ link confirmed on 915.000 MHz, SF10, BW 125.0 kHz, 14 dBm',
    '~~ other board switched us to 915.000 MHz, SF10, BW 125.0 kHz, 14 dBm',
  ]) {
    const r = parseLine(line);
    assert.equal(r.kind, 'cfg', line);
    assert.equal(r.sf, 10);
    assert.equal(r.freq, 915);
    assert.equal(r.bw, 125);
    assert.equal(r.power, 14);
  }
});

test('a negative transmit power parses', () => {
  assert.equal(parseLine('~~ on 868.000 MHz, SF12, BW 250.0 kHz, -9 dBm').power, -9);
});

test('other tilde lines are not mistaken for settings', () => {
  assert.equal(parseLine('~~ reverting in 30 s unless the link comes back').kind, 'system');
});

test('boot noise falls through to system', () => {
  assert.equal(parseLine('ESP-ROM:esp32s3-20210327').kind, 'system');
});

test('blank lines are ignored', () => {
  assert.equal(parseLine(''), null);
  assert.equal(parseLine('  \r'), null);
});

test('a message containing the RSSI suffix still splits at the real one', () => {
  const r = parseLine(
    '<< 8424: look  (RSSI -1.0 dBm, SNR 0.0 dB)  (RSSI -23.0 dBm, SNR 11.5 dB)'
  );
  assert.equal(r.text, 'look  (RSSI -1.0 dBm, SNR 0.0 dB)');
  assert.equal(r.rssi, -23);
});

test('a message with colons keeps them', () => {
  const r = parseLine('<< 8424: time: 12:30  (RSSI -20.0 dBm, SNR 9.0 dB)');
  assert.equal(r.from, '8424');
  assert.equal(r.text, 'time: 12:30');
});

test('an unnamed payload is not mistaken for a sender', () => {
  const r = parseLine('<< no-sender-here  (RSSI -20.0 dBm, SNR 9.0 dB)');
  assert.equal(r.from, null);
  assert.equal(r.text, 'no-sender-here');
});

test('signalLevel buckets', () => {
  assert.equal(signalLevel(-23), 'good');
  assert.equal(signalLevel(-80), 'good');
  assert.equal(signalLevel(-95), 'fair');
  assert.equal(signalLevel(-120), 'weak');
  assert.equal(signalLevel(null), 'none');
});

test('LineSplitter reassembles lines across chunk boundaries', () => {
  const seen = [];
  const s = new LineSplitter((l) => seen.push(l));
  const enc = new TextEncoder();
  s.push(enc.encode('>> par'));
  s.push(enc.encode('tial\n>> second\n>> incomplete'));
  assert.deepEqual(seen, ['>> partial', '>> second']);
  s.push(enc.encode('\n'));
  assert.deepEqual(seen, ['>> partial', '>> second', '>> incomplete']);
});

test('LineSplitter tolerates CRLF and drops blank lines', () => {
  const seen = [];
  const s = new LineSplitter((l) => seen.push(l));
  s.push(new TextEncoder().encode('a\r\n\r\nb\r\n'));
  assert.deepEqual(seen.map((l) => parseLine(l).text), ['a', 'b']);
});

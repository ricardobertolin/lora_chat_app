// node --test test/messaging.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeMessage,
  decodeMessage,
  encodeAck,
  decodeAck,
  encodeHello,
  decodeHello,
  cleanNick,
  validNick,
  displayName,
  createSeen,
  MAX_NICK,
} from '../messaging.js';

test('messages round-trip with their sequence', () => {
  assert.deepEqual(decodeMessage(encodeMessage(12, 'meet at the bridge')), {
    seq: 12,
    text: 'meet at the bridge',
  });
});

test('message text may contain anything, including the markers', () => {
  for (const text of ['!ACK 8424 1', '!M5 nested', 'a: b: c', '  spaced  ', 'emoji 📡']) {
    assert.equal(decodeMessage(encodeMessage(1, text)).text, text, text);
  }
});

test('an empty message body still decodes', () => {
  assert.equal(decodeMessage(encodeMessage(3, '')).text, '');
});

test('decodeMessage refuses non-messages', () => {
  assert.equal(decodeMessage('hello there'), null);
  assert.equal(decodeMessage('!M hello'), null, 'no sequence number');
  assert.equal(decodeMessage('!Mabc hello'), null);
  assert.equal(decodeMessage(null), null);
});

test('encodeMessage rejects a bad sequence', () => {
  assert.throws(() => encodeMessage(-1, 'x'), /bad sequence/);
  assert.throws(() => encodeMessage(1.5, 'x'), /bad sequence/);
});

test('acks name the original sender, not the acknowledger', () => {
  assert.deepEqual(decodeAck(encodeAck('8424', 7)), { to: '8424', seq: 7 });
});

test('decodeAck refuses malformed lines', () => {
  assert.equal(decodeAck('!ACK 8424'), null, 'no sequence');
  assert.equal(decodeAck('!ACK'), null);
  assert.equal(decodeAck('!ACK 8424 x'), null);
  assert.equal(decodeAck('hello'), null);
});

test('hello carries an optional nickname', () => {
  assert.deepEqual(decodeHello(encodeHello('RICARDO')), { nick: 'RICARDO' });
  assert.deepEqual(decodeHello(encodeHello(null)), { nick: null });
  assert.deepEqual(decodeHello('!HI'), { nick: null });
});

test('a hello with no nickname is distinguishable from a non-hello', () => {
  assert.notEqual(decodeHello('!HI'), null, 'a bare hello is still a hello');
  assert.equal(decodeHello('!HELLO'), null);
  assert.equal(decodeHello('hi'), null);
});

test('nicknames are trimmed, capped and stripped of line breaks', () => {
  assert.equal(cleanNick('  RICARDO  '), 'RICARDO');
  assert.equal(cleanNick('two\nlines'), 'two lines', 'newlines would split the protocol');
  assert.equal(cleanNick('a'.repeat(50)).length, MAX_NICK);
  assert.equal(cleanNick(''), null);
  assert.equal(cleanNick('   '), null);
  assert.equal(cleanNick(null), null);
});

test('leading whitespace does not eat the length limit', () => {
  // Trimming happens before capping, so padding cannot push out real characters.
  assert.equal(cleanNick('          RICARDO'), 'RICARDO');
  assert.equal(cleanNick('\t\n  '), null, 'whitespace only is still nothing');
});

test('nicknames with spaces survive the round trip', () => {
  assert.equal(decodeHello(encodeHello('Ana Maria')).nick, 'Ana Maria');
});

test('validNick agrees with cleanNick', () => {
  assert.equal(validNick('OK'), true);
  assert.equal(validNick('  '), false);
});

test('display falls back to the MAC-derived name', () => {
  assert.equal(displayName({ name: '8424', nick: 'RICARDO' }), 'RICARDO');
  assert.equal(displayName({ name: '8424', nick: null }), '8424');
  assert.equal(displayName(null), 'peer');
});

test('a retried message is recognised as already seen', () => {
  const seen = createSeen();
  assert.equal(seen.seen('8424', 7), false, 'first sighting');
  assert.equal(seen.seen('8424', 7), true, 'the retry');
  assert.equal(seen.seen('8424', 8), false, 'next message is new');
  assert.equal(seen.seen('3D2C', 7), false, 'same seq from another sender is new');
});

test('seen pairs cannot collide across the separator', () => {
  const seen = createSeen();
  seen.seen('84', 27);
  assert.equal(seen.seen('842', 7), false, '"84"+27 must not equal "842"+7');
});

test('the seen list forgets beyond its cap', () => {
  const seen = createSeen(3);
  seen.seen('A', 1);
  seen.seen('A', 2);
  seen.seen('A', 3);
  seen.seen('A', 4);  // pushes A#1 out
  assert.equal(seen.seen('A', 1), false, 'evicted, so treated as new again');
  assert.equal(seen.seen('A', 4), true, 'recent ones are still remembered');
});

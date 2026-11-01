// Wires the transport to the chat UI. The firmware needs no changes: it already
// speaks newline-delimited text at 115200 in both directions.

import { parseLine, signalLevel } from './protocol.js';
import {
  encodePosition,
  decodePosition,
  isPosition,
  describeRelative,
  distanceM,
  bearingDeg,
  MAX_ACCURACY_M,
} from './position.js';
import { deriveKey, encryptMessage, decryptMessage, isEncrypted } from './crypto.js';
import * as history from './history.js';
import * as survey from './survey.js';
import * as audio from './audio.js';
import * as frag from './fragment.js';
import * as media from './media.js';
import * as presence from './presence.js';
import { drawRadar } from './radar.js';
import { applyAccent, readAccent } from './theme.js';
import { VERSION } from './version.js';
import * as channel from './channel.js';
import * as msg from './messaging.js';
import * as outbox from './outbox.js';
import { paintFavicon } from './favicon.js';
import qrcode from './vendor/qrcode.js';
import {
  pickTransport,
  describeCapabilities,
  probeAnyUsbDevice,
  alreadyPermitted,
  WebSerialTransport,
  WebUsbCp210xTransport,
  WebBluetoothTransport,
} from './transport.js';

const els = {
  connect: document.getElementById('connect'),
  status: document.getElementById('status'),
  statusText: document.getElementById('statusText'),
  sub: document.getElementById('sub'),
  banner: document.getElementById('banner'),
  log: document.getElementById('log'),
  form: document.getElementById('composer'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  diag: document.getElementById('diag'),
  posBtn: document.getElementById('posBtn'),
  posPanel: document.getElementById('posPanel'),
  myPos: document.getElementById('myPos'),
  useGps: document.getElementById('useGps'),
  manualBtn: document.getElementById('manualBtn'),
  manualRow: document.getElementById('manualRow'),
  mLat: document.getElementById('mLat'),
  mLon: document.getElementById('mLon'),
  mSave: document.getElementById('mSave'),
  shareBtn: document.getElementById('shareBtn'),
  posClear: document.getElementById('posClear'),
  peers: document.getElementById('peers'),
  setBtn: document.getElementById('setBtn'),
  setPanel: document.getElementById('setPanel'),
  passIn: document.getElementById('passIn'),
  encOn: document.getElementById('encOn'),
  encOff: document.getElementById('encOff'),
  encState: document.getElementById('encState'),
  histState: document.getElementById('histState'),
  histClear: document.getElementById('histClear'),
  histKeep: document.getElementById('histKeep'),
  accentIn: document.getElementById('accentIn'),
  radar: document.getElementById('radar'),
  ver: document.getElementById('ver'),
  updateBar: document.getElementById('updateBar'),
  updateNow: document.getElementById('updateNow'),
  shareBtn2: document.getElementById('shareBtn2'),
  scanBtn: document.getElementById('scanBtn'),
  shareBox: document.getElementById('shareBox'),
  shareDesc: document.getElementById('shareDesc'),
  shareLink: document.getElementById('shareLink'),
  copyLink: document.getElementById('copyLink'),
  shareClose: document.getElementById('shareClose'),
  qr: document.getElementById('qr'),
  scanBox: document.getElementById('scanBox'),
  scanVideo: document.getElementById('scanVideo'),
  scanStop: document.getElementById('scanStop'),
  nickIn: document.getElementById('nickIn'),
  nickSave: document.getElementById('nickSave'),
  linkState: document.getElementById('linkState'),
  linkCable: document.getElementById('linkCable'),
  linkBt: document.getElementById('linkBt'),
  linkBar: document.getElementById('linkBar'),
  linkBarCable: document.getElementById('linkBarCable'),
  linkBarBt: document.getElementById('linkBarBt'),
  linkBarHint: document.getElementById('linkBarHint'),
  chatBtn: document.getElementById('chatBtn'),
  outState: document.getElementById('outState'),
  outClear: document.getElementById('outClear'),
  outRetry: document.getElementById('outRetry'),
  outList: document.getElementById('outList'),
  outCount: document.getElementById('outCount'),
  soundState: document.getElementById('soundState'),
  soundToggle: document.getElementById('soundToggle'),
  testBtn: document.getElementById('testBtn'),
  testPanel: document.getElementById('testPanel'),
  testInterval: document.getElementById('testInterval'),
  testStart: document.getElementById('testStart'),
  testStop: document.getElementById('testStop'),
  testCsv: document.getElementById('testCsv'),
  testState: document.getElementById('testState'),
  testStats: document.getElementById('testStats'),
  testMeter: document.getElementById('testMeter'),
  callBtn: document.getElementById('callBtn'),
  callBanner: document.getElementById('callBanner'),
  callText: document.getElementById('callText'),
  answerBtn: document.getElementById('answerBtn'),
  dismissBtn: document.getElementById('dismissBtn'),
  mediaBtn: document.getElementById('mediaBtn'),
  mediaPanel: document.getElementById('mediaPanel'),
  mediaState: document.getElementById('mediaState'),
  imgBtn: document.getElementById('imgBtn'),
  imgFile: document.getElementById('imgFile'),
  audBtn: document.getElementById('audBtn'),
  audFile: document.getElementById('audFile'),
  recBtn: document.getElementById('recBtn'),
  imgWidth: document.getElementById('imgWidth'),
  audRate: document.getElementById('audRate'),
  xfer: document.getElementById('xfer'),
  xferFill: document.getElementById('xferFill'),
  xferText: document.getElementById('xferText'),
  xferCancel: document.getElementById('xferCancel'),
};

let transport = null;
let nodeName = null;
let lastRssi = null;

// Position sharing --------------------------------------------------------
// One update a minute. At SF9 a position costs roughly a third of a second of
// airtime, so this stays a rounding error on a channel shared by a few people.
const SHARE_INTERVAL_MS = 60000;
const STORE_KEY = 'lora-chat-position';

let myPos = null;      // { lat, lon, accuracy, source }
let watchId = null;
let shareTimer = null;

// Presence ----------------------------------------------------------------
// Raw LoRa has no association step - anyone on the frequency simply hears you.
// So joining is announced, any traffic counts as a sign of life, and silence
// past a timeout is treated as having left.
const HELLO_INTERVAL_MS = 120000;
const nodes = new Map();   // name -> presence node, carrying an optional position
let helloTimer = null;

const HISTORY_KEEP_KEY = 'lora-chat-keep-history';
let keepHistory = true;

// Delivery and the outbox -------------------------------------------------
// A message unacknowledged after this is treated as lost. Generous, because at
// SF12 a round trip is several seconds before anyone has typed a reply.
const ACK_TIMEOUT_MS = 25000;
const NICK_KEY = 'lora-chat-nick';

let myNick = null;
let msgSeq = 0;
const pendingAcks = new Map();   // seq -> { el, timer, text }
let queued = [];                 // outbox, persisted
// A retried message (its ack was lost) is re-acked but not shown again.
const seenChats = msg.createSeen();

// Encryption --------------------------------------------------------------
// The passphrase is kept in localStorage so the app is usable across reloads.
// That means anyone with the unlocked device can read it - the threat this
// protects against is someone listening on the air, not someone holding
// your phone.
const PASS_KEY = 'lora-chat-passphrase';
let cryptoKey = null;

let log = [];  // persisted chat history

// Link test and calling ---------------------------------------------------
const SOUND_KEY = 'lora-chat-sound';

// Cable or Bluetooth. Remembered, because whichever one you use is a property
// of how you carry the board, not of a single session.
const LINK_KEY = 'lora-chat-link';
let linkMode = 'cable';
const CALL_REPEAT_MS = 4000;

// Tracked from the firmware's settings lines, so sharing a channel sends what
// the radio is actually on rather than what the app assumes.
let currentSf = 9;
let currentFreq = 915;
let currentBw = 125;
let currentPower = 14;
let activeSurvey = null;
let surveyTimer = null;
let surveyRender = null;
let probeSeq = 0;

// How long a dismissal keeps us quiet, so the caller's next repeat does not
// immediately start the ringing again.
const DISMISS_QUIET_MS = 60000;

let callTimer = null;      // we are calling out
let ringingFrom = null;    // someone is calling us
let ringWatchdog = null;
let dismissedUntil = 0;
let dismissedFrom = null;  // the quiet period only applies to who you hung up on

// Media transfer ----------------------------------------------------------
// Give up on a fragment whose echo never came back, and on an inbound transfer
// that has gone quiet.
const FRAG_ECHO_TIMEOUT_MS = 12000;
const ASSEMBLY_IDLE_MS = 90000;
const MAX_RESEND_ROUNDS = 3;

let outgoing = null;              // { id, lines, queue, timer, kind }
const assemblies = new Map();     // id -> assembly
let recorder = null;
let recordChunks = [];

function setConnected(on) {
  els.status.classList.toggle('on', on);
  els.statusText.textContent = on ? 'connected' : 'offline';
  els.connect.textContent = on ? 'Disconnect' : 'Connect';
  els.connect.classList.toggle('ghost', on);
  // The composer stays usable while disconnected - what you type is queued in
  // the outbox and goes out when a board is attached.
  els.input.disabled = false;
  els.send.disabled = false;
  els.input.placeholder = on ? 'Type a message' : 'Not connected - messages will be queued';
  if (on) els.input.focus();
  updateSubtitle();
  // "Send now" is only meaningful with a board attached.
  renderOutbox();
  renderLinkBar(on);
  // Connecting means you are done setting up and want the conversation. Any
  // panel left open would otherwise sit over the log until dismissed by hand.
  if (on) closePanels();
}

function updateSubtitle() {
  const bits = [];
  if (nodeName) bits.push(`node ${nodeName}`);
  // The radio settings used to live only in a banner that was never dismissed.
  // Keeping them here means the banner can come and go without losing them.
  if (nodeName) bits.push(`${currentFreq} MHz · SF${currentSf}`);
  if (lastRssi !== null) bits.push(`last RSSI ${lastRssi} dBm`);
  els.sub.textContent = bits.length ? bits.join(' · ') : 'not connected';
}

// The banner is a reminder, not an error, so it must not stay on screen: show
// it only when the settings actually change, time it out, and let a tap clear
// it early.
const BANNER_MS = 12000;
let bannerTimer = null;
let bannerShownFor = '';

function hideBanner() {
  clearTimeout(bannerTimer);
  bannerTimer = null;
  els.banner.classList.remove('show');
}

function showRadioBanner(freq, sf) {
  const key = `${freq}|${sf}`;
  // Reconnecting re-prints the same radio line; repeating a notice you have
  // already read is exactly what made it feel permanent.
  if (key === bannerShownFor) return;
  bannerShownFor = key;
  els.banner.textContent = `${freq} MHz · SF${sf} - the other board must match (tap to dismiss)`;
  els.banner.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(hideBanner, BANNER_MS);
}

function atBottom() {
  return els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 60;
}

function append(node) {
  const stick = atBottom();
  els.log.appendChild(node);
  if (stick) els.log.scrollTop = els.log.scrollHeight;
}

function note(text, isError = false) {
  const d = document.createElement('div');
  d.className = 'note' + (isError ? ' err' : '');
  d.textContent = text;
  append(d);
}

function bubble({ mine, who, text, rssi, snr, locked, status, at, persist = true }) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (mine ? 'sent' : 'recv');

  if (who || rssi !== undefined || locked || status) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    if (who) {
      const w = document.createElement('span');
      w.className = 'who';
      w.textContent = who;
      meta.appendChild(w);
    }
    if (locked) {
      const l = document.createElement('span');
      l.className = 'lock';
      l.textContent = 'enc';
      l.title = 'encrypted in transit';
      meta.appendChild(l);
    }
    if (status) {
      const s = document.createElement('span');
      s.className = 'ack';
      s.dataset.state = status;
      s.textContent = status;
      meta.appendChild(s);
    }
    if (rssi !== undefined && rssi !== null) {
      const s = document.createElement('span');
      s.className = 'sig ' + signalLevel(rssi);
      s.textContent = `${rssi} dBm / ${snr} dB`;
      meta.appendChild(s);
    }
    wrap.appendChild(meta);
  }

  const body = document.createElement('div');
  body.textContent = text;
  wrap.appendChild(body);
  append(wrap);
  wrap.dataset.text = text;

  if (persist && keepHistory) {
    log = history.appendEntry(log, {
      mine,
      who: who || null,
      text,
      rssi: rssi ?? null,
      snr: snr ?? null,
      locked: !!locked,
      at: at ?? Date.now(),
    });
    history.save(log);
    renderHistoryState();
  }
  // sendChat keeps this element to flip its delivery tag as acks come in.
  return wrap;
}

function renderHistoryState() {
  els.histKeep.textContent = `Keep: ${keepHistory ? 'on' : 'off'}`;
  els.histState.textContent = !keepHistory
    ? 'not saving'
    : log.length
      ? `${log.length} message${log.length === 1 ? '' : 's'} kept`
      : 'empty';
}

// Replays the stored conversation on load. persist:false so redrawing does not
// append the same messages again.
function restoreHistory() {
  log = history.load();
  renderHistoryState();
  if (!log.length) return;

  for (const e of log) {
    bubble({
      mine: e.mine,
      who: e.who,
      text: e.text,
      rssi: e.rssi ?? undefined,
      snr: e.snr ?? undefined,
      locked: e.locked,
      persist: false,
    });
  }
  const d = document.createElement('div');
  d.className = 'note';
  d.textContent = `--- earlier (${history.formatStamp(log[log.length - 1].at)}) ---`;
  els.log.appendChild(d);
  els.log.scrollTop = els.log.scrollHeight;
}

// Everything the app sends goes through here, so encryption and the command
// exemption are applied in exactly one place.
async function sendText(text) {
  if (!transport) return false;
  const outgoing = cryptoKey && !text.startsWith('/') ? await encryptMessage(cryptoKey, text) : text;
  await transport.send(outgoing);
  return true;
}

// U+FFFD renders as a bare "?" diamond that says nothing about what arrived.
// Showing the code point instead turns "spammed garbage" into evidence.
function escapeForNote(text, max = 80) {
  const shown = text.length > max ? `${text.slice(0, max)}...` : text;
  return shown.replace(/[^\x20-\x7E]/g, (c) =>
    `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`
  );
}

async function handleRecv(ev) {
  lastRssi = ev.rssi;
  updateSubtitle();

  // Firmware control traffic is never encrypted - the board has to read it.
  // It still proves the peer is alive, so presence is touched on the way out
  // (a !CFG announcement carries no sender name, so only !CFGOK can be).
  if (ev.text.startsWith('!CFGOK')) {
    if (ev.from) {
      presence.touchNode(nodes, ev.from, Date.now(), { rssi: ev.rssi, snr: ev.snr });
      renderPosition();
    }
    note(`${ev.from || 'peer'} confirmed the new radio settings`);
    return;
  }
  if (ev.text.startsWith('!CFG ')) {
    if (ev.from) {
      presence.touchNode(nodes, ev.from, Date.now(), { rssi: ev.rssi, snr: ev.snr });
      renderPosition();
    }
    note(`${ev.from || 'peer'} changed the radio: ${ev.text.slice(5)}`);
    return;
  }

  const who = ev.from || 'peer';
  let text = ev.text;
  let locked = false;

  // Media fragments carry their own encryption flag for the blob as a whole,
  // so they are handled before the per-message decryption below.
  if (text.startsWith(frag.FRAG_PREFIX) && handleFragmentLine(text, who, ev.rssi, ev.snr)) {
    return;
  }

  // Decrypt before classifying, so positions and probes are protected too.
  if (isEncrypted(text)) {
    if (!cryptoKey) {
      note(`${who} sent an encrypted message - set the passphrase to read it`);
      return;
    }
    const plain = await decryptMessage(cryptoKey, text);
    if (plain === null) {
      note(`could not decrypt a message from ${who} - different passphrase?`, true);
      audio.chirpError();
      return;
    }
    text = plain;
    locked = true;
  }

  // U+FFFD is what TextDecoder emits for bytes that are not valid UTF-8. The
  // board only ever sends ASCII, so one of these is proof that bytes were
  // mangled between the board and here - never something a person typed.
  // Classifying a damaged line is how walls of junk ended up in the chat.
  // Written as an escape so no editor or encoding round-trip can mangle it.
  if (text.includes('\uFFFD')) {
    note(`corrupted line from ${who} (${linkMode}): ${escapeForNote(text)}`, true);
    return;
  }

  // Hearing anything is proof of presence, whatever the message turns out to be.
  const seen = presence.touchNode(nodes, who, Date.now(), { rssi: ev.rssi, snr: ev.snr });
  if (seen === 'joined') {
    note(`${who} joined the channel`);
    audio.chirpReceived();
  } else if (seen === 'returned') {
    note(`${who} is back`);
  }
  if (seen !== 'seen') renderPosition();

  const hello = msg.decodeHello(text);
  if (hello) {
    const node = nodes.get(who);
    if (node && node.nick !== hello.nick) {
      node.nick = hello.nick;
      renderPosition();
    }
    return;
  }
  if (text === '!BYE') {
    presence.dropNode(nodes, who);
    note(`${who} left the channel`);
    renderPosition();
    return;
  }

  // Any real message means they are there, so a call in progress is answered.
  // Probes and call control are excluded - they get explicit handling below.
  if (callTimer && !/^!(PING|PONG|CALL)/.test(text)) stopCalling(`${who} responded`);

  if (text.startsWith('!PING ')) {
    const seq = text.slice(6).trim();
    sendText(`!PONG ${seq}`).catch(() => {});
    return;
  }
  if (text.startsWith('!PONG ')) {
    const seq = Number(text.slice(6).trim());
    if (activeSurvey && survey.recordReply(activeSurvey, seq, {
      rssi: ev.rssi,
      snr: ev.snr,
      at: Date.now(),
    })) {
      audio.tickProbe();
      renderSurvey();
    }
    return;
  }
  if (text === '!CALL') {
    startRinging(who);
    return;
  }
  if (text === '!CALLOK') {
    stopCalling(`${who} answered`);
    return;
  }
  if (text === '!CALLNO') {
    stopCalling(`${who} declined`);
    return;
  }

  const pos = isPosition(text) ? decodePosition(text) : null;
  if (pos) {
    presence.setPosition(nodes, who, pos, Date.now());
    const rel = describeRelative(myPos, pos);
    note(`${who} is at ${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}` +
         (rel ? ` - ${rel} of you` : ' (set your own position to get range)'));
    renderPosition();
    return;
  }

  const ack = msg.decodeAck(text);
  if (ack) {
    if (ack.to === nodeName) resolveAck(ack.seq);
    return;
  }

  // A sequenced chat message: show it, then confirm receipt.
  const chat = msg.decodeMessage(text);
  if (chat && seenChats.seen(who, chat.seq)) {
    sendText(msg.encodeAck(who, chat.seq)).catch(() => {});
    return;
  }

  // "!" is reserved for the protocol. Anything still unrecognised here is
  // damaged protocol traffic, not something anybody typed, and bubbling it put
  // walls of !POS and base64 into the conversation. Report it as a diagnostic
  // instead, with the raw bytes made visible so it can actually be chased.
  if (!chat && text.startsWith('!')) {
    note(`unreadable protocol line from ${who}: ${escapeForNote(text)}`, true);
    return;
  }

  const shown = chat ? chat.text : text;
  bubble({
    mine: false,
    who: msg.displayName(nodes.get(who)),
    text: shown,
    rssi: ev.rssi,
    snr: ev.snr,
    locked,
  });
  audio.chirpReceived();
  if (chat) sendText(msg.encodeAck(who, chat.seq)).catch(() => {});
}

async function handleSent(ev) {
  let text = ev.text;
  let locked = false;

  // The echo of a fragment is our flow control: the board only prints it once
  // the packet is actually on the air, so this is when the next one may go.
  // The end marker and resend requests echo through here too, and must not
  // advance the queue.
  if (text.startsWith(frag.FRAG_PREFIX)) {
    if (outgoing && outgoing.phase === 'sending' && frag.parseFragment(text)) pumpTransfer();
    return;
  }

  if (isEncrypted(text)) {
    const plain = await decryptMessage(cryptoKey, text);
    if (plain === null) {
      note('sent an encrypted message');
      return;
    }
    text = plain;
    locked = true;
  }

  // Our own control traffic is not conversation, and chat echoes are already
  // on screen from sendChat - re-rendering them would duplicate every message.
  if (/^!(PING|PONG|CALL|CALLOK|CALLNO|ACK|HI|BYE|M\d)/.test(text)) return;
  if (isPosition(text)) {
    note(`sent position (${myPos ? myPos.source : 'unknown'})`);
    return;
  }
  // As on the receive side: a damaged echo of our own control traffic is not
  // something to show as a message we typed.
  if (text.startsWith('!')) {
    note(`sent an unreadable protocol line: ${escapeForNote(text)}`, true);
    return;
  }
  bubble({ mine: true, text, locked });
}

function handleLine(raw) {
  const ev = parseLine(raw);
  if (!ev) return;

  switch (ev.kind) {
    case 'sent':
      handleSent(ev);
      break;
    case 'recv':
      handleRecv(ev);
      break;
    case 'cfg':
      currentSf = ev.sf;
      currentFreq = ev.freq;
      currentBw = ev.bw;
      currentPower = ev.power;
      updateSubtitle();
      note(ev.text.replace(/^~~\s*/, ''));
      break;
    case 'banner':
      nodeName = ev.node;
      updateSubtitle();
      note(`board ready - this node is ${ev.node}`);
      break;
    case 'radio':
      currentSf = ev.sf;
      currentFreq = ev.freq;
      updateSubtitle();
      showRadioBanner(ev.freq, ev.sf);
      break;
    case 'error':
      note(ev.text, true);
      break;
    default:
      // Boot ROM chatter and anything else the firmware prints.
      note(ev.text);
  }
}

function renderPosition() {
  if (!myPos) {
    els.myPos.textContent = 'off';
  } else {
    const acc = myPos.source === 'manual' ? 'fixed' : `+/-${Math.round(myPos.accuracy)} m`;
    els.myPos.textContent =
      `${myPos.lat.toFixed(5)}, ${myPos.lon.toFixed(5)} (${myPos.source}, ${acc})`;
  }
  els.shareBtn.textContent = `Share: ${shareTimer ? 'on' : 'off'}`;

  const now = Date.now();
  els.peers.textContent = '';
  if (!nodes.size) {
    els.peers.textContent = 'nobody on the channel yet';
  } else {
    for (const node of presence.roster(nodes)) {
      const row = document.createElement('div');
      row.className = 'peer' + (node.stale ? ' stale' : '');
      const who = document.createElement('b');
      who.textContent = node.name;
      row.appendChild(who);

      who.textContent = msg.displayName(node);
      if (node.nick) row.title = node.name;   // the MAC name, on hover

      const bits = [node.stale ? 'quiet' : 'here', presence.formatSeen(node, now)];
      if (node.rssi !== null) bits.push(`${node.rssi} dBm`);
      const rel = node.pos ? describeRelative(myPos, node.pos) : null;
      if (rel) bits.push(rel);
      else if (node.pos) bits.push(`${node.pos.lat.toFixed(5)}, ${node.pos.lon.toFixed(5)}`);
      row.appendChild(document.createTextNode(' ' + bits.join(' · ')));
      els.peers.appendChild(row);
    }
  }
  renderRadar();
}

function renderRadar() {
  if (!els.radar || !els.radar.clientWidth) return;
  const contacts = [];
  for (const node of nodes.values()) {
    if (!node.pos || !myPos) continue;
    contacts.push({
      name: node.name,
      distanceM: distanceM(myPos, node.pos),
      bearingDeg: bearingDeg(myPos, node.pos),
      stale: node.stale,
    });
  }
  drawRadar(els.radar, contacts, { deviceRatio: window.devicePixelRatio || 1 });
}

function setPosition(pos) {
  myPos = pos;
  if (pos && pos.source === 'manual') {
    localStorage.setItem(STORE_KEY, JSON.stringify({ lat: pos.lat, lon: pos.lon }));
  }
  renderPosition();
}

function stopGps() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

function startGps() {
  if (!('geolocation' in navigator)) {
    note('this browser has no geolocation API', true);
    return;
  }
  stopGps();
  note('acquiring GPS fix...');
  watchId = navigator.geolocation.watchPosition(
    ({ coords }) => {
      // A desktop with no GPS answers from WiFi/IP lookup, which can be
      // kilometres out. Refuse it rather than plotting a fiction - use the
      // manual entry for fixed nodes instead.
      if (coords.accuracy > MAX_ACCURACY_M) {
        note(
          `ignoring a fix accurate only to +/-${Math.round(coords.accuracy)} m ` +
            `(limit ${MAX_ACCURACY_M} m). On a desktop use "Set manually".`,
          true
        );
        return;
      }
      setPosition({
        lat: coords.latitude,
        lon: coords.longitude,
        accuracy: coords.accuracy,
        source: 'gps',
      });
    },
    (err) => note(`GPS failed: ${err.message}`, true),
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 }
  );
}

async function sendPosition() {
  if (!myPos) {
    note('no position set', true);
    return;
  }
  if (!transport) return;
  try {
    // Through sendText, not the raw transport: the receive path decrypts
    // before classifying, so a position deserves the passphrase too.
    await sendText(encodePosition(myPos));
  } catch (err) {
    note(`position send failed: ${err.message}`, true);
  }
}

function toggleShare() {
  if (shareTimer) {
    clearInterval(shareTimer);
    shareTimer = null;
    note('position sharing off');
  } else {
    if (!myPos) {
      note('set a position first', true);
      return;
    }
    shareTimer = setInterval(sendPosition, SHARE_INTERVAL_MS);
    note(`sharing position every ${SHARE_INTERVAL_MS / 1000}s`);
    sendPosition();
  }
  renderPosition();
}

// Media transfer ----------------------------------------------------------

// Fragments are sent already-encrypted as a whole blob, so they bypass the
// per-message encryption in sendText.
async function sendRaw(line) {
  if (!transport) throw new Error('not connected');
  await transport.send(line);
}

// Paced by the board's own ">>" echo rather than a fixed delay: the firmware
// transmits synchronously, and dumping 30 lines into a 256-byte serial buffer
// would simply lose most of them.
function pumpTransfer() {
  if (!outgoing) return;
  clearTimeout(outgoing.timer);

  if (!outgoing.queue.length) {
    // Send the end marker once. Its own echo comes back through handleSent, and
    // without the phase guard that would queue another one indefinitely.
    if (outgoing.phase !== 'waiting') {
      outgoing.phase = 'waiting';
      outgoing.sent = outgoing.lines.length;
      sendRaw(frag.endLine(outgoing.id)).catch(() => {});
    }
    renderXfer();
    outgoing.timer = setTimeout(() => endTransfer('transfer finished'), 30000);
    return;
  }

  outgoing.phase = 'sending';
  const seq = outgoing.queue.shift();
  outgoing.sent = outgoing.lines.length - outgoing.queue.length;
  renderXfer();
  sendRaw(outgoing.lines[seq]).catch((err) => {
    endTransfer(null);
    note(`transfer failed: ${err.message}`, true);
  });
  outgoing.timer = setTimeout(pumpTransfer, FRAG_ECHO_TIMEOUT_MS);
}

function endTransfer(reason) {
  if (!outgoing) return;
  clearTimeout(outgoing.timer);
  outgoing = null;
  renderXfer();
  if (reason) note(reason);
}

async function sendBlob(bytes, kind, label, { confirm = true } = {}) {
  if (!transport) {
    note('connect a board first', true);
    return false;
  }
  if (outgoing) {
    note('a transfer is already running', true);
    return false;
  }

  const est = media.transferEstimate(bytes.length, { sf: currentSf });
  if (confirm) {
    const ok = window.confirm(
      `Send ${label}?\n\n${bytes.length} bytes in ${est.fragments} fragments\n` +
        `about ${media.formatDuration(est.ms)} of airtime at SF${currentSf}\n\n` +
        'Nothing else can use the channel while this runs.'
    );
    if (!ok) return false;
  }

  // Encrypt once for the whole blob. Encrypting each fragment would add 28
  // bytes plus base64 expansion to every one and roughly halve throughput.
  let payload = media.bytesToBase64(bytes);
  const encrypted = !!cryptoKey;
  if (encrypted) {
    const wrapped = await encryptMessage(cryptoKey, payload);
    payload = wrapped.slice(wrapped.indexOf(' ') + 1);
  }

  const id = frag.makeId();
  const lines = frag.packFragments({ id, kind, encrypted, payload });
  outgoing = {
    id, kind, lines, queue: lines.map((_, i) => i),
    timer: null, rounds: 0, phase: 'sending', sent: 0,
  };
  // One line in the log for the whole transfer; the rest goes to the bar.
  note(`sending ${label}: ${lines.length} fragments, ~${media.formatDuration(est.ms)}`);
  pumpTransfer();
  return true;
}

// Transfer progress lives in its own bar rather than the log. A 30-fragment
// image would otherwise bury the conversation under its own progress reports.
function renderXfer() {
  let label = null;
  let done = 0;
  let total = 0;

  if (outgoing) {
    const what = { i: 'image', a: 'audio', t: 'long message' }[outgoing.kind] || 'data';
    total = outgoing.lines.length;
    done = outgoing.sent || 0;
    label = outgoing.phase === 'waiting'
      ? `sending ${what} - waiting for the other end`
      : `sending ${what} ${done}/${total}`;
  } else {
    // Show whichever inbound transfer moved most recently.
    let newest = null;
    for (const asm of assemblies.values()) {
      if (!newest || asm.updatedAt > newest.updatedAt) newest = asm;
    }
    if (newest) {
      const what = { i: 'image', a: 'audio', t: 'long message' }[newest.kind] || 'data';
      done = frag.receivedCount(newest);
      total = newest.total;
      label = `receiving ${what} from ${newest.who || 'peer'} ${done}/${total}`;
    }
  }

  if (!label) {
    els.xfer.classList.remove('show');
    els.mediaState.textContent = 'idle';
    return;
  }
  els.xfer.classList.add('show');
  els.xferText.textContent = label;
  els.xferFill.style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';
  els.xferCancel.hidden = !outgoing;
  els.mediaState.textContent = label;
}

async function finishAssembly(asm, who, rssi, snr) {
  assemblies.delete(asm.id);
  renderXfer();

  let payload = frag.assembled(asm);
  if (asm.encrypted) {
    if (!cryptoKey) {
      note(`${who} sent encrypted media - set the passphrase to open it`, true);
      return;
    }
    const plain = await decryptMessage(cryptoKey, `!ENC ${payload}`);
    if (plain === null) {
      note(`could not decrypt media from ${who} - different passphrase?`, true);
      return;
    }
    payload = plain;
  }

  let bytes;
  try {
    bytes = media.base64ToBytes(payload);
  } catch {
    note(`media from ${who} was corrupt`, true);
    return;
  }

  if (asm.kind === 't') {
    // A long chat message. It carries the same "!M<seq> text" line a short one
    // would, so it is rendered and acknowledged through the identical path.
    const line = new TextDecoder().decode(bytes);
    const chat = msg.decodeMessage(line);
    if (chat && seenChats.seen(who, chat.seq)) {
      sendText(msg.encodeAck(who, chat.seq)).catch(() => {});
      return;
    }
    bubble({
      mine: false,
      who: msg.displayName(nodes.get(who)),
      text: chat ? chat.text : line,
      rssi,
      snr,
      locked: asm.encrypted,
    });
    audio.chirpReceived();
    if (chat) sendText(msg.encodeAck(who, chat.seq)).catch(() => {});
    return;
  }

  if (asm.kind === 'i') {
    const img = media.unpackImage(bytes);
    if (!img) {
      note(`unrecognised image from ${who}`, true);
      return;
    }
    mediaBubble(who, imageCanvas(img), `image ${img.w}x${img.h}`, rssi, snr);
  } else if (asm.kind === 'a') {
    const clip = media.unpackAudio(bytes);
    if (!clip) {
      note(`unrecognised audio from ${who}`, true);
      return;
    }
    const pcm = media.decodeAdpcm(clip.bytes, clip.sampleCount);
    const el = document.createElement('audio');
    el.controls = true;
    el.src = URL.createObjectURL(wavBlob(pcm, clip.sampleRate));
    el.style.width = '100%';
    const secs = (clip.sampleCount / clip.sampleRate).toFixed(1);
    mediaBubble(who, el, `audio ${secs}s at ${clip.sampleRate} Hz`, rssi, snr);
  }
  audio.chirpReceived();
}

function imageCanvas({ w, h, bytes }) {
  const gray = media.bitmapToGray(bytes, w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = gray[i];
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  c.style.imageRendering = 'pixelated';   // it is 1-bit art; do not smooth it
  c.style.width = '100%';
  c.style.maxWidth = `${w * 3}px`;
  c.style.display = 'block';
  return c;
}

function wavBlob(pcm, rate) {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const ascii = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length * 2, true);
  ascii(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);           // PCM
  v.setUint16(22, 1, true);           // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, pcm[i], true);
  return new Blob([buf], { type: 'audio/wav' });
}

function mediaBubble(who, node, caption, rssi, snr) {
  const wrap = document.createElement('div');
  wrap.className = 'msg recv';

  const meta = document.createElement('div');
  meta.className = 'meta';
  const w = document.createElement('span');
  w.className = 'who';
  w.textContent = who;
  meta.appendChild(w);
  if (Number.isFinite(rssi)) {
    const s = document.createElement('span');
    s.className = 'sig ' + signalLevel(rssi);
    s.textContent = `${rssi} dBm / ${snr} dB`;
    meta.appendChild(s);
  }
  wrap.appendChild(meta);
  wrap.appendChild(node);

  const cap = document.createElement('div');
  cap.className = 'caption';
  cap.textContent = caption;
  wrap.appendChild(cap);

  append(wrap);
}

// Handles every !B line. Returns true if the line was media traffic.
function handleFragmentLine(text, who, rssi, snr) {
  const f = frag.parseFragment(text);
  if (f) {
    let asm = assemblies.get(f.id);
    if (!asm) {
      asm = frag.createAssembly(f);
      assemblies.set(f.id, asm);
      const what = { i: 'an image', a: 'audio', t: 'a long message' }[f.kind] || 'data';
      note(`${who} is sending ${what} (${f.total} fragments)`);
    }
    asm.rssi = rssi;
    asm.snr = snr;
    asm.who = who;
    frag.addFragment(asm, f);
    renderXfer();
    if (frag.isComplete(asm)) finishAssembly(asm, who, rssi, snr);
    return true;
  }

  const endId = frag.parseEnd(text);
  if (endId) {
    const asm = assemblies.get(endId);
    if (!asm) return true;
    if (frag.isComplete(asm)) {
      finishAssembly(asm, who, asm.rssi, asm.snr);
      return true;
    }
    const missing = frag.missingOf(asm);
    asm.rounds = (asm.rounds || 0) + 1;
    if (asm.rounds > MAX_RESEND_ROUNDS) {
      assemblies.delete(endId);
      renderXfer();
      note(`gave up on media from ${who}: ${missing.length} fragments never arrived`, true);
      return true;
    }
    els.xferText.textContent = `asking ${who} to resend ${missing.length} fragments`;
    for (const batch of frag.splitRequest(endId, missing)) {
      sendRaw(frag.requestLine(endId, batch)).catch(() => {});
    }
    return true;
  }

  const req = frag.parseRequest(text);
  if (req) {
    if (!outgoing || outgoing.id !== req.id) return true;
    const valid = req.missing.filter((s) => s >= 0 && s < outgoing.lines.length);
    outgoing.queue.push(...valid);
    outgoing.phase = 'sending';
    clearTimeout(outgoing.timer);
    pumpTransfer();
    return true;
  }
  return false;
}

// Drop inbound transfers that stalled, so a half-received image does not sit
// in memory forever waiting for fragments that are never coming.
setInterval(() => {
  let dropped = false;
  for (const [id, asm] of assemblies) {
    if (Date.now() - asm.updatedAt > ASSEMBLY_IDLE_MS) {
      assemblies.delete(id);
      note(`abandoned an incomplete transfer from ${asm.who || 'peer'}`, true);
      dropped = true;
    }
  }
  if (dropped) renderXfer();
}, 15000);

els.xferCancel.addEventListener('click', () => endTransfer('transfer cancelled'));

// Capture -----------------------------------------------------------------

async function onImageChosen(file) {
  if (!file) return;
  const targetW = Number(els.imgWidth.value);
  try {
    const bmp = await createImageBitmap(file);
    const w = targetW;
    const h = Math.max(1, Math.round((bmp.height / bmp.width) * w));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;

    // Rec. 601 luma, then dithered to 1 bit. A plain threshold at this size
    // loses every gradient in the picture.
    const gray = new Uint8ClampedArray(w * h);
    for (let i = 0; i < w * h; i++) {
      gray[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    }
    const bytes = media.packImage(media.ditherToBitmap(gray, w, h), w, h);

    // Show the sender exactly what the other end will see.
    mediaBubble('you', imageCanvas({ w, h, bytes: bytes.subarray(7) }), `image ${w}x${h}`, null, null);
    await sendBlob(bytes, 'i', `a ${w}x${h} image`);
  } catch (err) {
    note(`could not read that image: ${err.message}`, true);
  }
}

async function encodeAndSendAudio(blob, label) {
  const rate = Number(els.audRate.value);
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const down = media.downsample(decoded.getChannelData(0), decoded.sampleRate, rate);
    const pcm = media.floatToInt16(down);
    const bytes = media.packAudio(media.encodeAdpcm(pcm), rate, pcm.length);
    ctx.close();
    await sendBlob(bytes, 'a', `${label} (${(pcm.length / rate).toFixed(1)}s at ${rate} Hz)`);
  } catch (err) {
    note(`could not encode that audio: ${err.message}`, true);
  }
}

async function toggleRecord() {
  if (recorder) {
    recorder.stop();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    note('this browser has no microphone access', true);
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordChunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => e.data.size && recordChunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(recordChunks, { type: recorder.mimeType });
      recorder = null;
      els.recBtn.textContent = 'Rec';
      els.recBtn.classList.add('ghost');
      await encodeAndSendAudio(blob, 'a recording');
    };
    recorder.start();
    els.recBtn.textContent = 'Stop';
    els.recBtn.classList.remove('ghost');
    note('recording - press Stop when done. Keep it short.');
  } catch (err) {
    note(`microphone refused: ${err.message}`, true);
  }
}

els.imgBtn.addEventListener('click', () => els.imgFile.click());
els.imgFile.addEventListener('change', (e) => {
  onImageChosen(e.target.files[0]);
  e.target.value = '';
});
els.audBtn.addEventListener('click', () => els.audFile.click());
els.audFile.addEventListener('change', (e) => {
  if (e.target.files[0]) encodeAndSendAudio(e.target.files[0], 'an audio file');
  e.target.value = '';
});
els.recBtn.addEventListener('click', () => {
  audio.unlock();
  toggleRecord();
});
els.mediaBtn.addEventListener('click', () => togglePanel(els.mediaPanel));

// Link test ---------------------------------------------------------------

// Segmented level meter for link margin. Full scale is 25 dB, which is about
// what a desk test gives at SF9 - so a full bar means "as good as it ever gets"
// and an empty one means the link is about to drop.
const METER_SEGMENTS = 20;
const METER_FULL_DB = 25;

function buildMeter() {
  els.testMeter.textContent = '';
  for (let i = 0; i < METER_SEGMENTS; i++) {
    els.testMeter.appendChild(document.createElement('i'));
  }
}

function renderMeter(margin) {
  const segs = els.testMeter.children;
  if (!segs.length) buildMeter();

  const lit =
    margin === null ? 0 : Math.round(Math.max(0, Math.min(1, margin / METER_FULL_DB)) * METER_SEGMENTS);
  // Same thresholds the advisory logic uses: 10 dB of headroom is comfortable,
  // under 3 dB is about to fail.
  const level = margin === null ? 'none' : margin >= 10 ? 'good' : margin >= 3 ? 'fair' : 'weak';

  els.testMeter.className = `meter ${level}`;
  els.testMeter.title = margin === null ? 'no samples yet' : `link margin ${margin.toFixed(1)} dB`;
  for (let i = 0; i < segs.length; i++) segs[i].classList.toggle('on', i < lit);
}

function renderSurvey() {
  if (!activeSurvey) {
    els.testStats.textContent = 'no samples yet';
    renderMeter(null);
    return;
  }
  const r = survey.summarise(activeSurvey);
  renderMeter(r.margin);
  const cell = (label, value) => {
    const d = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = value;
    d.appendChild(document.createTextNode(`${label} `));
    d.appendChild(b);
    return d;
  };

  const one = (s, unit, digits = 1) =>
    s ? `${s.avg.toFixed(digits)}${unit} (${s.min.toFixed(digits)}..${s.max.toFixed(digits)})` : '-';

  els.testStats.textContent = '';
  els.testStats.appendChild(cell('sent', String(r.sent)));
  els.testStats.appendChild(cell('replies', String(r.received)));
  els.testStats.appendChild(cell('lost', String(r.lost)));
  els.testStats.appendChild(cell('delivery', survey.formatPercent(r.pdr)));
  els.testStats.appendChild(cell('RSSI', one(r.rssi, ' dBm', 0)));
  els.testStats.appendChild(cell('SNR', one(r.snr, ' dB')));
  els.testStats.appendChild(cell('RTT', one(r.rtt, ' ms', 0)));
  els.testStats.appendChild(
    cell(
      `margin (SF${r.sf})`,
      r.margin === null ? '-' : `${r.margin.toFixed(1)} dB - ~${r.rangeFactor.toFixed(1)}x further`
    )
  );
  const withPos = [...nodes.values()].find((n) => n.pos);
  if (myPos && withPos) {
    els.testStats.appendChild(cell('distance', describeRelative(myPos, withPos.pos) || '-'));
  }
}

function startSurvey() {
  if (surveyTimer) return;
  if (!transport) {
    note('connect a board first', true);
    return;
  }
  const secs = Number(els.testInterval.value.trim().replace(',', '.'));
  if (!Number.isFinite(secs) || secs < 1 || secs > 300) {
    note('interval must be between 1 and 300 seconds', true);
    return;
  }
  const intervalMs = secs * 1000;
  activeSurvey = survey.createSurvey({
    sf: currentSf,
    intervalMs,
    // Generous enough that a slow SF12 round trip is not scored as a loss.
    timeoutMs: Math.max(intervalMs * 2, 12000),
  });
  probeSeq = 0;

  const fire = () => {
    probeSeq += 1;
    survey.recordSent(activeSurvey, probeSeq, Date.now());
    audio.tickSent();
    sendText(`!PING ${probeSeq}`).catch((err) => note(`probe failed: ${err.message}`, true));
    renderSurvey();
  };

  fire();
  surveyTimer = setInterval(fire, intervalMs);
  surveyRender = setInterval(renderSurvey, 1000);  // keeps timeouts ticking over
  els.testState.textContent = `running, every ${secs}s at SF${currentSf}`;
  note(`link test started at SF${currentSf}, one probe every ${secs}s`);
}

function stopSurvey() {
  if (!surveyTimer) return;
  clearInterval(surveyTimer);
  clearInterval(surveyRender);
  surveyTimer = null;
  surveyRender = null;

  const r = survey.summarise(activeSurvey);
  els.testState.textContent = 'stopped';
  note(
    `link test: ${r.received}/${r.received + r.lost} delivered (${survey.formatPercent(r.pdr)})` +
      (r.snr ? `, SNR ${r.snr.avg.toFixed(1)} dB, margin ${r.margin.toFixed(1)} dB at SF${r.sf}` : '')
  );
  renderSurvey();
}

function exportCsv() {
  if (!activeSurvey || !activeSurvey.probes.length) {
    note('nothing to export yet', true);
    return;
  }
  const blob = new Blob([survey.toCsv(activeSurvey)], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `lora-link-sf${activeSurvey.sf}-${Date.now()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// Calling -----------------------------------------------------------------

function startCalling() {
  if (!transport) {
    note('connect a board first', true);
    return;
  }
  if (callTimer) return;
  // Calling rings insistently at the other end until answered, and the button
  // sits between two others - too easy to set off by accident.
  if (!window.confirm('Call the other side?\n\nTheir device will ring until they answer or dismiss it.')) {
    return;
  }
  audio.unlock();
  const ring = () => sendText('!CALL').catch(() => {});
  ring();
  callTimer = setInterval(ring, CALL_REPEAT_MS);
  els.callBtn.textContent = 'Cancel';
  note('calling - the other side will ring until they answer');
}

function stopCalling(reason) {
  if (!callTimer) return;
  clearInterval(callTimer);
  callTimer = null;
  els.callBtn.textContent = 'Call';
  note(reason || 'call cancelled');
}

function startRinging(who) {
  // A caller repeats every few seconds. Without this the next !CALL would
  // simply start the ringing again a moment after you dismissed it. Scoped to
  // the caller you actually hung up on: a blanket mute made the device deaf to
  // everyone for a minute, which read as "calls only work one way".
  if (who === dismissedFrom && Date.now() < dismissedUntil) {
    // Silence here is what made this impossible to diagnose from the log.
    note(`${who} is calling again - still quiet from the last dismissal`);
    return;
  }

  clearTimeout(ringWatchdog);
  // If the caller gives up, stop ringing rather than waiting forever.
  ringWatchdog = setTimeout(() => stopRinging(false, 'caller gave up', true), CALL_REPEAT_MS * 4);

  if (ringingFrom) return;  // already ringing, this is just another repeat
  ringingFrom = who;
  els.callText.textContent = `${who} is calling`;
  els.callBanner.classList.add('show');
  audio.startRinging();
  note(`${who} is calling`);
}

function stopRinging(answer, reason, silent = false) {
  if (!ringingFrom) return;
  const who = ringingFrom;
  clearTimeout(ringWatchdog);
  audio.stopRinging();
  els.callBanner.classList.remove('show');
  ringingFrom = null;

  // Tell the caller either way, so a decline actually stops them repeating.
  // The quiet period covers that reply being lost on the air.
  if (!silent) sendText(answer ? '!CALLOK' : '!CALLNO').catch(() => {});

  // Only an actual dismissal earns a quiet period, and only for that caller.
  // The watchdog path (silent) is a call that simply ended - muting on that
  // meant every missed call left you unreachable for the next minute.
  if (!answer && !silent) {
    dismissedFrom = who;
    dismissedUntil = Date.now() + DISMISS_QUIET_MS;
  }
  note(reason);
}

// Closing every panel is what "show me the conversation" means, since the log
// is simply what is underneath them.
function closePanels() {
  for (const p of [els.posPanel, els.testPanel, els.setPanel, els.mediaPanel]) {
    p.classList.remove('show');
  }
  if (scanStream) stopScan();
  els.log.scrollTop = els.log.scrollHeight;
}

// Only one panel at a time - stacking them pushed the log off a phone screen.
function togglePanel(target) {
  const wasOpen = target.classList.contains('show');
  for (const p of [els.posPanel, els.testPanel, els.setPanel, els.mediaPanel]) {
    p.classList.remove('show');
  }
  if (!wasOpen) target.classList.add('show');
  // Hiding the settings panel mid-scan must not leave the camera running
  // (and its indicator lit) behind a panel that is no longer on screen.
  if (scanStream && !els.setPanel.classList.contains('show')) stopScan();
}

els.testBtn.addEventListener('click', () => {
  audio.unlock();
  togglePanel(els.testPanel);
});
els.testStart.addEventListener('click', startSurvey);
els.testStop.addEventListener('click', stopSurvey);
els.testCsv.addEventListener('click', exportCsv);
els.callBtn.addEventListener('click', () =>
  callTimer ? stopCalling('call cancelled') : startCalling()
);
els.answerBtn.addEventListener('click', () => stopRinging(true, 'answered'));
els.dismissBtn.addEventListener('click', () => stopRinging(false, 'call dismissed'));

function renderSoundState() {
  els.soundState.textContent = audio.isEnabled() ? 'on' : 'off';
}

// Link choice -------------------------------------------------------------

function renderLinkState() {
  const bt = linkMode === 'bt';
  els.linkState.textContent = bt
    ? WebBluetoothTransport.supported
      ? 'bluetooth'
      : 'bluetooth (not supported here)'
    : 'cable';
  // The chosen one is the solid button, matching how the accent swatches read.
  els.linkCable.classList.toggle('ghost', bt);
  els.linkBt.classList.toggle('ghost', !bt);
  els.linkBarCable.classList.toggle('ghost', bt);
  els.linkBarBt.classList.toggle('ghost', !bt);

  if (bt && !WebBluetoothTransport.supported) {
    els.linkBarHint.textContent = 'This browser has no Bluetooth. Use Chrome or Edge, or pick Cable.';
  } else if (bt) {
    els.linkBarHint.textContent =
      'The board must show "bt" on its screen. Hold its PRG button 3 s to switch Bluetooth on.';
  } else {
    els.linkBarHint.textContent = 'USB-C data cable (an OTG one on a phone). Charge-only cables will not work.';
  }
}

// The bar is a pre-connection aid, so it only occupies the screen when there
// is a connection to make.
function renderLinkBar(connected) {
  els.linkBar.classList.toggle('show', !connected);
}

function setLinkMode(mode) {
  if (mode === linkMode) return;
  linkMode = mode;
  localStorage.setItem(LINK_KEY, mode);
  renderLinkState();
  note(
    transport
      ? `link set to ${mode === 'bt' ? 'Bluetooth' : 'cable'} - disconnect and connect again to use it`
      : `link set to ${mode === 'bt' ? 'Bluetooth' : 'cable'}`
  );
}

function chooseBluetooth() {
  if (!WebBluetoothTransport.supported) {
    note('This browser has no Web Bluetooth. Use Chrome or Edge.', true);
    return;
  }
  setLinkMode('bt');
}

els.linkCable.addEventListener('click', () => setLinkMode('cable'));
els.linkBt.addEventListener('click', chooseBluetooth);
els.linkBarCable.addEventListener('click', () => setLinkMode('cable'));
els.linkBarBt.addEventListener('click', chooseBluetooth);

els.chatBtn.addEventListener('click', closePanels);

els.soundToggle.addEventListener('click', () => {
  const next = !audio.isEnabled();
  audio.setEnabled(next);
  localStorage.setItem(SOUND_KEY, next ? '1' : '0');
  renderSoundState();
  if (next) audio.chirpReceived();
});

// Delivery tracking and the outbox ----------------------------------------

function setBubbleStatus(el, state) {
  const tag = el?.querySelector('.ack');
  if (!tag) return;
  tag.dataset.state = state;
  tag.textContent = state;
}

function renderOutbox() {
  const n = queued.length;
  els.outState.textContent = outbox.describe(queued);
  els.outCount.textContent = n ? String(n) : '';
  els.outCount.hidden = !n;
  // The badge was a bare red number with nothing to say what it meant or how
  // to get rid of it. Both buttons live behind this same Set button.
  els.outCount.title = n
    ? `${outbox.describe(queued)} to send - open Set to send or clear them`
    : '';
  els.outClear.disabled = !n;
  els.outRetry.disabled = !n || !transport;

  els.outList.hidden = !n;
  els.outList.textContent = '';
  for (const item of queued) {
    const row = document.createElement('div');
    row.className = 'peer';
    const when = new Date(item.at).toLocaleTimeString();
    row.textContent = `${when}  ${item.text}`;
    els.outList.appendChild(row);
  }
}

function queueMessage(text, why) {
  queued = outbox.enqueue(queued, outbox.createItem(text));
  outbox.save(queued);
  renderOutbox();
  note(`${why} - held in the outbox (${queued.length})`);
}

// Sends one chat message with a sequence number and starts its delivery clock.
//
// The firmware caps a serial line at 200 characters and quietly transmits the
// remainder as a second packet. Unencrypted that shows up as a truncated
// message plus an orphaned tail; encrypted it splits the ciphertext so neither
// half authenticates, and the receiver blames the passphrase. Anything that
// would not fit therefore goes through the same fragmentation the media path
// uses, carrying the identical "!M<seq> text" line so the reassembled message
// is acknowledged exactly like a short one.
async function sendChat(text) {
  const seq = ++msgSeq;
  const line = msg.encodeMessage(seq, text);
  const wire = cryptoKey ? await encryptMessage(cryptoKey, line) : line;
  const el = bubble({ mine: true, text, locked: !!cryptoKey, status: 'sending' });

  let ackWindow = ACK_TIMEOUT_MS;

  if (wire.length > frag.MAX_LINE) {
    const bytes = new TextEncoder().encode(line);
    const est = media.transferEstimate(bytes.length, { sf: currentSf });
    // A long message takes real time to send, so the delivery clock has to
    // outlast the transfer or it would report "no ack" on a healthy link.
    ackWindow = est.ms + ACK_TIMEOUT_MS;

    const started = await sendBlob(bytes, 't', 'a long message', { confirm: false });
    if (!started) {
      setBubbleStatus(el, 'failed');
      queueMessage(text, 'could not start the transfer');
      return false;
    }
  } else {
    try {
      await sendRaw(wire);
    } catch (err) {
      setBubbleStatus(el, 'failed');
      queueMessage(text, `send failed: ${err.message}`);
      return false;
    }
  }

  setBubbleStatus(el, 'sent');
  pendingAcks.set(seq, {
    el,
    text,
    timer: setTimeout(() => {
      pendingAcks.delete(seq);
      setBubbleStatus(el, 'no ack');
      queueMessage(text, 'no acknowledgement');
    }, ackWindow),
  });
  return true;
}

function resolveAck(seq) {
  const pending = pendingAcks.get(seq);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingAcks.delete(seq);
  setBubbleStatus(pending.el, 'delivered');
}

// Flushed one at a time and paced, so a backlog does not overrun the board's
// serial buffer the way an unthrottled media transfer would.
let flushing = false;
async function flushOutbox() {
  if (flushing || !transport || !queued.length) return;
  flushing = true;
  note(`sending ${queued.length} queued message${queued.length === 1 ? '' : 's'}`);

  try {
    while (queued.length && transport) {
      // A long message from the queue starts a fragment transfer; the next one
      // must wait it out or sendBlob refuses it and the flush marks it failed.
      const idleAt = Date.now() + 5 * 60 * 1000;
      while (outgoing && transport && Date.now() < idleAt) {
        await new Promise((r) => setTimeout(r, 500));
      }
      if (outgoing || !transport) break;

      const item = queued[0];
      queued = outbox.remove(queued, item.id);
      outbox.save(queued);
      renderOutbox();
      // A failed send re-queues the item; retrying it immediately would just
      // spin every 1.5 s against a link that is not passing traffic.
      if (!(await sendChat(item.text))) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    flushing = false;
  }
}

// Channel sharing ---------------------------------------------------------

// Radio settings come from whatever the board last reported; the passphrase
// from what is set here. Nothing is invented - if we have not heard a settings
// line yet, the defaults are what the firmware boots with.
function currentSetup() {
  return {
    freq: currentFreq,
    sf: currentSf,
    bw: currentBw,
    power: currentPower,
    passphrase: localStorage.getItem(PASS_KEY) || null,
  };
}

function drawQr(text) {
  const q = qrcode(0, 'M');       // auto version, medium error correction
  q.addData(text);
  q.make();

  const n = q.getModuleCount();
  const quiet = 2;
  const size = n + quiet * 2;
  const canvas = els.qr;
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (q.isDark(r, c)) ctx.fillRect(c + quiet, r + quiet, 1, 1);
    }
  }
}

function openShare() {
  const setup = currentSetup();
  let link;
  try {
    link = channel.buildLink(location.href.split('#')[0], setup);
  } catch (err) {
    note(`cannot share these settings: ${err.message}`, true);
    return;
  }
  drawQr(link);
  els.shareLink.value = link;
  els.shareDesc.textContent = channel.describeSetup(setup);
  els.shareBox.hidden = false;
  els.scanBox.hidden = true;
}

async function applySetup(setup, source) {
  note(`applying channel from ${source}: ${channel.describeSetup(setup)}`);

  if (setup.passphrase) {
    await enableEncryption(setup.passphrase, true);
    note('passphrase set from the shared channel');
  }

  if (!transport) {
    note('radio settings will need a connected board - reconnect and scan again', true);
    return;
  }
  // Sent one at a time: each is broadcast to the other end before being
  // applied, and the board needs to finish one change before the next.
  for (const cmd of channel.setupCommands(setup)) {
    await sendText(cmd).catch(() => {});
    await new Promise((r) => setTimeout(r, 1200));
  }
}

let scanStream = null;
let scanTimer = null;

async function startScan() {
  if (!('BarcodeDetector' in window)) {
    note('this browser cannot scan QR codes - paste the setup link instead', true);
    return;
  }
  try {
    const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
    });
    els.scanVideo.srcObject = scanStream;
    await els.scanVideo.play();
    els.scanBox.hidden = false;
    els.shareBox.hidden = true;

    scanTimer = setInterval(async () => {
      try {
        const found = await detector.detect(els.scanVideo);
        for (const code of found) {
          const setup = channel.decodeSetup(code.rawValue);
          if (setup) {
            stopScan();
            audio.chirpReceived();
            await applySetup(setup, 'a scanned code');
            return;
          }
        }
      } catch {
        // A frame that cannot be decoded is normal; keep looking.
      }
    }, 400);
  } catch (err) {
    note(`camera refused: ${err.message}`, true);
    stopScan();
  }
}

function stopScan() {
  clearInterval(scanTimer);
  scanTimer = null;
  scanStream?.getTracks().forEach((t) => t.stop());
  scanStream = null;
  els.scanVideo.srcObject = null;
  els.scanBox.hidden = true;
}

els.shareBtn2.addEventListener('click', () =>
  els.shareBox.hidden ? openShare() : (els.shareBox.hidden = true)
);
els.shareClose.addEventListener('click', () => (els.shareBox.hidden = true));
els.scanBtn.addEventListener('click', () => (scanStream ? stopScan() : startScan()));
els.scanStop.addEventListener('click', stopScan);
els.copyLink.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.shareLink.value);
    note('setup link copied');
  } catch {
    els.shareLink.select();
    note('press copy on the selected link');
  }
});

// A link opened from a QR carries the channel in its fragment.
(async () => {
  const setup = channel.setupFromHash(location.hash);
  if (!setup) return;
  // Strip it straight away: the passphrase should not sit in the address bar
  // or in browser history. window.history explicitly - the import named
  // `history` above shadows the browser global here.
  window.history.replaceState(null, '', location.pathname + location.search);
  await applySetup(setup, 'the link you opened');
})();

// Encryption and history controls ----------------------------------------

function renderEncState() {
  els.encState.textContent = cryptoKey ? 'on (AES-256-GCM)' : 'off - messages are readable on air';
}

async function enableEncryption(passphrase, quiet = false) {
  try {
    cryptoKey = await deriveKey(passphrase);
    localStorage.setItem(PASS_KEY, passphrase);
    if (!quiet) note('encryption on - the other end needs the same passphrase');
  } catch (err) {
    cryptoKey = null;
    if (!quiet) note(`could not set passphrase: ${err.message}`, true);
  }
  renderEncState();
}

els.encOn.addEventListener('click', () => {
  const p = els.passIn.value;
  if (!p) {
    note('enter a passphrase first', true);
    return;
  }
  els.passIn.value = '';
  enableEncryption(p);
});

els.encOff.addEventListener('click', () => {
  cryptoKey = null;
  localStorage.removeItem(PASS_KEY);
  renderEncState();
  note('encryption off');
});

els.histClear.addEventListener('click', () => {
  history.clear();
  log = [];
  els.log.textContent = '';
  renderHistoryState();
  note('history cleared');
});

els.nickSave.addEventListener('click', () => {
  const clean = msg.cleanNick(els.nickIn.value);
  myNick = clean;
  if (clean) localStorage.setItem(NICK_KEY, clean);
  else localStorage.removeItem(NICK_KEY);
  els.nickIn.value = clean || '';
  note(clean ? `you are now "${clean}"` : 'nickname cleared');
  // Announce immediately rather than waiting for the next heartbeat.
  if (transport) announce(msg.encodeHello(myNick));
});

els.outClear.addEventListener('click', () => {
  const n = queued.length;
  if (!n) return;
  // Clearing throws away something you wrote, and the button sits next to one
  // that does the opposite, so make the discard deliberate.
  if (!confirm(`Discard ${n} unsent message${n === 1 ? '' : 's'}? This cannot be undone.`)) return;
  outbox.clear();
  queued = [];
  renderOutbox();
  note(`outbox cleared - ${n} message${n === 1 ? '' : 's'} discarded`);
});

els.outRetry.addEventListener('click', () => {
  if (!queued.length) return;
  if (!transport) {
    note('no board connected - the outbox goes out by itself once you connect', true);
    return;
  }
  flushOutbox();
});

els.banner.addEventListener('click', hideBanner);

els.histKeep.addEventListener('click', () => {
  keepHistory = !keepHistory;
  localStorage.setItem(HISTORY_KEEP_KEY, keepHistory ? '1' : '0');
  if (!keepHistory) {
    // Turning it off should not leave the previous conversation on disk.
    history.clear();
    log = [];
    note('history off - nothing will be saved from now on');
  } else {
    note('history on');
  }
  renderHistoryState();
});

function setAccent(hex, { persist = true } = {}) {
  const value = applyAccent(hex, { persist });
  els.accentIn.value = value;
  renderRadar();
  paintFavicon(value);
  return value;
}

els.accentIn.addEventListener('input', (e) => setAccent(e.target.value));
for (const sw of document.querySelectorAll('.swatch')) {
  sw.addEventListener('click', () => setAccent(sw.dataset.accent));
}

els.setBtn.addEventListener('click', () => togglePanel(els.setPanel));
els.posBtn.addEventListener('click', () => togglePanel(els.posPanel));
els.useGps.addEventListener('click', startGps);
els.manualBtn.addEventListener('click', () => {
  els.manualRow.hidden = !els.manualRow.hidden;
  if (!els.manualRow.hidden && myPos) {
    els.mLat.value = myPos.lat.toFixed(6);
    els.mLon.value = myPos.lon.toFixed(6);
  }
});
els.mSave.addEventListener('click', () => {
  const lat = Number(els.mLat.value.trim().replace(',', '.'));
  const lon = Number(els.mLon.value.trim().replace(',', '.'));
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    note('latitude must be a number between -90 and 90', true);
    return;
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    note('longitude must be a number between -180 and 180', true);
    return;
  }
  stopGps();
  setPosition({ lat, lon, accuracy: 0, source: 'manual' });
  els.manualRow.hidden = true;
  note(`position fixed at ${lat.toFixed(5)}, ${lon.toFixed(5)}`);
});
els.shareBtn.addEventListener('click', toggleShare);
els.posClear.addEventListener('click', () => {
  stopGps();
  if (shareTimer) {
    clearInterval(shareTimer);
    shareTimer = null;
  }
  localStorage.removeItem(STORE_KEY);
  setPosition(null);
  note('position cleared');
});

// A fixed node keeps its coordinates across reloads; a GPS fix is re-acquired.
try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lon)) {
    myPos = { lat: saved.lat, lon: saved.lon, accuracy: 0, source: 'manual' };
  }
} catch {}

// Ages and staleness advance on their own, so redraw even when nothing arrives.
setInterval(() => {
  for (const name of presence.sweep(nodes, Date.now())) {
    note(`${name} went quiet`);
  }
  if (nodes.size) renderPosition();
}, 15000);

// Presence announcements ---------------------------------------------------

function announce(what) {
  if (!transport) return;
  sendText(what).catch(() => {});
}

function startPresence() {
  // The nickname rides on the announcement rather than a message of its own,
  // so a late arrival learns names without extra airtime.
  const hello = () => announce(msg.encodeHello(myNick));
  hello();
  clearInterval(helloTimer);
  // Cheap enough to be invisible on air, often enough that a node arriving
  // mid-session learns about everyone within a couple of minutes.
  helloTimer = setInterval(hello, HELLO_INTERVAL_MS);
}

function stopPresence(sayGoodbye) {
  clearInterval(helloTimer);
  helloTimer = null;
  if (sayGoodbye) announce('!BYE');
}

// A closing tab should not look like a node that crashed.
window.addEventListener('pagehide', () => stopPresence(true));

// Keep the screen awake while a board is attached. A locked phone throttles
// timers and freezes the WebUSB read loop, which silently kills the link -
// inbound messages, ringing and position sharing all stop. Best effort: an old
// browser without the API just keeps its usual lock behaviour.
let wakeLock = null;

async function acquireWakeLock() {
  if (!('wakeLock' in navigator) || !transport || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    // Denied (battery saver, hidden page). The link degrades as before.
  }
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

// The lock is dropped by the browser whenever the page is hidden; take it back
// when the user returns, if we are still connected.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) acquireWakeLock();
});

async function connect() {
  const Transport = pickTransport(linkMode);
  if (!Transport) {
    note(
      linkMode === 'bt'
        ? 'This browser has no Web Bluetooth. Use Chrome or Edge, or switch the link back to Cable in Set.'
        : 'This browser has neither Web Serial nor WebUSB. Use Chrome or Edge - ' +
            'Firefox and Safari do not support either.',
      true
    );
    return;
  }

  els.connect.disabled = true;
  try {
    transport = new Transport();
    await transport.connect({
      onLine: handleLine,
      onClose: () => {
        note('board disconnected');
        transport = null;
        setConnected(false);
        releaseWakeLock();
      },
    });
    setConnected(true);
    acquireWakeLock();
    note(`connected over ${Transport.label}`);
    // Give the board a moment to finish booting before announcing ourselves,
    // then send anything that piled up while there was no radio.
    setTimeout(() => {
      startPresence();
      flushOutbox();
    }, 3000);
  } catch (err) {
    transport = null;
    // Dismissing the browser's device picker lands here too, which is not worth
    // shouting about.
    if (err && err.name === 'NotFoundError') {
      note('no device selected');
    } else {
      note(`connect failed: ${err && err.message ? err.message : err}`, true);
    }
    setConnected(false);
  } finally {
    els.connect.disabled = false;
  }
}

async function disconnect() {
  // Say goodbye while the radio is still ours to use.
  stopPresence(true);
  await new Promise((r) => setTimeout(r, 400));

  const t = transport;
  transport = null;
  setConnected(false);
  releaseWakeLock();
  try {
    await t?.disconnect();
  } catch {}
  note('disconnected');
}

els.connect.addEventListener('click', () => (transport ? disconnect() : connect()));

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text) return;
  els.input.value = '';

  // Commands go straight to the board and are not conversation.
  if (text.startsWith('/')) {
    try {
      await sendText(text);
    } catch (err) {
      note(`command failed: ${err && err.message ? err.message : err}`, true);
    }
    els.input.focus();
    return;
  }

  if (!transport) {
    queueMessage(text, 'not connected');
  } else {
    await sendChat(text);
  }
  els.input.focus();
});

els.diag.addEventListener('click', async () => {
  const caps = describeCapabilities(linkMode);
  note(
    `diagnostics - app v${VERSION} · ${caps.chosen} · Web Serial ${caps.webSerial ? 'yes' : 'no'}` +
      ` · WebUSB ${caps.webUsb ? 'yes' : 'no'} · Bluetooth ${caps.webBluetooth ? 'yes' : 'no'}` +
      ` · secure ${caps.secureContext} · android ${caps.android}`
  );

  try {
    const granted = await alreadyPermitted();
    note(granted.length ? `already permitted: ${granted.join(', ')}` : 'no devices permitted yet');
  } catch (err) {
    note(`getDevices failed: ${err.message}`, true);
  }

  if (!caps.webUsb) return;
  note('pick ANY device in the next dialog - this shows what the phone can see');
  try {
    const d = await probeAnyUsbDevice();
    note(`phone sees: ${d.name} - VID ${d.vendorId}, PID ${d.productId}`);
    if (d.vendorId !== '0x10c4') {
      note('that is not the CP2102 (expected VID 0x10c4, PID 0xea60)', true);
    }
  } catch (err) {
    if (err && err.name === 'NotFoundError') {
      note(
        'the picker was empty or dismissed. If empty, the phone sees no USB device ' +
          'at all - almost always a charge-only cable, or the phone not doing USB host.',
        true
      );
    } else {
      note(`probe failed: ${err.message}`, true);
    }
  }
});

// A Bluetooth preference saved on a phone is meaningless on a desktop without
// it, so fall back rather than leaving Connect permanently broken.
linkMode = localStorage.getItem(LINK_KEY) === 'bt' ? 'bt' : 'cable';
if (linkMode === 'bt' && !WebBluetoothTransport.supported) linkMode = 'cable';
renderLinkState();

// Report capability up front so an unsupported browser is obvious immediately.
const caps = describeCapabilities(linkMode);
if (!caps.webSerial && !caps.webUsb && !caps.webBluetooth) {
  note('Web Serial, WebUSB and Web Bluetooth are all unavailable in this browser. Use Chrome.', true);
} else {
  note(`ready - will connect over ${caps.chosen}`);
  if (caps.chosen === 'WebUSB') {
    note('Plug the board in with a USB-C data cable (charge-only cables will not work).');
  }
  if (caps.chosen === 'Bluetooth') {
    note('Bluetooth: the board must be powered and showing "bt" on its screen.');
  }
}

// Updating ----------------------------------------------------------------
// Without help, an installed copy can sit on an old build indefinitely:
// browsers may serve sw.js itself from cache, and even once a new worker takes
// over, the page already holds the previous scripts.
if ('serviceWorker' in navigator) {
  let reloading = false;

  // A new worker taking control means the page is running against files it did
  // not load. Reload - but never mid-session, where it would drop the port.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    if (transport || outgoing) {
      showUpdateBar();
      reloading = false;
    } else {
      location.reload();
    }
  });

  window.addEventListener('load', async () => {
    try {
      // updateViaCache 'none' is the important part: otherwise the browser can
      // hand back a cached sw.js and never notice a release at all.
      const reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });

      reg.addEventListener('updatefound', () => {
        const fresh = reg.installing;
        if (!fresh) return;
        fresh.addEventListener('statechange', () => {
          if (fresh.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBar();
          }
        });
      });

      // Long-lived installs never reload on their own, so ask periodically and
      // whenever the app comes back to the foreground.
      const poll = () => reg.update().catch(() => {});
      setInterval(poll, 30 * 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) poll();
      });
    } catch {
      // No service worker means no offline mode, but the app still runs.
    }
  });
}

function showUpdateBar() {
  els.updateBar.classList.add('show');
}

els.updateNow.addEventListener('click', () => location.reload());

// The markup carries a fallback so the version is visible even if the module
// fails; this makes the running build the one that reports itself.
els.ver.textContent = `v${VERSION}`;

setAccent(readAccent(), { persist: false });
keepHistory = localStorage.getItem(HISTORY_KEEP_KEY) !== '0';

myNick = msg.cleanNick(localStorage.getItem(NICK_KEY));
els.nickIn.value = myNick || '';
queued = outbox.load();
renderOutbox();

setConnected(false);
renderPosition();
renderEncState();
renderMeter(null);  // draw the empty segments rather than an empty box
window.addEventListener('resize', renderRadar);
audio.setEnabled(localStorage.getItem(SOUND_KEY) !== '0');
renderSoundState();
// Browsers will not make a sound until the user has interacted with the page.
document.addEventListener('pointerdown', () => audio.unlock(), { once: true });
restoreHistory();

// A stored passphrase means encryption stays on across reloads.
const storedPass = localStorage.getItem(PASS_KEY);
if (storedPass) enableEncryption(storedPass, true);

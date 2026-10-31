// Sequence numbers, acknowledgements and nicknames.
//
// Chat messages carry a sequence number so the sender can tell whether one
// arrived. The receiver answers with the ORIGINAL sender's node name and that
// number, because on a broadcast channel an unaddressed acknowledgement would
// be ambiguous the moment a third node joins.
//
// Nicknames ride on the presence announcement rather than a message of their
// own - it already repeats periodically, so a late arrival learns names for
// free instead of paying extra airtime for them.

export const MSG_PREFIX = '!M';
export const ACK_PREFIX = '!ACK';
export const HELLO_PREFIX = '!HI';

export const MAX_NICK = 16;

const MSG_RE = /^!M(\d+) ([\s\S]*)$/;
const ACK_RE = /^!ACK (\S+) (\d+)$/;
const HELLO_RE = /^!HI(?: ([\s\S]{1,64}))?$/;

export function encodeMessage(seq, text) {
  if (!Number.isInteger(seq) || seq < 0) throw new Error('bad sequence');
  return `${MSG_PREFIX}${seq} ${text}`;
}

export function decodeMessage(line) {
  const m = MSG_RE.exec(String(line ?? ''));
  if (!m) return null;
  return { seq: Number(m[1]), text: m[2] };
}

export function encodeAck(toName, seq) {
  return `${ACK_PREFIX} ${toName} ${seq}`;
}

export function decodeAck(line) {
  const m = ACK_RE.exec(String(line ?? '').trim());
  return m ? { to: m[1], seq: Number(m[2]) } : null;
}

export function encodeHello(nick) {
  const clean = cleanNick(nick);
  return clean ? `${HELLO_PREFIX} ${clean}` : HELLO_PREFIX;
}

// Returns null for a line that is not a hello, and { nick: null } for one
// carrying no name - the two cases mean different things to the caller.
export function decodeHello(line) {
  const m = HELLO_RE.exec(String(line ?? '').trim());
  if (!m) return null;
  return { nick: cleanNick(m[1]) };
}

// Strips anything that would break the line protocol, then caps the length.
// Returns null rather than an empty string so callers can test it directly.
export function cleanNick(nick) {
  if (typeof nick !== 'string') return null;
  const clean = nick.replace(/[\r\n\t]/g, ' ').trim().slice(0, MAX_NICK).trim();
  return clean.length ? clean : null;
}

export function validNick(nick) {
  return cleanNick(nick) !== null;
}

// What to show for a node: the nickname if it announced one, otherwise the
// name the firmware derived from its MAC.
export function displayName(node) {
  if (!node) return 'peer';
  return node.nick || node.name;
}

// Remembers the last `cap` (sender, seq) pairs seen. When our ack is lost on
// the air the sender retries the same message; the receiver must acknowledge
// it again but not render a second bubble. seen() returns true for a repeat
// and records first sightings.
export function createSeen(cap = 32) {
  const keys = [];
  return {
    seen(who, seq) {
      const key = `${who}0000${seq}`;
      if (keys.includes(key)) return true;
      keys.push(key);
      if (keys.length > cap) keys.shift();
      return false;
    },
  };
}

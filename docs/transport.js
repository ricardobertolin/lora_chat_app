// Two ways to reach the same CP2102 bridge on the Heltec board.
//
//   Desktop Chrome/Edge -> Web Serial. Uses the COM port the CP210x driver
//     already provides, so nothing about the Arduino toolchain has to change.
//   Android Chrome      -> WebUSB. Web Serial does not exist on Android, so we
//     drive the CP2102 directly with its vendor control requests.
//
// Both expose: connect(), send(text), disconnect(), and report lines through
// the onLine callback given to connect().

import { LineSplitter } from './protocol.js';

export const BAUD = 115200;
const CP210X_VID = 0x10c4;
const CP210X_PID = 0xea60;

// CP210x vendor requests, from Silicon Labs AN571.
const REQ_IFC_ENABLE = 0x00;
const REQ_SET_LINE_CTL = 0x03;
const REQ_SET_MHS = 0x07;  // modem handshaking: DTR/RTS
const REQ_SET_BAUDRATE = 0x1e;

const LINE_CTL_8N1 = 0x0800;  // 8 data bits, no parity, 1 stop bit
// Low byte holds the DTR/RTS values, high byte the write mask for each.
const MHS_RESET_HELD = 0x0302;  // RTS asserted -> EN low
const MHS_RUN = 0x0300;         // both released -> normal boot

export class WebSerialTransport {
  static get supported() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }
  static label = 'Web Serial';

  async connect({ onLine, onClose }) {
    this.port = await navigator.serial.requestPort({
      filters: [{ usbVendorId: CP210X_VID }],
    });
    await this.port.open({
      baudRate: BAUD,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
    });
    await this.#resetBoard();

    // One writer for the connection's lifetime, plus a chain that serialises
    // writes: two overlapping send() calls (an ack while a timer fires) would
    // otherwise both call getWriter() and the second would throw "locked".
    this.writer = this.port.writable.getWriter();
    this.sendChain = Promise.resolve();

    this.onClose = onClose;
    this.running = true;
    this.#readLoop(new LineSplitter(onLine));
  }

  // Pulse RTS only. Toggling DTR at the same time is what drops an ESP32 into
  // its bootloader, so keep it released and we get a clean reboot plus banner.
  async #resetBoard() {
    try {
      await this.port.setSignals({ dataTerminalReady: false, requestToSend: true });
      await sleep(100);
      await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
    } catch {
      // Some platforms refuse setSignals; the board just will not reboot.
    }
  }

  async #readLoop(splitter) {
    this.reader = this.port.readable.getReader();
    try {
      while (this.running) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) splitter.push(value);
      }
    } catch {
      // Cable pulled, or cancelled by disconnect().
    } finally {
      try {
        this.reader.releaseLock();
      } catch {}
      if (this.running) {
        this.running = false;
        this.onClose?.();
      }
    }
  }

  async send(text) {
    const data = new TextEncoder().encode(text + '\n');
    // The caller sees this write's own outcome; the chain itself swallows
    // failures so one bad write does not poison every later send.
    const turn = this.sendChain.then(() => this.writer.write(data));
    this.sendChain = turn.catch(() => {});
    return turn;
  }

  async disconnect() {
    this.running = false;
    try {
      await this.reader?.cancel();
    } catch {}
    try {
      this.writer?.releaseLock();
    } catch {}
    try {
      await this.port?.close();
    } catch {}
  }
}

export class WebUsbCp210xTransport {
  static get supported() {
    return typeof navigator !== 'undefined' && 'usb' in navigator;
  }
  static label = 'WebUSB';

  async connect({ onLine, onClose }) {
    this.device = await navigator.usb.requestDevice({
      filters: [{ vendorId: CP210X_VID, productId: CP210X_PID }],
    });
    await this.device.open();
    if (this.device.configuration === null) {
      await this.device.selectConfiguration(1);
    }

    const iface = this.device.configuration.interfaces[0];
    this.ifaceNum = iface.interfaceNumber;
    await this.device.claimInterface(this.ifaceNum);

    const endpoints = iface.alternate.endpoints;
    const bulkIn = endpoints.find((e) => e.direction === 'in' && e.type === 'bulk');
    const bulkOut = endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
    if (!bulkIn || !bulkOut) {
      throw new Error('CP2102 bulk endpoints not found');
    }
    this.epIn = bulkIn.endpointNumber;
    this.epOut = bulkOut.endpointNumber;
    this.packetSize = bulkIn.packetSize || 64;

    await this.#configureUart();

    this.onClose = onClose;
    this.running = true;
    this.#readLoop(new LineSplitter(onLine));
  }

  #control(request, value, data) {
    return this.device.controlTransferOut(
      { requestType: 'vendor', recipient: 'device', request, value, index: this.ifaceNum },
      data
    );
  }

  // WebUSB hands us a raw USB device with no notion of a serial port, so the
  // UART has to be set up by hand before any bytes will flow.
  async #configureUart() {
    await this.#control(REQ_IFC_ENABLE, 0x0001);

    const baud = new Uint8Array(4);
    new DataView(baud.buffer).setUint32(0, BAUD, true);
    await this.#control(REQ_SET_BAUDRATE, 0x0000, baud);

    await this.#control(REQ_SET_LINE_CTL, LINE_CTL_8N1);

    await this.#control(REQ_SET_MHS, MHS_RESET_HELD);
    await sleep(100);
    await this.#control(REQ_SET_MHS, MHS_RUN);
  }

  async #readLoop(splitter) {
    try {
      while (this.running) {
        const result = await this.device.transferIn(this.epIn, this.packetSize);
        if (result.status === 'stall') {
          await this.device.clearHalt('in', this.epIn);
          continue;
        }
        if (result.data && result.data.byteLength) {
          splitter.push(new Uint8Array(result.data.buffer));
        }
      }
    } catch {
      // Cable pulled, or the interface was released by disconnect().
    } finally {
      if (this.running) {
        this.running = false;
        this.onClose?.();
      }
    }
  }

  async send(text) {
    await this.device.transferOut(this.epOut, new TextEncoder().encode(text + '\n'));
  }

  async disconnect() {
    this.running = false;
    try {
      await this.device?.releaseInterface(this.ifaceNum);
    } catch {}
    try {
      await this.device?.close();
    } catch {}
  }
}

const isAndroid = () =>
  typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent || '');

// Web Serial first on desktop: it rides the existing CP210x driver, while
// WebUSB there would need the driver swapped for WinUSB and would break
// flash.ps1.
//
// Android is checked first and pinned to WebUSB. Chrome on Android can expose a
// navigator.serial object that never enumerates anything, and picking it would
// pop an empty port chooser instead of the working WebUSB path.
export function pickTransport() {
  if (isAndroid() && WebUsbCp210xTransport.supported) return WebUsbCp210xTransport;
  if (WebSerialTransport.supported) return WebSerialTransport;
  if (WebUsbCp210xTransport.supported) return WebUsbCp210xTransport;
  return null;
}

export function describeCapabilities() {
  const chosen = pickTransport();
  return {
    android: isAndroid(),
    webSerial: WebSerialTransport.supported,
    webUsb: WebUsbCp210xTransport.supported,
    secureContext: typeof isSecureContext === 'undefined' ? null : isSecureContext,
    chosen: chosen ? chosen.label : 'none',
  };
}

// Diagnostic: ask for ANY USB device rather than just a CP210x. If the board
// shows up here but not in the normal picker, the filter is wrong; if nothing
// shows up at all, the cable or USB host mode is the problem.
export async function probeAnyUsbDevice() {
  if (!WebUsbCp210xTransport.supported) throw new Error('WebUSB unavailable');
  const d = await navigator.usb.requestDevice({ filters: [] });
  return {
    vendorId: '0x' + d.vendorId.toString(16).padStart(4, '0'),
    productId: '0x' + d.productId.toString(16).padStart(4, '0'),
    name: [d.manufacturerName, d.productName].filter(Boolean).join(' ') || '(unnamed)',
  };
}

// Devices this origin has already been granted, if any.
export async function alreadyPermitted() {
  if (!WebUsbCp210xTransport.supported) return [];
  const list = await navigator.usb.getDevices();
  return list.map(
    (d) =>
      `0x${d.vendorId.toString(16).padStart(4, '0')}:` +
      `0x${d.productId.toString(16).padStart(4, '0')} ${d.productName || ''}`.trim()
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

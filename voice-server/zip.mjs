// A store-only ZIP writer, so a prepared book leaves here as one file that
// Finder, Files on the iPhone and the app's own jszip can all open.
//
// Stored, never deflated: the parts are already compressed audio, so
// deflating them would cost CPU and save nothing. Storing also keeps each
// entry simple, because the CRC and both sizes are known before the bytes go
// out and there is no need for the trailing data descriptor that not every
// unzipper reads.
//
// One part is held in memory at a time, never a whole book.

const TABLE = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  TABLE[i] = c;
}

export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ponytail: no zip64, so a bundle holds at most 65535 parts and 4 GB. At ten
// seconds a part that is 180 hours of audio; writeZip throws rather than
// produce a file that looks fine and unpacks short. Add zip64 if it ever trips.
export const ZIP_MAX_ENTRIES = 0xffff;
export const ZIP_MAX_BYTES = 0xffffffff;

/** The 1980-based MS-DOS stamp ZIP stores, to two-second resolution. */
function dosStamp(date) {
  const y = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Writes and waits for drain, so a slow phone cannot fill this computer's memory. */
function write(out, buf) {
  if (out.write(buf)) return Promise.resolve();
  return new Promise(function (resolve) { out.once('drain', resolve); });
}

function localHeader(e) {
  const name = Buffer.from(e.name, 'utf8');
  const h = Buffer.alloc(30 + name.length);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);          // version needed
  h.writeUInt16LE(0x0800, 6);      // UTF-8 names
  h.writeUInt16LE(0, 8);           // stored
  h.writeUInt16LE(e.time, 10);
  h.writeUInt16LE(e.date, 12);
  h.writeUInt32LE(e.crc, 14);
  h.writeUInt32LE(e.size, 18);
  h.writeUInt32LE(e.size, 22);
  h.writeUInt16LE(name.length, 26);
  h.writeUInt16LE(0, 28);
  name.copy(h, 30);
  return h;
}

function centralHeader(e) {
  const name = Buffer.from(e.name, 'utf8');
  const h = Buffer.alloc(46 + name.length);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(20, 4);          // version made by
  h.writeUInt16LE(20, 6);          // version needed
  h.writeUInt16LE(0x0800, 8);
  h.writeUInt16LE(0, 10);          // stored
  h.writeUInt16LE(e.time, 12);
  h.writeUInt16LE(e.date, 14);
  h.writeUInt32LE(e.crc, 16);
  h.writeUInt32LE(e.size, 20);
  h.writeUInt32LE(e.size, 24);
  h.writeUInt16LE(name.length, 28);
  h.writeUInt16LE(0, 30);          // extra
  h.writeUInt16LE(0, 32);          // comment
  h.writeUInt16LE(0, 34);          // disk
  h.writeUInt16LE(0, 36);          // internal attrs
  h.writeUInt32LE(0, 38);          // external attrs
  h.writeUInt32LE(e.offset, 42);
  name.copy(h, 46);
  return h;
}

/**
 * `files` is anything iterable with `await`: each item is
 * `{ name, body: Buffer }`. Entries go out as they arrive, so the caller can
 * read one part from disk at a time.
 */
export async function writeZip(out, files) {
  const entries = [];
  let offset = 0;
  for await (const f of files) {
    const body = f.body;
    if (entries.length >= ZIP_MAX_ENTRIES) throw new Error('too many parts for one bundle');
    if (offset + body.length > ZIP_MAX_BYTES) throw new Error('bundle larger than 4 GB');
    const stamp = dosStamp(f.date || new Date());
    const e = { name: f.name, crc: crc32(body), size: body.length, offset: offset, time: stamp.time, date: stamp.date };
    const head = localHeader(e);
    await write(out, head);
    await write(out, body);
    offset += head.length + body.length;
    entries.push(e);
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const e of entries) {
    const h = centralHeader(e);
    await write(out, h);
    cdSize += h.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(cdOffset, 16);
  end.writeUInt16LE(0, 20);
  await write(out, end);
  return entries.length;
}

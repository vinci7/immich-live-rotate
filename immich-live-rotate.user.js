// ==UserScript==
// @name         Immich Live Photo Rotate
// @name:zh-CN   Immich 实况照片无损旋转
// @namespace    https://github.com/vinci7/immich-live-rotate
// @version      0.2.0
// @description  Losslessly rotate iPhone Live Photos in the Immich web UI. The motion video rotates too, nothing is re-encoded.
// @description:zh-CN 在 Immich 网页端无损旋转 iPhone 实况照片，动态部分一起转，不重新编码。
// @author       vinci7
// @license      MIT
// @homepageURL  https://github.com/vinci7/immich-live-rotate
// @supportURL   https://github.com/vinci7/immich-live-rotate/issues
// @downloadURL  https://raw.githubusercontent.com/vinci7/immich-live-rotate/main/immich-live-rotate.user.js
// @updateURL    https://raw.githubusercontent.com/vinci7/immich-live-rotate/main/immich-live-rotate.user.js
// @match        *://*/*
// @noframes
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

/*
 * How it works
 *
 * An iPhone Live Photo is a HEIC still plus a MOV clip. Both store their orientation as metadata,
 * so rotating them only means rewriting a few bytes:
 *   - HEIC: the `irot` item property (what Immich and most decoders honour) and the EXIF Orientation tag
 *   - MOV:  the transformation matrix in the `tkhd` box of every video track
 * The rotated pair is uploaded as a new Live Photo. Both files also get a fresh ContentIdentifier
 * (the UUID iOS uses to pair them); otherwise Immich would re-link the ORIGINAL photo to the new video.
 *
 * The file has two parts: a pure byte-level core (`ImmichLiveRotate`, also loadable from Node for tests)
 * and the browser part (Immich API calls and UI).
 */

const ImmichLiveRotate = (() => {
  'use strict';

  /** Errors the UI knows how to explain. `code` is the i18n key. */
  class RotateError extends Error {
    constructor(code, detail) {
      super(detail ? `${code}: ${detail}` : code);
      this.code = code;
    }
  }

  // ---------- ISO base media file format (shared by HEIC and MOV) ----------

  const fourcc = (u8, p) => String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
  const view = u8 => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  function boxes(u8, start, end) {
    const dv = view(u8);
    const out = [];
    let p = start;
    while (p + 8 <= end) {
      let size = dv.getUint32(p), header = 8;
      const type = fourcc(u8, p + 4);
      const toEnd = size === 0;
      if (size === 1) {
        if (p + 16 > end) throw new RotateError('corrupt', `box ${type} at ${p} is truncated`);
        size = Number(dv.getBigUint64(p + 8));
        header = 16;
      } else if (toEnd) size = end - p;
      if (size < header || p + size > end) throw new RotateError('corrupt', `box ${type} at ${p} overflows its parent`);
      out.push({ type, start: p, body: p + header, end: p + size, toEnd });
      p += size;
    }
    return out;
  }

  const ROOT = u8 => ({ body: 0, end: u8.length });
  const find = (u8, parent, type) => boxes(u8, parent.body, parent.end).find(b => b.type === type);
  function need(u8, parent, type, code) {
    const box = find(u8, parent, type);
    if (!box) throw new RotateError(code, `no ${type} box`);
    return box;
  }
  const fullBoxBody = b => ({ ...b, body: b.body + 4 }); // skip version + flags

  function readUint(u8, p, n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + u8[p + i];
    return v;
  }

  function writeUint(u8, p, n, v) {
    if (v >= 2 ** (8 * n)) throw new RotateError('corrupt', `value ${v} does not fit in ${n} bytes`);
    for (let i = n - 1; i >= 0; i--) { u8[p + i] = v % 256; v = Math.floor(v / 256); }
  }

  // ---------- HEIC ----------

  /** Everything rotation needs from the HEIC `meta` box. */
  function parseHeic(u8) {
    if (fourcc(u8, 4) !== 'ftyp') throw new RotateError(u8[0] === 0xff && u8[1] === 0xd8 ? 'jpeg' : 'notHeic');
    const metaBox = find(u8, ROOT(u8), 'meta');
    if (!metaBox) throw new RotateError('notHeic', 'no meta box');
    const meta = fullBoxBody(metaBox);

    const pitm = need(u8, meta, 'pitm', 'notHeic');
    const primary = readUint(u8, pitm.body + 4, u8[pitm.body] === 0 ? 2 : 4);

    const types = new Map(); // item id -> item type
    const iinf = need(u8, meta, 'iinf', 'notHeic');
    for (const infe of boxes(u8, iinf.body + 4 + (u8[iinf.body] === 0 ? 2 : 4), iinf.end)) {
      const v = u8[infe.body];
      if (infe.type !== 'infe' || v < 2) continue;
      const idLen = v === 2 ? 2 : 4;
      types.set(readUint(u8, infe.body + 4, idLen), fourcc(u8, infe.body + 4 + idLen + 2));
    }

    const iprp = need(u8, meta, 'iprp', 'notHeic');
    const ipco = need(u8, iprp, 'ipco', 'notHeic');
    const props = boxes(u8, ipco.body, ipco.end); // property indices are 1-based

    // ipma: which properties each item uses, and where each association ("slot") sits in the file
    const ipma = need(u8, iprp, 'ipma', 'notHeic');
    const ipmaVersion = u8[ipma.body];
    const slotSize = readUint(u8, ipma.body + 1, 3) & 1 ? 2 : 1;
    const assoc = new Map(); // item id -> [{ index, offset }]
    let p = ipma.body + 4;
    const count = readUint(u8, p, 4); p += 4;
    for (let i = 0; i < count; i++) {
      const idLen = ipmaVersion < 1 ? 2 : 4;
      const id = readUint(u8, p, idLen); p += idLen;
      const n = u8[p++];
      const list = [];
      for (let j = 0; j < n; j++, p += slotSize) {
        list.push({ index: readUint(u8, p, slotSize) & (slotSize === 2 ? 0x7fff : 0x7f), offset: p });
      }
      assoc.set(id, list);
    }
    const propTypes = id => (assoc.get(id) || []).map(a => props[a.index - 1]?.type);
    if (!propTypes(primary).includes('irot')) throw new RotateError('noIrot');
    if ([...assoc.keys()].some(id => propTypes(id).includes('imir'))) throw new RotateError('mirrored');

    // iref/dimg: derived image -> its input images
    const inputs = new Map();
    const iref = find(u8, meta, 'iref');
    if (iref) {
      const idLen = u8[iref.body] === 0 ? 2 : 4;
      for (const ref of boxes(u8, iref.body + 4, iref.end)) {
        if (ref.type !== 'dimg') continue;
        const n = readUint(u8, ref.body + idLen, 2);
        const to = [];
        for (let i = 0; i < n; i++) to.push(readUint(u8, ref.body + idLen + 2 + i * idLen, idLen));
        inputs.set(readUint(u8, ref.body, idLen), to);
      }
    }
    // A derived image whose inputs are already rotated (e.g. the HDR gain-map `tmap` item on iPhone 15+):
    // its own `irot` is relative to the rotated inputs and must stay as is, and its `ispe` already holds
    // the rotated size, so width/height swap on 90°/270° turns.
    const isDownstream = (id, seen = new Set()) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return (inputs.get(id) || []).some(i => propTypes(i).includes('irot') || isDownstream(i, seen));
    };

    const iloc = parseIloc(u8, meta);
    return { meta: metaBox, iprp, ipco, props, assoc, slotSize, types, primary, isDownstream, iloc, exif: findExifOrientation(u8, meta, types, iloc) };
  }

  /** iloc: where each item's data lives, plus the file positions of the offset fields. */
  function parseIloc(u8, meta) {
    const iloc = need(u8, meta, 'iloc', 'notHeic');
    const v = u8[iloc.body];
    let p = iloc.body + 4;
    const offSize = u8[p] >> 4, lenSize = u8[p] & 15, baseSize = u8[p + 1] >> 4;
    const idxSize = v === 1 || v === 2 ? u8[p + 1] & 15 : 0;
    p += 2;
    const idLen = v < 2 ? 2 : 4;
    const count = readUint(u8, p, idLen); p += idLen;
    const items = [];
    for (let i = 0; i < count; i++) {
      const id = readUint(u8, p, idLen); p += idLen;
      let method = 0;
      if (v === 1 || v === 2) { method = readUint(u8, p, 2) & 15; p += 2; }
      p += 2; // data_reference_index
      const basePos = p, base = readUint(u8, p, baseSize); p += baseSize;
      const n = readUint(u8, p, 2); p += 2;
      const extents = [];
      for (let j = 0; j < n; j++) {
        p += idxSize;
        extents.push({ pos: p, offset: readUint(u8, p, offSize) }); p += offSize;
        p += lenSize;
      }
      items.push({ id, method, base, basePos, extents });
    }
    return { items, offSize, baseSize };
  }

  /** Position of the EXIF Orientation value: { offset, little }, or null if there is none or it can't be read.
   *  EXIF is best effort: Immich and most decoders use irot, so an unreadable EXIF block must not block rotation. */
  function findExifOrientation(u8, meta, types, iloc) {
    try {
      return readExifOrientation(u8, meta, types, iloc);
    } catch {
      return null;
    }
  }

  function readExifOrientation(u8, meta, types, iloc) {
    const exifId = [...types].find(([, t]) => t === 'Exif')?.[0];
    if (exifId === undefined) return null;
    const item = iloc.items.find(i => i.id === exifId);
    if (!item?.extents.length) return null;
    let start = item.base + item.extents[0].offset;
    if (item.method === 1) {
      const idat = find(u8, meta, 'idat');
      if (!idat) return null;
      start += idat.body;
    } else if (item.method !== 0) return null;
    const tiff = start + 4 + readUint(u8, start, 4); // the Exif item starts with the offset to the TIFF header
    const order = fourcc(u8, tiff).slice(0, 2);
    if (order !== 'II' && order !== 'MM') return null;
    const little = order === 'II';
    const dv = view(u8);
    const ifd = tiff + dv.getUint32(tiff + 4, little);
    const n = dv.getUint16(ifd, little);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + 12 * i;
      if (dv.getUint16(e, little) === 0x0112) return { offset: e + 8, little }; // 0x0112 = Orientation
    }
    return null;
  }

  const EXIF_CW90 = { 1: 6, 6: 3, 3: 8, 8: 1 };

  /** Rotate a HEIC clockwise by `quarters` × 90°. Returns new bytes, possibly a few dozen bytes longer. */
  function rotateHeic(src, quarters) {
    const info = parseHeic(src);
    const u8 = src.slice();
    if (!quarters) return u8;

    if (info.exif) {
      const dv = view(u8);
      let o = dv.getUint16(info.exif.offset, info.exif.little) || 1; // 0 = unset
      if (o > 8) throw new RotateError('corrupt', `EXIF orientation ${o}`);
      if (!EXIF_CW90[o]) throw new RotateError('mirrored', `EXIF orientation ${o}`);
      for (let i = 0; i < quarters; i++) o = EXIF_CW90[o];
      dv.setUint16(info.exif.offset, o, info.exif.little);
    }

    // property index -> every association using it, tagged with whether its item is downstream
    const slots = new Map();
    for (const [id, list] of info.assoc) {
      for (const a of list) {
        if (!slots.has(a.index)) slots.set(a.index, []);
        slots.get(a.index).push({ ...a, downstream: info.isDownstream(id) });
      }
    }

    // Edit a property. If every user wants the edit, change it in place; otherwise append an edited copy
    // to the end of ipco and point only the wanted associations at it.
    const appended = [];
    const maxIndex = info.slotSize === 2 ? 0x7fff : 0x7f;
    const edit = (index, wanted, fn) => {
      const prop = info.props[index - 1];
      if (wanted.length === slots.get(index).length) return fn(u8, prop.body);
      const copy = src.slice(prop.start, prop.end);
      fn(copy, prop.body - prop.start);
      appended.push(copy);
      const newIndex = info.props.length + appended.length;
      if (newIndex > maxIndex) throw new RotateError('corrupt', 'no room for another item property');
      for (const s of wanted) {
        const essential = u8[s.offset] & 0x80;
        writeUint(u8, s.offset, info.slotSize, newIndex);
        u8[s.offset] |= essential;
      }
    };

    for (const [index, all] of slots) {
      const type = info.props[index - 1]?.type;
      const regular = all.filter(s => !s.downstream), downstream = all.filter(s => s.downstream);
      if (type === 'irot' && regular.length) {
        // irot stores a counter-clockwise angle in units of 90°
        edit(index, regular, (b, p) => { b[p] = (b[p] & ~3) | (((b[p] & 3) + 4 - quarters) & 3); });
      } else if (type === 'ispe' && downstream.length && quarters % 2) {
        edit(index, downstream, (b, p) => {
          const width = b.slice(p + 4, p + 8);
          b.copyWithin(p + 4, p + 8, p + 12);
          b.set(width, p + 8);
        });
      }
    }
    if (!appended.length) return u8;

    // Insert the appended properties at the end of ipco: grow the enclosing boxes and shift
    // every iloc offset that points past the insertion point.
    const at = info.ipco.end;
    const delta = appended.reduce((n, a) => n + a.length, 0);
    for (const box of [info.ipco, info.iprp, info.meta]) {
      if (box.toEnd) throw new RotateError('corrupt', `${box.type} box has size 0`);
      if (box.body - box.start === 16) writeUint(u8, box.start + 8, 8, readUint(u8, box.start + 8, 8) + delta);
      else writeUint(u8, box.start, 4, readUint(u8, box.start, 4) + delta);
    }
    const { items, offSize, baseSize } = info.iloc;
    for (const item of items) {
      if (item.method !== 0 || !item.extents.length) continue;
      if (baseSize) {
        if (item.base + item.extents[0].offset >= at) writeUint(u8, item.basePos, baseSize, item.base + delta);
      } else {
        for (const e of item.extents) if (e.offset >= at) writeUint(u8, e.pos, offSize, e.offset + delta);
      }
    }
    const out = new Uint8Array(u8.length + delta);
    out.set(u8.subarray(0, at));
    let p = at;
    for (const a of appended) { out.set(a, p); p += a.length; }
    out.set(u8.subarray(at), p);
    return out;
  }

  /** Effective irot angle and ispe size of every item. Used by the tests. */
  function describeHeic(u8) {
    const info = parseHeic(u8);
    const items = {};
    for (const [id, list] of info.assoc) {
      const d = { type: info.types.get(id), downstream: info.isDownstream(id), irot: null };
      for (const a of list) {
        const prop = info.props[a.index - 1];
        if (prop?.type === 'irot') d.irot = (u8[prop.body] & 3) * 90;
        if (prop?.type === 'ispe') d.ispe = `${readUint(u8, prop.body + 4, 4)}x${readUint(u8, prop.body + 8, 4)}`;
      }
      items[id] = d;
    }
    return { primary: info.primary, items, exif: info.exif && view(u8).getUint16(info.exif.offset, info.exif.little) };
  }

  // ---------- MOV ----------

  const ONE = 0x10000; // 16.16 fixed point
  // Clockwise rotation matrices: [a, b, c, d, tx, ty]; w and h are the track size from tkhd.
  const MATRICES = [
    (w, h) => [ONE, 0, 0, ONE, 0, 0],
    (w, h) => [0, ONE, -ONE, 0, h, 0],
    (w, h) => [-ONE, 0, 0, -ONE, w, h],
    (w, h) => [0, -ONE, ONE, 0, 0, w],
  ];

  /** Video tracks with the position of their matrix and their current clockwise rotation (in quarters). */
  function videoTracks(u8) {
    const moov = find(u8, ROOT(u8), 'moov');
    if (!moov) throw new RotateError('notMov');
    const dv = view(u8);
    const out = [];
    for (const trak of boxes(u8, moov.body, moov.end)) {
      if (trak.type !== 'trak') continue;
      const tkhd = find(u8, trak, 'tkhd');
      if (!tkhd) continue;
      // version/flags + times, track id and duration (32- or 64-bit), then reserved, layer, group, volume
      const m = tkhd.body + (u8[tkhd.body] === 0 ? 24 : 36) + 16;
      const w = dv.getUint32(m + 36), h = dv.getUint32(m + 40);
      if (!w || !h) continue; // audio and metadata tracks
      const [a, b, , c, d] = [0, 1, 2, 3, 4].map(i => dv.getInt32(m + 4 * i));
      const angle = MATRICES.findIndex(f => { const x = f(w, h); return x[0] === a && x[1] === b && x[2] === c && x[3] === d; });
      if (angle < 0) throw new RotateError('mirrored', 'video matrix is not a pure rotation');
      out.push({ m, w, h, angle });
    }
    if (!out.length) throw new RotateError('notMov', 'no video track');
    return out;
  }

  /** Rotate a MOV clockwise by `quarters` × 90°. Returns new bytes of the same length. */
  function rotateMov(src, quarters) {
    const u8 = src.slice();
    const dv = view(u8);
    for (const t of videoTracks(u8)) {
      const [a, b, c, d, tx, ty] = MATRICES[(t.angle + quarters) & 3](t.w, t.h);
      [a, b, 0, c, d, 0, tx, ty, 0x40000000 /* w = 1.0 in 2.30 fixed point */].forEach((v, i) => dv.setInt32(t.m + 4 * i, v));
    }
    return u8;
  }

  // ---------- ContentIdentifier ----------

  // One character per byte, so string indices equal byte offsets (do not switch to utf-8).
  const latin1 = u8 => new TextDecoder('latin1').decode(u8);
  const UUID_RE = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/g;

  /** The ContentIdentifier is the UUID string found both in the MOV's moov box and in the HEIC. */
  function findContentId(heic, mov) {
    const moov = find(mov, ROOT(mov), 'moov');
    const candidates = new Set(latin1(mov.subarray(moov.start, moov.end)).match(UUID_RE) || []);
    if (!candidates.size) return null;
    const heicText = latin1(heic);
    return [...candidates].find(id => heicText.includes(id)) || null;
  }

  function replaceAscii(u8, from, to) {
    const text = latin1(u8);
    for (let i = text.indexOf(from); i >= 0; i = text.indexOf(from, i + from.length)) {
      for (let j = 0; j < to.length; j++) u8[i + j] = to.charCodeAt(j);
    }
  }

  /**
   * Rotate a Live Photo clockwise by `quarters` × 90° (negative turns counter-clockwise).
   * Inputs are ArrayBuffers or Uint8Arrays and are left untouched.
   * With `newContentId`, the pairing UUID is replaced in both files; `contentId` is the old one (null if not found).
   */
  function rotateLivePhoto(heicData, movData, quarters, { newContentId } = {}) {
    quarters = ((quarters % 4) + 4) % 4;
    if (newContentId && !/^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(newContentId)) {
      throw new TypeError('newContentId must be an upper-case UUID');
    }
    const heicIn = new Uint8Array(heicData), movIn = new Uint8Array(movData);
    const heic = rotateHeic(heicIn, quarters);
    const mov = rotateMov(movIn, quarters);
    const contentId = newContentId ? findContentId(heic, mov) : null;
    if (contentId) {
      replaceAscii(heic, contentId, newContentId);
      replaceAscii(mov, contentId, newContentId);
    }
    verify(heicIn, movIn, heic, mov, quarters);
    return { heic, mov, contentId };
  }

  /** Re-parse the output and make sure it says what we meant before anything is uploaded. */
  function verify(heicIn, movIn, heic, mov, quarters) {
    const before = describeHeic(heicIn), after = describeHeic(heic);
    const want = (before.items[before.primary].irot + 360 - 90 * quarters) % 360;
    if (after.items[after.primary].irot !== want) throw new RotateError('corrupt', 'self-check: photo angle');
    const tracksIn = videoTracks(movIn), tracks = videoTracks(mov);
    if (tracks.length !== tracksIn.length || tracks.some((t, i) => t.angle !== (tracksIn[i].angle + quarters) % 4)) {
      throw new RotateError('corrupt', 'self-check: video angle');
    }
    const meta = fullBoxBody(find(heic, ROOT(heic), 'meta'));
    for (const item of parseIloc(heic, meta).items) {
      if (item.method === 0 && item.extents.some(e => item.base + e.offset > heic.length)) {
        throw new RotateError('corrupt', `self-check: item ${item.id} points past the end of the file`);
      }
    }
  }

  return { RotateError, parseHeic, describeHeic, videoTracks, rotateHeic, rotateMov, findContentId, rotateLivePhoto };
})();

if (typeof module === 'object' && module.exports) module.exports = ImmichLiveRotate;

// ===================== Browser only =====================

if (typeof document !== 'undefined') (async () => {
  'use strict';

  const { RotateError, rotateLivePhoto } = ImmichLiveRotate;
  const LOG = '[immich-live-rotate]';

  // Immich is self-hosted on any domain: check for a SvelteKit page first, then ping the Immich API.
  if (!document.querySelector('link[href^="/_app/immutable/"], script[src^="/_app/immutable/"]')) return;
  try {
    const r = await fetch('/api/server/ping');
    if ((await r.json()).res !== 'pong') return;
  } catch { return; }

  // ---------- i18n (follows the language Immich is displayed in) ----------

  const STRINGS = {
    en: {
      button: 'Rotate Live Photo',
      angles: ['Not rotated', 'Rotate 90° right', 'Rotate 180°', 'Rotate 90° left'],
      confirm: 'Rotate',
      steps: ['', 'Downloading photo and video…', 'Rewriting orientation…', 'Uploading video…', 'Uploading photo…',
        'Copying albums, description, rating and tags…', 'Checking the original’s motion video…', 'Stacking the original under the new version…'],
      trashStep: 'Moving the original to trash…',
      done: 'Done, opening the new photo…',
      doneWithWarnings: 'Done, with problems: ',
      menu: 'Original photo after rotating…',
      modes: { stack: 'Stack it under the new version', trash: 'Move it to trash' },
      switchMode: (from, to) => `After rotating, the original photo is currently: ${from}.\nChange to: ${to}?`,
      errors: {
        notLive: 'This is not a Live Photo.',
        notOwner: 'You can only rotate your own photos.',
        trashed: 'This photo is in the trash.',
        locked: 'Photos in the locked folder are not supported.',
        notHeicAsset: 'Only HEIC Live Photos are supported for now.',
        jpeg: 'The original file of this photo is actually a JPEG, which is not supported yet.',
        notHeic: 'The photo is not a valid HEIC file.',
        notMov: 'The motion part is not a valid MOV file.',
        noIrot: 'The photo has no rotation property (irot), which is not supported yet.',
        mirrored: 'Mirrored photos or videos are not supported yet.',
        corrupt: 'The file structure is not what was expected.',
        duplicate: 'An identical file already exists on the server.',
        trashDisabled: 'Trash is disabled on this server, so the original would be deleted permanently. Switch the script setting to “Stack it under the new version”.',
        pairingChanged: 'The photo/video pairing is not what was expected, so the original was not deleted.',
        noContentId: 'This photo’s pairing ID could not be found, so moving the original to trash is not safe. Switch the script setting to “Stack it under the new version”.',
      },
      partial: 'The rotated photo was created, but a later step failed: ',
      openNew: 'Open the new photo',
      busyLeave: 'A Live Photo is still being rotated.',
    },
    zh: {
      button: '旋转实况照片',
      angles: ['未旋转', '向右转 90°', '转 180°', '向左转 90°'],
      confirm: '确认旋转',
      steps: ['', '下载原图和动态视频…', '改写方向信息…', '上传动态视频…', '上传照片…',
        '复制相册、描述、评分、标签…', '核对原照片的动态视频…', '把原照片叠到新版本下面…'],
      trashStep: '把原照片放进回收站…',
      done: '完成，正在打开新照片…',
      doneWithWarnings: '完成，但有问题：',
      menu: '原照片处理方式…',
      modes: { stack: '叠在新版本下面', trash: '放进回收站' },
      switchMode: (from, to) => `旋转后原照片现在是「${from}」。\n改成「${to}」吗？`,
      errors: {
        notLive: '不是实况照片。',
        notOwner: '只能旋转自己的照片。',
        trashed: '照片在回收站里。',
        locked: '不支持私密文件夹里的照片。',
        notHeicAsset: '目前只支持 HEIC 格式的实况照片。',
        jpeg: '这张照片的原文件其实是 JPEG，暂不支持。',
        notHeic: '照片不是有效的 HEIC 文件。',
        notMov: '动态部分不是有效的 MOV 文件。',
        noIrot: '这张照片没有旋转属性（irot），暂不支持。',
        mirrored: '暂不支持镜像的照片或视频。',
        corrupt: '文件结构和预期的不一样。',
        duplicate: '服务器上已经有一模一样的文件。',
        trashDisabled: '服务器关闭了回收站，原照片会被直接删除。请在脚本菜单里改成「叠在新版本下面」。',
        pairingChanged: '照片和视频的配对关系不对，为安全起见没有删除原照片。',
        noContentId: '找不到这张照片的配对 ID，放进回收站不安全。请在脚本菜单里改成「叠在新版本下面」。',
      },
      partial: '新照片已经生成，但后面的步骤失败了：',
      openNew: '打开新照片',
      busyLeave: '还有实况照片正在旋转。',
    },
  };
  const lang = (document.documentElement.lang || navigator.language || 'en').toLowerCase();
  const t = lang.startsWith('zh') ? STRINGS.zh : STRINGS.en;
  const errorText = e => (e instanceof RotateError && t.errors[e.code]) || e.message;

  // ---------- Settings ----------

  const store = {
    get: (k, d) => (typeof GM_getValue === 'function' ? GM_getValue(k, d) : JSON.parse(localStorage.getItem('ilr.' + k) ?? JSON.stringify(d))),
    set: (k, v) => (typeof GM_setValue === 'function' ? GM_setValue(k, v) : localStorage.setItem('ilr.' + k, JSON.stringify(v))),
  };
  const originalMode = () => store.get('originalMode', 'stack'); // 'stack' | 'trash'
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand(t.menu, () => {
      const from = originalMode(), to = from === 'stack' ? 'trash' : 'stack';
      if (confirm(t.switchMode(t.modes[from], t.modes[to]))) store.set('originalMode', to);
    });
  }

  // ---------- Immich API (same origin, uses the logged-in session) ----------

  async function api(method, path, body) {
    const init = { method, headers: {} };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    const r = await fetch('/api' + path, init);
    if (!r.ok) {
      let msg = r.statusText;
      try { msg = (await r.json()).message || msg; } catch {}
      throw new Error(`${method} ${path}: ${r.status} ${msg}`);
    }
    return (r.headers.get('content-type') || '').includes('json') ? r.json() : r.arrayBuffer();
  }

  async function upload(bytes, asset, fields) {
    const fd = new FormData();
    fd.append('assetData', new Blob([bytes]), asset.originalFileName);
    fd.append('filename', asset.originalFileName);
    fd.append('fileCreatedAt', asset.fileCreatedAt);
    fd.append('fileModifiedAt', asset.fileModifiedAt);
    for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
    const res = await api('POST', '/assets', fd);
    if (res.status === 'duplicate') throw new RotateError('duplicate', res.id);
    return res.id;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // crypto.randomUUID only exists in secure contexts, and many people open Immich over plain http on their LAN.
  function uuid() {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  // ---------- Rotation workflow ----------

  let me = null;

  /** Returns the asset if this script can rotate it, otherwise throws a RotateError. */
  async function rotatableAsset(id) {
    me ??= api('GET', '/users/me').catch(e => { me = null; throw e; });
    const [user, asset] = await Promise.all([me, api('GET', `/assets/${id}`)]);
    if (asset.type !== 'IMAGE' || !asset.livePhotoVideoId) throw new RotateError('notLive');
    if (asset.ownerId !== user.id) throw new RotateError('notOwner');
    if (asset.isTrashed) throw new RotateError('trashed');
    if (asset.visibility === 'locked') throw new RotateError('locked');
    if (!/hei[cf]/i.test(asset.originalMimeType || '')) throw new RotateError('notHeicAsset');
    return asset;
  }

  const STEP_COUNT = 7;

  /** Thrown after the new photo exists, so the UI can link to it instead of inviting a retry. */
  class PartialError extends Error {
    constructor(newId, cause) {
      super(cause.message);
      this.newId = newId;
      this.cause = cause;
    }
  }

  async function rotateAsset(id, quarters, progress) {
    const asset = await rotatableAsset(id);
    const videoId = asset.livePhotoVideoId;
    const mode = originalMode();
    if (mode === 'trash' && !(await api('GET', '/server/config')).trashDays) throw new RotateError('trashDisabled');

    progress(1);
    const [video, heicData, movData] = await Promise.all([
      api('GET', `/assets/${videoId}`), api('GET', `/assets/${id}/original`), api('GET', `/assets/${videoId}/original`),
    ]);

    progress(2);
    const { heic, mov, contentId } = rotateLivePhoto(heicData, movData, quarters, { newContentId: uuid() });
    // Without a fresh ContentIdentifier, Immich may re-pair the original with the new video at any later time;
    // permanently deleting the trashed original would then take the new video with it.
    if (mode === 'trash' && !contentId) throw new RotateError('noContentId');

    progress(3);
    const newVideoId = await upload(mov, video, { visibility: 'hidden' });
    let newId;
    try {
      progress(4);
      newId = await upload(heic, asset, {
        livePhotoVideoId: newVideoId,
        isFavorite: asset.isFavorite,
        visibility: asset.visibility === 'archive' ? 'archive' : 'timeline',
      });
    } catch (e) {
      // Don't leave the hidden video behind; nothing else refers to it yet.
      await api('DELETE', '/assets', { ids: [newVideoId], force: true }).catch(err => console.error(LOG, err));
      throw e;
    }

    try {
      progress(5);
      const warnings = await copyMetadata(asset, newId);
      progress(6);
      await fixPairing(id, videoId, newId, newVideoId, contentId ? 2 : 5);
      progress(7, mode === 'trash' ? t.trashStep : undefined);
      await retireOriginal(asset, newId, videoId, newVideoId, mode);
      return { newId, warnings };
    } catch (e) {
      throw new PartialError(newId, e);
    }
  }

  /** Favorite is set at upload; copy description, rating, albums and tags. Failures here are only warnings. */
  async function copyMetadata(asset, newId) {
    const warnings = [];
    const warn = e => warnings.push(e.message);
    const exif = asset.exifInfo || {};
    const metadata = {};
    if (exif.description) metadata.description = exif.description;
    if (exif.rating != null) metadata.rating = exif.rating;
    if (Object.keys(metadata).length) await api('PUT', `/assets/${newId}`, metadata).catch(warn);
    for (const album of await api('GET', `/albums?assetId=${asset.id}`).catch(e => (warn(e), []))) {
      await api('PUT', `/albums/${album.id}/assets`, { ids: [newId] }).catch(e => warn(new Error(`${album.albumName}: ${e.message}`)));
    }
    const tagIds = (asset.tags || []).map(tag => tag.id);
    if (tagIds.length) await api('PUT', '/tags/assets', { assetIds: [newId], tagIds }).catch(warn);
    return warnings;
  }

  /** Once Immich extracts the new files' metadata it may re-pair by ContentIdentifier; put both pairs back if so. */
  async function fixPairing(id, videoId, newId, newVideoId, rounds) {
    for (let round = 0; round < rounds; round++) {
      await sleep(round ? 2000 : 1000);
      const [original, created] = await Promise.all([api('GET', `/assets/${id}`), api('GET', `/assets/${newId}`)]);
      if (original.livePhotoVideoId !== videoId) await api('PUT', `/assets/${id}`, { livePhotoVideoId: videoId });
      if (created.livePhotoVideoId !== newVideoId) await api('PUT', `/assets/${newId}`, { livePhotoVideoId: newVideoId });
    }
  }

  /**
   * Stack in both modes. If the original leads a stack, the new photo takes over (the old stack is merged in);
   * if it is a regular member, the new photo joins that stack. A trashed original is hidden from the stack
   * but returns to it when restored.
   */
  async function retireOriginal(asset, newId, videoId, newVideoId, mode) {
    const id = asset.id;
    const keepPrimary = asset.stack && asset.stack.primaryAssetId !== id ? asset.stack.primaryAssetId : null;
    await api('POST', '/stacks', { assetIds: keepPrimary ? [keepPrimary, newId, id] : [newId, id] });
    if (mode !== 'trash') return;
    // Permanently deleting a photo also deletes its paired video, so make sure each photo still has its own video.
    const [original, created] = await Promise.all([api('GET', `/assets/${id}`), api('GET', `/assets/${newId}`)]);
    if (original.livePhotoVideoId !== videoId || created.livePhotoVideoId !== newVideoId) throw new RotateError('pairingChanged');
    await api('DELETE', '/assets', { ids: [id], force: false });
  }

  // ---------- UI ----------

  // mdi "rotate-right-variant" style icon, matching Immich's Material Design Icons
  const ICON = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M16.89,15.5L18.31,16.89C19.21,15.73 19.76,14.39 19.93,13H17.91C17.77,13.87 17.43,14.72 16.89,15.5M13,17.9V19.92C14.39,19.75 15.74,19.21 16.9,18.31L15.46,16.87C14.71,17.41 13.87,17.76 13,17.9M19.93,11C19.76,9.61 19.21,8.27 18.31,7.11L16.89,8.53C17.43,9.28 17.77,10.13 17.91,11M15.55,5.55L11,1V4.07C7.06,4.56 4,7.92 4,12C4,16.08 7.05,19.44 11,19.93V17.91C8.16,17.43 6,14.97 6,12C6,9.03 8.16,6.57 11,6.09V10L15.55,5.55Z"/></svg>';

  // The popover mirrors Immich's own toolbar menus (the "More" menu): light surface, 8px radius, shadow-lg, 14px medium text.
  const style = document.createElement('style');
  style.textContent = `
    #ilr-popover { position: fixed; z-index: 10000; background: #f1f5f9; color: #000;
      border-radius: 8px; padding: 8px 8px 8px 16px; font-size: 14px; font-weight: 500;
      box-shadow: 0 10px 15px -3px rgb(0 0 0 / .1), 0 4px 6px -4px rgb(0 0 0 / .1); }
    #ilr-popover .row { display: flex; align-items: center; gap: 16px; white-space: nowrap; }
    #ilr-popover button { border: 0; border-radius: 9999px; padding: 6px 16px; font: inherit; cursor: pointer;
      background: rgb(66 80 175); color: #fff; }
    #ilr-popover button:hover:not(:disabled) { background: rgb(66 80 175 / .9); }
    #ilr-popover button:disabled { opacity: .4; cursor: default; }
    #ilr-popover .status { margin-top: 8px; margin-right: 8px; font-size: 12px; color: #4b5563; max-width: 280px; white-space: normal; }
    #ilr-popover .status:empty { display: none; }
    #ilr-popover .bar { height: 4px; background: #d1d5db; border-radius: 2px; margin-top: 6px; overflow: hidden; }
    #ilr-popover .bar > div { height: 100%; background: rgb(66 80 175); transition: width .3s; }
    #ilr-popover .error { color: #dc2626; }
    .ilr-preview { transition: transform .25s; }
    /* Immich keeps a same-sized grey loading placeholder behind the image; hide it while the image is turned. */
    body.ilr-previewing #immich-asset-viewer div.absolute.bg-gray-300 { visibility: hidden; }
  `;
  document.head.append(style);

  /** The open popover: { id, deg, quarters, el, label, ok, status, busy, done }. `deg` keeps growing so turns stay clockwise. */
  let session = null;
  // Only one rotation at a time: finishing one reloads the page, which would cut another one short.
  const running = () => session?.busy;
  addEventListener('beforeunload', e => {
    if (running()) { e.preventDefault(); e.returnValue = t.busyLeave; }
  });

  const assetIdFromUrl = () => location.pathname.match(/\/photos\/([0-9a-f-]{36})/)?.[1] ?? null;
  const toolbar = () => document.querySelector('#immich-asset-viewer [data-testid="asset-viewer-navbar-actions"]');
  // The main image (thumbnails in the stack strip use object-cover) and the motion video.
  const previewTargets = id => [...document.querySelectorAll(
    `#immich-asset-viewer img[src*="/api/assets/${id}/"]:not(.object-cover), #immich-asset-viewer video[src*="/api/assets/"]`,
  )];

  function preview(id, deg) {
    const viewer = document.getElementById('immich-asset-viewer')?.getBoundingClientRect();
    document.body.classList.toggle('ilr-previewing', !!deg);
    for (const el of previewTargets(id)) {
      el.classList.add('ilr-preview');
      // Remember the on-screen size before turning (Immich scales the image with an outer transform,
      // so offsetWidth is not the displayed size).
      if (!el.dataset.ilrW) {
        const r = el.getBoundingClientRect();
        el.dataset.ilrW = r.width;
        el.dataset.ilrH = r.height;
      }
      // The image sits in a clipping box the size of its unrotated frame; let it overflow while previewing.
      for (let a = el.parentElement; viewer && a && a.id !== 'immich-asset-viewer'; a = a.parentElement) {
        const r = a.getBoundingClientRect();
        if (getComputedStyle(a).overflow !== 'visible' && (r.width < viewer.width - 1 || r.height < viewer.height - 1)) {
          a.style.overflow = 'visible';
          a.dataset.ilrOverflow = '';
        }
      }
      const sideways = (deg / 90) % 2 === 1;
      const scale = sideways && viewer ? Math.min(viewer.width / el.dataset.ilrH, viewer.height / el.dataset.ilrW, 1) : 1;
      el.style.transform = deg ? `rotate(${deg}deg) scale(${scale})` : '';
    }
  }

  function resetPreview(id) {
    for (const el of previewTargets(id)) {
      el.style.transition = 'none'; // snap back instead of spinning backwards
      el.style.transform = '';
      delete el.dataset.ilrW;
      delete el.dataset.ilrH;
      void el.offsetWidth;
      el.style.transition = '';
    }
    for (const a of document.querySelectorAll('[data-ilr-overflow]')) {
      a.style.overflow = '';
      delete a.dataset.ilrOverflow;
    }
    document.body.classList.remove('ilr-previewing');
  }

  function closePopover() {
    if (!session) return;
    resetPreview(session.id);
    session.el.remove();
    session = null;
  }

  function placePopover(btn) {
    const r = btn.getBoundingClientRect();
    const w = session.el.offsetWidth;
    session.el.style.top = `${r.bottom + 8}px`;
    session.el.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8))}px`;
  }

  /** Each click on the toolbar button turns the preview 90° further clockwise. */
  function turn(btn) {
    if (session.done) return;
    session.status.textContent = '';
    session.deg += 90;
    session.quarters = (session.deg / 90) % 4;
    session.label.textContent = t.angles[session.quarters];
    session.ok.disabled = session.quarters === 0;
    preview(session.id, session.deg);
    placePopover(btn);
  }

  function openPopover(id, btn) {
    closePopover();
    const el = document.createElement('div');
    el.id = 'ilr-popover';
    el.innerHTML = '<div class="row"><span class="label"></span><button type="button" disabled></button></div><div class="status"></div>';
    document.body.append(el);
    session = { id, deg: 0, quarters: 0, el, label: el.querySelector('.label'), ok: el.querySelector('button'), status: el.querySelector('.status'), busy: false };
    session.ok.textContent = t.confirm;
    session.ok.onclick = () => run(session);
    turn(btn);
  }

  async function run(s) {
    s.busy = true;
    s.ok.disabled = true;
    s.status.innerHTML = '<span class="text"></span><div class="bar"><div style="width:0"></div></div>';
    const t0 = performance.now();
    const progress = (step, text = t.steps[step]) => {
      console.info(LOG, `${Math.round(performance.now() - t0)}ms`, step, text);
      s.status.querySelector('.text').textContent = `${text} (${step}/${STEP_COUNT})`;
      s.status.querySelector('.bar > div').style.width = `${(step / STEP_COUNT) * 100}%`;
    };
    try {
      const { newId, warnings } = await rotateAsset(s.id, s.quarters, progress);
      if (warnings.length) console.warn(LOG, warnings);
      s.status.querySelector('.text').textContent = warnings.length ? t.doneWithWarnings + warnings.join('; ') : t.done;
      await sleep(warnings.length ? 4000 : 600);
      s.busy = false;
      openAsset(s.id, newId);
    } catch (e) {
      console.error(LOG, e);
      s.status.innerHTML = '<span class="error"></span>';
      if (e instanceof PartialError) {
        s.done = true; // the new photo exists: offer it instead of a retry that would create another copy
        s.status.firstChild.textContent = t.partial + errorText(e.cause);
        const link = document.createElement('a');
        link.href = `/photos/${e.newId}`;
        link.textContent = t.openNew;
        link.style.cssText = 'display:block;margin-top:6px;color:rgb(66 80 175);text-decoration:underline';
        s.status.append(link);
      } else {
        s.status.firstChild.textContent = errorText(e);
      }
      s.busy = false; // a click elsewhere closes it
    }
  }

  /** Open the new photo in the same context (album, search…) when the user is still on the original. */
  function openAsset(oldId, newId) {
    location.assign(assetIdFromUrl() === oldId ? location.pathname.replace(oldId, newId) + location.search : `/photos/${newId}`);
  }

  // Clicking anywhere outside the popover and the button, or pressing Escape, cancels (not while running).
  document.addEventListener('pointerdown', e => {
    if (!session || session.busy || session.el.contains(e.target) || e.target.closest?.('#ilr-button')) return;
    closePopover();
  }, true);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !session || session.busy) return;
    e.stopPropagation(); // keep Immich from also closing the viewer
    closePopover();
  }, true);

  // ---------- Toolbar button ----------

  const rotatable = new Map(); // asset id -> Promise<boolean>
  const isRotatable = id => {
    if (!rotatable.has(id)) {
      rotatable.set(id, rotatableAsset(id).then(() => true, e => {
        if (!(e instanceof RotateError)) rotatable.delete(id); // network hiccup: ask again on the next tick
        return false;
      }));
    }
    return rotatable.get(id);
  };

  // Immich is a single-page app, so poll for the viewer toolbar instead of hooking its router.
  let lastId = null;
  async function tick() {
    const id = assetIdFromUrl();
    if (id !== lastId) {
      lastId = id;
      if (session && !session.busy && session.id !== id) closePopover();
    }
    const bar = toolbar();
    const existing = document.getElementById('ilr-button');
    if (!id || !bar) { existing?.remove(); return; }
    if (existing?.dataset.assetId === id && existing.parentElement === bar) return;
    existing?.remove();
    if (!(await isRotatable(id)) || assetIdFromUrl() !== id || document.getElementById('ilr-button')) return;
    const btn = document.createElement('button');
    btn.id = 'ilr-button';
    btn.type = 'button';
    btn.dataset.assetId = id;
    btn.title = btn.ariaLabel = t.button;
    btn.className = bar.querySelector('button')?.className ?? ''; // borrow Immich's icon-button styling
    btn.innerHTML = ICON;
    btn.onclick = () => {
      if (running()) return;
      if (session?.id !== id) openPopover(id, btn);
      else turn(btn);
    };
    bar.prepend(btn);
  }
  setInterval(tick, 500);
})();

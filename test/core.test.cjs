// Byte-level tests for the rotation core, run against a real Live Photo pair.
// Usage: node test/core.test.cjs <photo.heic> <video.mov>
// Sample files are personal photos and are not part of the repository; use your own (download the
// original of a Live Photo and its motion video from Immich).
const fs = require('fs');
const assert = require('assert');
const ILR = require('../immich-live-rotate.user.js');

const [heicPath, movPath] = process.argv.slice(2);
if (!heicPath || !movPath) {
  console.error('usage: node test/core.test.cjs <photo.heic> <video.mov>');
  process.exit(2);
}
const heic = fs.readFileSync(heicPath), mov = fs.readFileSync(movPath);
const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const EXIF_CW90 = { 1: 6, 6: 3, 3: 8, 8: 1 };
const swap = size => size && size.split('x').reverse().join('x');

const before = ILR.describeHeic(new Uint8Array(heic));
const tracksBefore = ILR.videoTracks(new Uint8Array(mov));
const primary = before.items[before.primary];
const derived = Object.entries(before.items).filter(([, d]) => d.downstream);
console.log(`primary ${primary.type} irot=${primary.irot}° ispe=${primary.ispe} EXIF=${before.exif};`,
  'derived', derived.map(([id, d]) => `${id}:${d.type} irot=${d.irot}° ispe=${d.ispe}`).join(' ') || 'none',
  '; video', tracksBefore.map(t => `${t.w / 65536}x${t.h / 65536}@${t.angle * 90}°`).join(' '));

// 1. Every angle: regular items turn, derived items keep irot and swap ispe on odd turns,
//    EXIF follows, every video track turns.
for (const q of [1, 2, 3]) {
  const r = ILR.rotateLivePhoto(heic, mov, q);
  const after = ILR.describeHeic(r.heic);
  for (const [id, a] of Object.entries(before.items)) {
    const b = after.items[id];
    if (a.downstream) {
      assert.strictEqual(b.irot, a.irot, `q=${q}: derived item ${id} irot changed`);
      assert.strictEqual(b.ispe, q % 2 ? swap(a.ispe) : a.ispe, `q=${q}: derived item ${id} ispe wrong`);
    } else {
      assert.strictEqual(b.irot, a.irot === null ? null : (a.irot + 360 - 90 * q) % 360, `q=${q}: item ${id} irot wrong`);
      assert.strictEqual(b.ispe, a.ispe, `q=${q}: item ${id} ispe changed`);
    }
  }
  if (before.exif) {
    let o = before.exif;
    for (let i = 0; i < q; i++) o = EXIF_CW90[o];
    assert.strictEqual(after.exif, o, `q=${q}: EXIF wrong`);
  }
  ILR.videoTracks(r.mov).forEach((t, i) => assert.strictEqual(t.angle, (tracksBefore[i].angle + q) % 4, `q=${q}: track ${i} wrong`));
  assert.strictEqual(r.mov.length, mov.length, 'MOV size changed');
  if (q === 1) console.log(`  q=1: HEIC ${heic.length} -> ${r.heic.length} bytes`);
}
console.log('ok  orientation metadata is right for 90°, 180°, 270°');

// 2. Full turns and back-and-forth restore the orientation; properties split once are not split again.
const chain = qs => qs.reduce((acc, q) => ILR.rotateLivePhoto(acc.heic, acc.mov, q), { heic, mov });
const firstLength = ILR.rotateLivePhoto(heic, mov, 1).heic.length;
for (const qs of [[1, 1, 1, 1], [1, -1], [2, 2], [3, 1]]) {
  const r = chain(qs);
  assert.deepStrictEqual(ILR.describeHeic(r.heic), before, `${qs}: orientation not restored`);
  assert(same(r.mov, mov), `${qs}: MOV not restored`);
  assert(r.heic.length <= firstLength, `${qs}: HEIC keeps growing`);
}
console.log('ok  repeated rotations restore the original orientation');

// 3. ContentIdentifier: replaced in both files, same length, nothing else touched.
const newId = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
const r = ILR.rotateLivePhoto(heic, mov, 1, { newContentId: newId });
const plain = ILR.rotateLivePhoto(heic, mov, 1);
assert(r.contentId, 'ContentIdentifier not found');
for (const [a, b] of [[r.heic, plain.heic], [r.mov, plain.mov]]) {
  assert.strictEqual(a.length, b.length);
  const text = Buffer.from(a).toString('latin1');
  assert(!text.includes(r.contentId) && text.includes(newId));
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  assert(diff > 0 && diff <= 36 * 4, `unexpected number of changed bytes: ${diff}`);
}
console.log(`ok  ContentIdentifier ${r.contentId} -> ${newId}`);

// 4. Inputs are left untouched.
assert(same(heic, fs.readFileSync(heicPath)) && same(mov, fs.readFileSync(movPath)));
console.log('ok  inputs untouched');
console.log('all tests passed');

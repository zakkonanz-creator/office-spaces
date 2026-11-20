import { test } from "node:test";
import assert from "node:assert/strict";
import { isUploaded, MAX_PHOTO_BYTES, parsePhoto } from "./photos";

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200)]);
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]);
const url = (mime: string, b: Buffer) => `data:${mime};base64,${b.toString("base64")}`;

test("photos: a real JPEG or PNG is kept, typed by its bytes", () => {
  const a = parsePhoto(url("image/jpeg", jpg));
  assert.ok(!("error" in a) && a.mime === "image/jpeg");
  // Labelled JPEG but really a PNG: the bytes win.
  const b = parsePhoto(url("image/jpeg", png));
  assert.ok(!("error" in b) && b.mime === "image/png");
});

test("photos: anything else is refused in plain words", () => {
  assert.ok("error" in parsePhoto(undefined));
  assert.ok("error" in parsePhoto("https://example.com/me.jpg"));
  assert.ok("error" in parsePhoto(url("image/svg+xml", Buffer.from("<svg onload=alert(1)>".padEnd(200)))));
  assert.ok("error" in parsePhoto(url("image/png", Buffer.from("not a picture at all".padEnd(200)))));
  assert.ok("error" in parsePhoto(url("image/png", Buffer.from([0x89, 0x50]))));
  assert.ok("error" in parsePhoto(url("image/jpeg", Buffer.concat([jpg, Buffer.alloc(MAX_PHOTO_BYTES)]))));
});

test("photos: only uploaded photos count as uploaded (a Slack sync must keep them)", () => {
  assert.equal(isUploaded("/api/photos/0123456789abcdef0123456789abcdef"), true);
  assert.equal(isUploaded("https://avatars.slack-edge.com/x.jpg"), false);
  assert.equal(isUploaded(null), false);
});

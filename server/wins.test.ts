import { test } from "node:test";
import assert from "node:assert/strict";
import { winMedia } from "./wins";

test("wins: a screenshot post shows its picture, the biggest thumbnail Slack made", () => {
  assert.deepEqual(winMedia([{ mimetype: "image/png", thumb_360: "s", thumb_480: "m", url_private: "full" }]), { url: "m", video: false });
  assert.deepEqual(winMedia([{ mimetype: "image/png", thumb_720: "l", thumb_480: "m" }]), { url: "l", video: false });
  // A small image Slack made no big thumbnail for: the file itself.
  assert.deepEqual(winMedia([{ mimetype: "image/png", thumb_360: "s", url_private: "full" }]), { url: "full", video: false });
});

test("wins: a video shows its still; other files and no files show nothing", () => {
  assert.deepEqual(winMedia([{ mimetype: "video/mp4", thumb_video: "still", url_private: "movie" }]), { url: "still", video: true });
  assert.equal(winMedia([{ mimetype: "application/pdf", url_private: "doc" }]), null);
  assert.equal(winMedia([]), null);
  assert.equal(winMedia(undefined), null);
  // The first picture wins when there are several files.
  assert.deepEqual(winMedia([{ mimetype: "application/pdf" }, { mimetype: "image/jpeg", thumb_480: "a" }, { mimetype: "image/png", thumb_480: "b" }]), { url: "a", video: false });
});

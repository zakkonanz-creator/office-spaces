# Fake camera and mic for the load test. Chrome's own fake camera is a flat test
# pattern that compresses far better than a face, which makes bandwidth look
# cheaper than it is. These look more like a webcam: a still room, a person who
# moves a little, and per-frame sensor noise (what real cameras spend bits on).
#   typical  — daylight webcam: light grain, small head motion
#   noisy    — low light: heavy grain, more motion (the expensive case)
# Run: python make_media.py   (needs PyAV + numpy; writes media/*.mjpeg, media/mic.wav)
import os, subprocess, sys, wave
import av, numpy as np

W, H, FPS, SECS = 640, 360, 15, 12
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "media")
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(7)

def background():
    # Soft shapes of a room (shelves, a window, a wall), mostly one colour per area.
    base = rng.normal(0, 1, (H // 40 + 1, W // 40 + 1, 1)) * np.array([1.0, 0.9, 0.8])
    img = np.kron(base, np.ones((40, 40, 1)))[:H, :W]
    for _ in range(12):  # well out of focus
        img = (img + np.roll(img, 3, 0) + np.roll(img, 3, 1) + np.roll(img, -3, 0) + np.roll(img, -3, 1)) / 5
    grad = np.linspace(0.85, 1.1, W)[None, :, None]
    return np.clip(np.array([150, 140, 125]) * grad + img * 30, 0, 255)

def person(frame, t, motion):
    yy, xx = np.mgrid[0:H, 0:W]
    cx = W / 2 + motion * 18 * np.sin(t * 1.3) + motion * 6 * np.sin(t * 3.1)
    cy = H * 0.45 + motion * 6 * np.sin(t * 0.9)
    head = ((xx - cx) / 70) ** 2 + ((yy - cy) / 92) ** 2 <= 1
    body = ((xx - cx) / 150) ** 2 + ((yy - (H + 40)) / 150) ** 2 <= 1
    frame[body] = [60, 75, 110]
    frame[head] = [205, 160, 135]
    mouth = (np.abs(xx - cx) < 18) & (np.abs(yy - (cy + 45)) < 3 + 5 * abs(np.sin(t * 9)) * motion)
    frame[mouth] = [120, 60, 60]
    for ex in (-25, 25):
        frame[(np.abs(xx - (cx + ex)) < 7) & (np.abs(yy - (cy - 15)) < 4)] = [40, 30, 30]

def video(name, noise, motion):
    path = os.path.join(OUT, f"{name}.mjpeg")
    out = av.open(path, "w", format="mjpeg")
    st = out.add_stream("mjpeg", rate=FPS)
    st.width, st.height, st.pix_fmt = W, H, "yuvj420p"
    st.options = {"q:v": "3"}
    bg = background()
    for i in range(FPS * SECS):
        t = i / FPS
        f = bg.copy()
        person(f, t, motion)
        f = f * (1 + 0.01 * np.sin(t * 2)) + rng.normal(0, noise, f.shape)
        frame = av.VideoFrame.from_ndarray(np.clip(f, 0, 255).astype(np.uint8), format="rgb24")
        for p in st.encode(frame.reformat(format="yuvj420p")):
            out.mux(p)
    for p in st.encode(None):
        out.mux(p)
    out.close()
    print(path, os.path.getsize(path) // 1024, "KB")

def mic():
    # ~25% talk time: a sentence, then silence, like someone in a real office.
    aiff = os.path.join(OUT, "speech.aiff")
    subprocess.run(["say", "-v", "Samantha", "-o", aiff, "Sure, I can take that one. Let me check the sub-account and get back to you before lunch."], check=True)
    inp = av.open(aiff)
    rs = av.AudioResampler(format="s16", layout="mono", rate=48000)
    pcm = b"".join(bytes(r.planes[0])[: r.samples * 2] for f in inp.decode(audio=0) for r in rs.resample(f))
    silence = b"\0\0" * 48000 * max(1, round(3 * len(pcm) / 96000))
    with wave.open(os.path.join(OUT, "mic.wav"), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(48000)
        w.writeframes(pcm + silence)
    os.remove(aiff)
    print("mic.wav", round(len(pcm) / 96000, 1), "s speech +", round(len(silence) / 96000, 1), "s silence")

video("cam-typical", noise=3, motion=1.0)
video("cam-noisy", noise=9, motion=1.8)
mic()

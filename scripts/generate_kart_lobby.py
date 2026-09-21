#!/usr/bin/env python3
"""
PopKart / KartRider (跑跑卡丁车) Waiting Room / Lobby BGM Generator
134 BPM bouncy, funky, cheerful lobby track with slap bass, synth marimba, funky rhythm guitar, and warm pads.
"""

import os
import subprocess
import numpy as np
from scipy import signal
import wave

SR = 44100
BPM = 134.0
BEAT = 60.0 / BPM
SIXTEENTH = BEAT / 4.0

TOTAL_BARS = 16
TOTAL_BEATS = TOTAL_BARS * 4
TOTAL_SEC = TOTAL_BEATS * BEAT
TOTAL_SAMPLES = int(TOTAL_SEC * SR)

print(f"Generating PopKart Lobby BGM: {BPM} BPM, {TOTAL_BARS} bars, {TOTAL_SEC:.2f}s...")

left = np.zeros(TOTAL_SAMPLES, dtype=np.float32)
right = np.zeros(TOTAL_SAMPLES, dtype=np.float32)

NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
def note_freq(name):
    pitch = name[:-1]
    octave = int(name[-1])
    semitone = NOTE_NAMES.index(pitch)
    midi = 12 * (octave + 1) + semitone
    return 440.0 * (2.0 ** ((midi - 69) / 12.0))

# Bouncy drums
def make_bouncy_kick():
    dur = int(0.2 * SR)
    t = np.linspace(0, 0.2, dur, endpoint=False)
    f_env = 55.0 + 90.0 * np.exp(-t * 35.0)
    phase = 2 * np.pi * np.cumsum(f_env) / SR
    return np.sin(phase) * np.exp(-t * 18.0) * 0.85

def make_rimshot():
    dur = int(0.08 * SR)
    t = np.linspace(0, 0.08, dur, endpoint=False)
    click = np.sin(2 * np.pi * 840.0 * t) * np.exp(-t * 60.0)
    noise = np.random.uniform(-1, 1, dur) * np.exp(-t * 80.0)
    return (click * 0.6 + noise * 0.4) * 0.65

def make_shaker():
    dur = int(0.05 * SR)
    t = np.linspace(0, 0.05, dur, endpoint=False)
    noise = np.random.uniform(-1, 1, dur)
    b, a = signal.butter(2, 6500 / (SR/2), btype='high')
    return signal.lfilter(b, a, noise) * np.exp(-t * 75.0) * 0.25

b_kick = make_bouncy_kick()
b_rim = make_rimshot()
b_shaker = make_shaker()

for beat_idx in range(TOTAL_BEATS):
    t_start = int(beat_idx * BEAT * SR)
    beat_in_bar = beat_idx % 4

    # Kick on 1 and 3 (and light kick on 4.5)
    if beat_in_bar == 0 or beat_in_bar == 2:
        end = min(TOTAL_SAMPLES, t_start + len(b_kick))
        left[t_start:end] += b_kick[:end-t_start] * 0.9
        right[t_start:end] += b_kick[:end-t_start] * 0.9

    # Rimshot / snare on 2 and 4
    if beat_in_bar == 1 or beat_in_bar == 3:
        end = min(TOTAL_SAMPLES, t_start + len(b_rim))
        left[t_start:end] += b_rim[:end-t_start] * 0.8
        right[t_start:end] += b_rim[:end-t_start] * 0.8

    # Shaker on all 16ths
    for s in range(4):
        sh_t = int((beat_idx * BEAT + s * SIXTEENTH) * SR)
        end = min(TOTAL_SAMPLES, sh_t + len(b_shaker))
        pan = 0.3 if s % 2 == 0 else -0.3
        p_l = np.sqrt(0.5 * (1.0 - pan))
        p_r = np.sqrt(0.5 * (1.0 + pan))
        left[sh_t:end] += b_shaker[:end-sh_t] * p_l
        right[sh_t:end] += b_shaker[:end-sh_t] * p_r

# Marimba Synth Melody (Classic KartRider Waiting Room Vibe!)
def synth_marimba(freq, dur_sec):
    n_samples = int(dur_sec * SR)
    t = np.linspace(0, dur_sec, n_samples, endpoint=False)
    tone = np.sin(2 * np.pi * freq * t) + 0.3 * np.sin(2 * np.pi * 3.0 * freq * t)
    env = np.exp(-t * 16.0)
    return tone * env * 0.45

LOBBY_MELODY = [
    (0, 'C5', 2), (2, 'E5', 2), (4, 'G5', 2), (6, 'A5', 2),
    (8, 'G5', 4), (12, 'E5', 4),
    (16, 'D5', 2), (18, 'E5', 2), (20, 'F5', 4), (24, 'D5', 4),
    (32, 'C5', 2), (34, 'E5', 2), (36, 'G5', 2), (38, 'C6', 2),
    (40, 'B5', 3), (43, 'A5', 3), (46, 'G5', 2),
    (48, 'A5', 4), (52, 'G5', 4), (56, 'E5', 4), (60, 'C5', 4)
]

for bar_offset in [0, 8]:
    for step, note, dur_s in LOBBY_MELODY:
        t_sec = (bar_offset * 4 * BEAT) + (step * SIXTEENTH)
        freq = note_freq(note)
        m_sample = synth_marimba(freq, dur_s * SIXTEENTH * 0.9)
        t_start = int(t_sec * SR)
        end = min(TOTAL_SAMPLES, t_start + len(m_sample))
        left[t_start:end] += m_sample[:end-t_start] * 0.6
        right[t_start:end] += m_sample[:end-t_start] * 0.6

# Bouncy Slap Bass in C major / A minor
def synth_lobby_bass(freq, dur_sec):
    n_samples = int(dur_sec * SR)
    t = np.linspace(0, dur_sec, n_samples, endpoint=False)
    saw = 2.0 * (t * freq - np.floor(t * freq + 0.5))
    sq = np.sign(np.sin(2 * np.pi * freq * t))
    wave_b = 0.7 * saw + 0.3 * sq
    f_env = 180.0 + 1200.0 * np.exp(-t * 24.0)
    mod = np.sin(2 * np.pi * np.cumsum(f_env) / SR)
    return (wave_b * 0.6 + mod * 0.4) * np.exp(-t * 12.0) * 0.65

LOBBY_CHORDS = ['C', 'G', 'A', 'F', 'C', 'G', 'F', 'G']
for bar_idx in range(TOTAL_BARS):
    root = LOBBY_CHORDS[bar_idx % len(LOBBY_CHORDS)]
    pattern = [(0, root + '2'), (4, root + '3'), (8, root + '2'), (12, root + '3')]
    for s_step, note in pattern:
        t_sec = (bar_idx * 4 * BEAT) + (s_step * SIXTEENTH)
        freq = note_freq(note)
        b_sample = synth_lobby_bass(freq, SIXTEENTH * 2.0)
        t_start = int(t_sec * SR)
        end = min(TOTAL_SAMPLES, t_start + len(b_sample))
        left[t_start:end] += b_sample[:end-t_start] * 0.7
        right[t_start:end] += b_sample[:end-t_start] * 0.7

max_val = max(np.max(np.abs(left)), np.max(np.abs(right)))
if max_val > 0.01:
    left = np.tanh(left / max_val * 1.25) * 0.92
    right = np.tanh(right / max_val * 1.25) * 0.92

stereo = np.empty((TOTAL_SAMPLES, 2), dtype=np.int16)
stereo[:, 0] = np.int16(left * 32767)
stereo[:, 1] = np.int16(right * 32767)

raw_wav_path = "/tmp/kart_lobby_raw.wav"
out_mp3_path = "public/audio/bgm-menu.mp3"

with wave.open(raw_wav_path, 'wb') as wav_file:
    wav_file.setnchannels(2)
    wav_file.setsampwidth(2)
    wav_file.setframerate(SR)
    wav_file.writeframes(stereo.tobytes())

cmd = [
    "ffmpeg", "-y", "-i", raw_wav_path,
    "-codec:a", "libmp3lame", "-b:a", "192k",
    out_mp3_path
]
subprocess.run(cmd, check=True)
os.remove(raw_wav_path)
print(f"Successfully generated 跑跑卡丁车 Lobby BGM at {out_mp3_path}!")

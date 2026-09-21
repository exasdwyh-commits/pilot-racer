#!/usr/bin/env python3
"""
PopKart / KartRider (跑跑卡丁车) Arcade Battle Racing BGM Generator
Generates a multi-track 154 BPM studio-grade Eurobeat / Funk Rock arcade racing track.
Zero external audio samples; pure mathematical synthesis with stereo spatialization.
"""

import os
import subprocess
import numpy as np
from scipy import signal
import wave

SR = 44100
BPM = 154.0
BEAT = 60.0 / BPM
SIXTEENTH = BEAT / 4.0

TOTAL_BARS = 32
TOTAL_BEATS = TOTAL_BARS * 4
TOTAL_SEC = TOTAL_BEATS * BEAT
TOTAL_SAMPLES = int(TOTAL_SEC * SR)

print(f"Generating PopKart Arcade BGM: {BPM} BPM, {TOTAL_BARS} bars, {TOTAL_SEC:.2f}s ({TOTAL_SAMPLES} samples)...")

# Stereo output buffer
left = np.zeros(TOTAL_SAMPLES, dtype=np.float32)
right = np.zeros(TOTAL_SAMPLES, dtype=np.float32)

NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
def note_freq(name):
    pitch = name[:-1]
    octave = int(name[-1])
    semitone = NOTE_NAMES.index(pitch)
    midi = 12 * (octave + 1) + semitone
    return 440.0 * (2.0 ** ((midi - 69) / 12.0))

def make_kick():
    dur = int(0.28 * SR)
    t = np.linspace(0, 0.28, dur, endpoint=False)
    f_env = 48.0 + 112.0 * np.exp(-t * 28.0)
    phase = 2 * np.pi * np.cumsum(f_env) / SR
    amp = np.exp(-t * 14.0)
    click = np.sin(2 * np.pi * 1200.0 * t[:int(0.015*SR)]) * np.exp(-t[:int(0.015*SR)] * 240.0)
    body = np.sin(phase) * amp
    body[:len(click)] += click * 0.45
    return np.clip(body * 0.95, -1.0, 1.0)

def make_snare():
    dur = int(0.24 * SR)
    t = np.linspace(0, 0.24, dur, endpoint=False)
    tone = (np.sin(2 * np.pi * 185.0 * t) + 0.4 * np.sin(2 * np.pi * 330.0 * t)) * np.exp(-t * 22.0)
    noise = np.random.uniform(-1, 1, dur)
    b, a = signal.butter(2, [1200 / (SR/2), 5500 / (SR/2)], btype='band')
    noise_filt = signal.lfilter(b, a, noise) * np.exp(-t * 16.0)
    snare = tone * 0.5 + noise_filt * 0.75
    return np.clip(snare * 0.85, -1.0, 1.0)

def make_closed_hat():
    dur = int(0.065 * SR)
    t = np.linspace(0, 0.065, dur, endpoint=False)
    noise = np.random.uniform(-1, 1, dur)
    b, a = signal.butter(2, 7000 / (SR/2), btype='high')
    return signal.lfilter(b, a, noise) * np.exp(-t * 70.0) * 0.35

def make_open_hat():
    dur = int(0.26 * SR)
    t = np.linspace(0, 0.26, dur, endpoint=False)
    noise = np.random.uniform(-1, 1, dur)
    b, a = signal.butter(2, 6000 / (SR/2), btype='high')
    return signal.lfilter(b, a, noise) * np.exp(-t * 18.0) * 0.42

def make_crash():
    dur = int(2.4 * SR)
    t = np.linspace(0, 2.4, dur, endpoint=False)
    noise = np.random.uniform(-1, 1, dur)
    b, a = signal.butter(2, 4000 / (SR/2), btype='high')
    ring = np.sin(2*np.pi*3120*t) + np.sin(2*np.pi*4480*t) + np.sin(2*np.pi*5890*t)
    crash = (signal.lfilter(b, a, noise) * 0.8 + ring * 0.2) * np.exp(-t * 2.8)
    return crash * 0.55

kick_sample = make_kick()
snare_sample = make_snare()
chat_sample = make_closed_hat()
ohat_sample = make_open_hat()
crash_sample = make_crash()

print("Placing drums...")
for beat_idx in range(TOTAL_BEATS):
    t_start = int(beat_idx * BEAT * SR)
    bar_idx = beat_idx // 4
    beat_in_bar = beat_idx % 4

    end = min(TOTAL_SAMPLES, t_start + len(kick_sample))
    left[t_start:end] += kick_sample[:end-t_start] * 0.95
    right[t_start:end] += kick_sample[:end-t_start] * 0.95

    if beat_in_bar == 1 or beat_in_bar == 3:
        end = min(TOTAL_SAMPLES, t_start + len(snare_sample))
        left[t_start:end] += snare_sample[:end-t_start] * 0.88
        right[t_start:end] += snare_sample[:end-t_start] * 0.88

    if beat_in_bar == 3 and (bar_idx + 1) % 4 == 0:
        for s_idx in range(4):
            fill_t = int((beat_idx * BEAT + s_idx * SIXTEENTH) * SR)
            end = min(TOTAL_SAMPLES, fill_t + len(snare_sample))
            gain = 0.6 + s_idx * 0.15
            left[fill_t:end] += snare_sample[:end-fill_t] * gain
            right[fill_t:end] += snare_sample[:end-fill_t] * gain

    for s_idx in range(4):
        h_start = int((beat_idx * BEAT + s_idx * SIXTEENTH) * SR)
        if s_idx == 2:
            end = min(TOTAL_SAMPLES, h_start + len(ohat_sample))
            left[h_start:end] += ohat_sample[:end-h_start] * 0.55
            right[h_start:end] += ohat_sample[:end-h_start] * 0.45
        else:
            end = min(TOTAL_SAMPLES, h_start + len(chat_sample))
            vel = 0.5 if s_idx == 0 else 0.35
            left[h_start:end] += chat_sample[:end-h_start] * vel * 0.45
            right[h_start:end] += chat_sample[:end-h_start] * vel * 0.55

    if beat_in_bar == 0 and bar_idx in [0, 8, 16, 24]:
        end = min(TOTAL_SAMPLES, t_start + len(crash_sample))
        left[t_start:end] += crash_sample[:end-t_start] * 0.8
        right[t_start:end] += crash_sample[:end-t_start] * 0.8

def synth_slap_bass(freq, dur_sec, is_pop=False):
    n_samples = int(dur_sec * SR)
    t = np.linspace(0, dur_sec, n_samples, endpoint=False)
    saw = 2.0 * (t * freq - np.floor(t * freq + 0.5))
    sq = np.sign(np.sin(2 * np.pi * freq * t))
    wave_b = 0.65 * saw + 0.35 * sq

    start_f = 2800.0 if is_pop else 1800.0
    end_f = 220.0
    f_env = end_f + (start_f - end_f) * np.exp(-t * 22.0)
    mod = np.sin(2 * np.pi * np.cumsum(f_env) / SR)
    amp = np.exp(-t * (16.0 if is_pop else 10.0))
    bass = (wave_b * 0.6 + mod * 0.4) * amp
    return bass * (0.85 if is_pop else 0.95)

CHORD_PROGRESSIONS = [
    ['D', 'C', 'A#', 'C'],
    ['D', 'F', 'G', 'A'],
    ['D', 'C', 'A#', 'C'],
    ['G', 'A', 'A#', 'A'],
    ['D', 'C', 'A#', 'C'],
    ['D', 'F', 'G', 'A'],
    ['D', 'C', 'A#', 'C'],
    ['G', 'A', 'A#', 'A']
]

print("Synthesizing Slap Bassline...")
for bar_idx in range(TOTAL_BARS):
    prog_group = bar_idx // 4
    chord_in_group = bar_idx % 4
    root = CHORD_PROGRESSIONS[prog_group][chord_in_group]

    pattern = [
        (0, root + '2', False),
        (2, root + '3', True),
        (4, root + '2', False),
        (6, root + '2', False),
        (8, root + '2', False),
        (10, root + '3', True),
        (12, root + '2', False),
        (14, root + '3', True)
    ]
    for s_step, note, is_pop in pattern:
        t_sec = (bar_idx * 4 * BEAT) + (s_step * SIXTEENTH)
        dur = SIXTEENTH * (1.2 if is_pop else 1.8)
        freq = note_freq(note)
        b_sample = synth_slap_bass(freq, dur, is_pop)
        t_start = int(t_sec * SR)
        end = min(TOTAL_SAMPLES, t_start + len(b_sample))
        left[t_start:end] += b_sample[:end-t_start] * 0.72
        right[t_start:end] += b_sample[:end-t_start] * 0.72

def synth_brass_stab(freqs, dur_sec):
    n_samples = int(dur_sec * SR)
    t = np.linspace(0, dur_sec, n_samples, endpoint=False)
    chord_wave = np.zeros(n_samples, dtype=np.float32)
    for f in freqs:
        saw1 = 2.0 * (t * f - np.floor(t * f + 0.5))
        saw2 = 2.0 * (t * (f * 1.004) - np.floor(t * (f * 1.004) + 0.5))
        chord_wave += (saw1 + saw2) * 0.5
    chord_wave /= len(freqs)
    env = np.clip(t / 0.015, 0, 1) * np.exp(-t * 9.0)
    b, a = signal.butter(2, [450 / (SR/2), 3400 / (SR/2)], btype='band')
    filtered = signal.lfilter(b, a, chord_wave)
    return filtered * env * 0.75

CHORD_NOTES = {
    'D': ['D4', 'F4', 'A4', 'D5'],
    'C': ['C4', 'E4', 'G4', 'C5'],
    'A#': ['A#3', 'D4', 'F4', 'A#4'],
    'F': ['F3', 'A3', 'C4', 'F4'],
    'G': ['G3', 'A#3', 'D4', 'G4'],
    'A': ['A3', 'C#4', 'E4', 'A4']
}

print("Synthesizing Funky Brass Hits...")
for bar_idx in range(TOTAL_BARS):
    prog_group = bar_idx // 4
    chord_in_group = bar_idx % 4
    root = CHORD_PROGRESSIONS[prog_group][chord_in_group]
    freqs = [note_freq(n) for n in CHORD_NOTES[root]]

    for s_step in [2, 6, 12]:
        t_sec = (bar_idx * 4 * BEAT) + (s_step * SIXTEENTH)
        dur = SIXTEENTH * 2.2
        stab = synth_brass_stab(freqs, dur)
        t_start = int(t_sec * SR)
        end = min(TOTAL_SAMPLES, t_start + len(stab))
        left[t_start:end] += stab[:end-t_start] * 0.65
        right[t_start:end] += stab[:end-t_start] * 0.45

def synth_lead(freq, dur_sec, pan=0.0):
    n_samples = int(dur_sec * SR)
    t = np.linspace(0, dur_sec, n_samples, endpoint=False)
    saws = np.zeros(n_samples, dtype=np.float32)
    detunes = [-0.012, -0.005, 0.0, 0.005, 0.012]
    vib_depth = np.clip((t - 0.1) * 0.02, 0, 0.022)
    vib = np.sin(2 * np.pi * 6.2 * t) * vib_depth

    for d in detunes:
        f = freq * (1.0 + d + vib)
        saws += 2.0 * (t * f - np.floor(t * f + 0.5))
    saws /= len(detunes)

    env = np.clip(t / 0.018, 0, 1) * np.clip((dur_sec - t) / 0.03, 0, 1)
    b, a = signal.butter(2, [350 / (SR/2), 7500 / (SR/2)], btype='band')
    sig_out = signal.lfilter(b, a, saws) * env * 0.68

    p_l = np.sqrt(0.5 * (1.0 - pan))
    p_r = np.sqrt(0.5 * (1.0 + pan))
    return sig_out * p_l, sig_out * p_r

MELODY_PHRASE_A = [
    (0, 'A4', 2), (2, 'D5', 2), (4, 'F5', 2), (6, 'G5', 2),
    (8, 'A5', 4), (12, 'G5', 2), (14, 'F5', 2),
    (16, 'E5', 2), (18, 'F5', 2), (20, 'G5', 4), (24, 'D5', 6),
    (32, 'A4', 2), (34, 'C5', 2), (36, 'D5', 2), (38, 'E5', 2),
    (40, 'F5', 4), (44, 'E5', 2), (46, 'D5', 2),
    (48, 'C5', 4), (52, 'D5', 8),
    (64, 'A4', 2), (66, 'D5', 2), (68, 'F5', 2), (70, 'G5', 2),
    (72, 'A5', 3), (75, 'C6', 3), (78, 'D6', 6),
    (88, 'C6', 2), (90, 'A#5', 2), (92, 'A5', 2), (94, 'G5', 2),
    (96, 'A5', 4), (100, 'D5', 8)
]

MELODY_PHRASE_B = [
    (0, 'F5', 2), (2, 'G5', 2), (4, 'A5', 2), (6, 'D6', 6),
    (12, 'C6', 2), (14, 'A#5', 2),
    (16, 'A5', 3), (19, 'G5', 3), (22, 'F5', 2), (24, 'G5', 6),
    (32, 'F5', 2), (34, 'G5', 2), (36, 'A5', 2), (38, 'C6', 6),
    (44, 'D6', 8),
    (56, 'E6', 4), (60, 'D6', 8),
    (72, 'D6', 2), (74, 'C6', 2), (76, 'A#5', 2), (78, 'A5', 2),
    (80, 'G5', 2), (82, 'A5', 2), (84, 'A#5', 4), (88, 'C6', 4),
    (96, 'D6', 12)
]

print("Synthesizing Arcade Lead Melody...")
def place_melody(phrase, bar_offset, pan=0.0):
    for step, note, dur_steps in phrase:
        t_sec = (bar_offset * 4 * BEAT) + (step * SIXTEENTH)
        dur_sec = dur_steps * SIXTEENTH * 0.96
        freq = note_freq(note)
        s_l, s_r = synth_lead(freq, dur_sec, pan)
        t_start = int(t_sec * SR)
        end = min(TOTAL_SAMPLES, t_start + len(s_l))
        left[t_start:end] += s_l[:end-t_start]
        right[t_start:end] += s_r[:end-t_start]

        echo_delay = int(3 * SIXTEENTH * SR)
        if t_start + echo_delay < TOTAL_SAMPLES:
            echo_end = min(TOTAL_SAMPLES, t_start + echo_delay + len(s_l))
            left[t_start+echo_delay:echo_end] += s_r[:echo_end-(t_start+echo_delay)] * 0.28
            right[t_start+echo_delay:echo_end] += s_l[:echo_end-(t_start+echo_delay)] * 0.28

place_melody(MELODY_PHRASE_A, 0, pan=-0.15)
place_melody(MELODY_PHRASE_B, 8, pan=0.15)
place_melody(MELODY_PHRASE_A, 16, pan=-0.25)
place_melody(MELODY_PHRASE_B, 24, pan=0.25)

def synth_arp_note(freq, dur_sec):
    n_samples = int(dur_sec * SR)
    t = np.linspace(0, dur_sec, n_samples, endpoint=False)
    wave_a = 0.5 * np.sin(2 * np.pi * freq * t) + 0.5 * (2.0 * (t * freq - np.floor(t * freq + 0.5)))
    env = np.exp(-t * 26.0)
    return wave_a * env * 0.22

print("Synthesizing Eurobeat Arpeggiator...")
ARP_PATTERNS = {
    'D': ['D4', 'F4', 'A4', 'D5', 'F5', 'D5', 'A4', 'F4'],
    'C': ['C4', 'E4', 'G4', 'C5', 'E5', 'C5', 'G4', 'E4'],
    'A#': ['A#3', 'D4', 'F4', 'A#4', 'D5', 'A#4', 'F4', 'D4'],
    'F': ['F3', 'A3', 'C4', 'F4', 'A4', 'F4', 'C4', 'A3'],
    'G': ['G3', 'A#3', 'D4', 'G4', 'A#4', 'G4', 'D4', 'A#3'],
    'A': ['A3', 'C#4', 'E4', 'A4', 'C#5', 'A4', 'E4', 'C#4']
}

for bar_idx in range(TOTAL_BARS):
    prog_group = bar_idx // 4
    chord_in_group = bar_idx % 4
    root = CHORD_PROGRESSIONS[prog_group][chord_in_group]
    arp_notes = ARP_PATTERNS[root]
    for s_step in range(16):
        note = arp_notes[s_step % len(arp_notes)]
        t_sec = (bar_idx * 4 * BEAT) + (s_step * SIXTEENTH)
        dur = SIXTEENTH * 0.8
        freq = note_freq(note)
        note_sample = synth_arp_note(freq, dur)
        t_start = int(t_sec * SR)
        end = min(TOTAL_SAMPLES, t_start + len(note_sample))
        pan = np.sin(s_step * np.pi / 4.0) * 0.6
        p_l = np.sqrt(0.5 * (1.0 - pan))
        p_r = np.sqrt(0.5 * (1.0 + pan))
        left[t_start:end] += note_sample[:end-t_start] * p_l
        right[t_start:end] += note_sample[:end-t_start] * p_r

print("Mastering & Normalizing...")
max_val = max(np.max(np.abs(left)), np.max(np.abs(right)))
if max_val > 0.01:
    left = np.tanh(left / max_val * 1.35) * 0.94
    right = np.tanh(right / max_val * 1.35) * 0.94

stereo = np.empty((TOTAL_SAMPLES, 2), dtype=np.int16)
stereo[:, 0] = np.int16(left * 32767)
stereo[:, 1] = np.int16(right * 32767)

raw_wav_path = "/tmp/kart_bgm_raw.wav"
out_mp3_path = "public/audio/bgm-race.mp3"

with wave.open(raw_wav_path, 'wb') as wav_file:
    wav_file.setnchannels(2)
    wav_file.setsampwidth(2)
    wav_file.setframerate(SR)
    wav_file.writeframes(stereo.tobytes())

print(f"Encoding to {out_mp3_path} with ffmpeg (VBR 192k)...")
os.makedirs(os.path.dirname(out_mp3_path), exist_ok=True)
cmd = [
    "ffmpeg", "-y", "-i", raw_wav_path,
    "-codec:a", "libmp3lame", "-b:a", "192k",
    out_mp3_path
]
subprocess.run(cmd, check=True)
os.remove(raw_wav_path)
print(f"Successfully generated 跑跑卡丁车 Arcade Battle BGM at {out_mp3_path}!")

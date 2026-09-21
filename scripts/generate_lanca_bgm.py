#!/usr/bin/env python3
"""
Rita Lee - Lança Perfume (Arcade Racing BGM Generator)
Synthesizes pure instrumental racing BGM referencing the core melody of Lança Perfume.
BPM: 160, 32 bars = 48.00s seamless loop, 48kHz stereo.
Meets all loop fitness requirements (no intro, steady energy, seam wrap-around).
"""

import os
import sys
import subprocess
from pathlib import Path
import numpy as np
from scipy import signal
import scipy.io.wavfile

SR = 48000
BPM = 160.0
BEAT = 60.0 / BPM
SIXTEENTH = BEAT / 4.0
TOTAL_BARS = 32
TOTAL_BEATS = TOTAL_BARS * 4
TOTAL_SEC = TOTAL_BEATS * BEAT  # Exactly 48.000s
TOTAL_SAMPLES = int(round(TOTAL_SEC * SR))

# Render 1 extra bar for pre-roll wrap-around crossfade
RENDER_BARS = TOTAL_BARS + 1
RENDER_BEATS = RENDER_BARS * 4
FADE_SAMPLES = int(round(60.0 / BPM * SR))  # 1 beat (0.375s) pre-roll window
BUF_SAMPLES = TOTAL_SAMPLES + FADE_SAMPLES + int(0.5 * SR)

print(f"Generating Rita Lee - Lança Perfume Arcade Racing BGM...")
print(f"Tempo: {BPM} BPM, Bars: {TOTAL_BARS}, Duration: {TOTAL_SEC:.2f}s ({TOTAL_SAMPLES} samples @ {SR}Hz)")

left = np.zeros(BUF_SAMPLES, dtype=np.float64)
right = np.zeros(BUF_SAMPLES, dtype=np.float64)

NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
FLAT_MAP = {'Db': 'C#', 'Eb': 'D#', 'Gb': 'F#', 'Ab': 'G#', 'Bb': 'A#'}
def note_freq(name):
    pitch = name[:-1]
    octave = int(name[-1])
    pitch = FLAT_MAP.get(pitch, pitch)
    semitone = NOTE_NAMES.index(pitch)
    midi = 12 * (octave + 1) + semitone
    return 440.0 * (2.0 ** ((midi - 69) / 12.0))

def mix_into(dst, src, start_idx, gain=1.0):
    if start_idx >= len(dst) or start_idx + len(src) <= 0:
        return
    src_start = max(0, -start_idx)
    dst_start = max(0, start_idx)
    length = min(len(src) - src_start, len(dst) - dst_start)
    if length > 0:
        dst[dst_start:dst_start + length] += src[src_start:src_start + length] * gain

# ---------------------------------------------------------------------------
# Drum Synthesizers (Punchy, glossy disco-arcade drums)
# ---------------------------------------------------------------------------
def make_kick():
    dur = int(0.24 * SR)
    t = np.linspace(0, 0.24, dur, endpoint=False)
    f_env = 48.0 + 115.0 * np.exp(-t * 30.0)
    phase = 2 * np.pi * np.cumsum(f_env) / SR
    amp = np.exp(-t * 11.0)
    click = np.sin(2 * np.pi * 1600.0 * t[:int(0.012*SR)]) * np.exp(-t[:int(0.012*SR)] * 260.0)
    body = np.sin(phase) * amp
    body[:len(click)] += click * 0.5
    return np.clip(body * 0.95, -1.0, 1.0)

def make_snare():
    dur = int(0.22 * SR)
    t = np.linspace(0, 0.22, dur, endpoint=False)
    tone = (np.sin(2 * np.pi * 196.0 * t) + 0.45 * np.sin(2 * np.pi * 330.0 * t)) * np.exp(-t * 22.0)
    noise = np.random.uniform(-1, 1, dur)
    b, a = signal.butter(2, [1100 / (SR/2), 6500 / (SR/2)], btype='band')
    noise_filt = signal.lfilter(b, a, noise) * np.exp(-t * 14.0)
    clap = np.zeros(dur)
    for offset_ms in [0, 10, 22]:
        start = int(offset_ms * 0.001 * SR)
        end = min(dur, start + int(0.03 * SR))
        clap[start:end] += np.random.uniform(-0.6, 0.6, end - start) * np.exp(-np.linspace(0, 1, end - start) * 8.0)
    snare = tone * 0.4 + noise_filt * 0.55 + clap * 0.35
    return np.clip(snare * 0.9, -1.0, 1.0)

def make_closed_hat():
    dur = int(0.06 * SR)
    t = np.linspace(0, 0.06, dur, endpoint=False)
    noise = np.random.uniform(-1, 1, dur)
    b, a = signal.butter(2, 7500 / (SR/2), btype='high')
    return signal.lfilter(b, a, noise) * np.exp(-t * 85.0) * 0.38

def make_open_hat():
    dur = int(0.22 * SR)
    t = np.linspace(0, 0.22, dur, endpoint=False)
    noise = np.random.uniform(-1, 1, dur)
    b, a = signal.butter(2, 6500 / (SR/2), btype='high')
    ring = (np.sin(2 * np.pi * 3200 * t) + np.sin(2 * np.pi * 4800 * t) + np.sin(2 * np.pi * 7100 * t)) * 0.2
    return (signal.lfilter(b, a, noise) * 0.8 + ring) * np.exp(-t * 18.0) * 0.45

def make_crash():
    dur = int(2.2 * SR)
    t = np.linspace(0, 2.2, dur, endpoint=False)
    noise = np.random.uniform(-1, 1, dur)
    b, a = signal.butter(2, 4500 / (SR/2), btype='high')
    ring = (np.sin(2*np.pi*2850*t) + np.sin(2*np.pi*4200*t) + np.sin(2*np.pi*6100*t)) * 0.18
    return (signal.lfilter(b, a, noise) * 0.82 + ring) * np.exp(-t * 2.6) * 0.5

def make_tambourine():
    dur = int(0.08 * SR)
    t = np.linspace(0, 0.08, dur, endpoint=False)
    noise = np.random.uniform(-1, 1, dur)
    b, a = signal.butter(2, [5000 / (SR/2), 12000 / (SR/2)], btype='band')
    return signal.lfilter(b, a, noise) * np.exp(-t * 60.0) * 0.3

kick_s = make_kick()
snare_s = make_snare()
chat_s = make_closed_hat()
ohat_s = make_open_hat()
crash_s = make_crash()
tamb_s = make_tambourine()

print("Placing rhythm section...")
for beat_idx in range(RENDER_BEATS):
    t_start = int(beat_idx * BEAT * SR)
    bar_idx = beat_idx // 4
    beat_in_bar = beat_idx % 4

    mix_into(left, kick_s, t_start, 0.92)
    mix_into(right, kick_s, t_start, 0.92)

    if beat_in_bar in [1, 3]:
        mix_into(left, snare_s, t_start, 0.86)
        mix_into(right, snare_s, t_start, 0.86)

    for s_idx in range(4):
        h_start = int((beat_idx * BEAT + s_idx * SIXTEENTH) * SR)
        if s_idx == 2:
            mix_into(left, ohat_s, h_start, 0.52)
            mix_into(right, ohat_s, h_start, 0.44)
        else:
            vel = 0.5 if s_idx == 0 else 0.36
            mix_into(left, chat_s, h_start, vel * 0.45)
            mix_into(right, chat_s, h_start, vel * 0.55)

        if s_idx in [1, 3]:
            mix_into(left, tamb_s, h_start, 0.24)
            mix_into(right, tamb_s, h_start, 0.28)

    if beat_in_bar == 3 and (bar_idx + 1) % 4 == 0 and bar_idx < TOTAL_BARS:
        for s_idx in range(4):
            fill_t = int((beat_idx * BEAT + s_idx * SIXTEENTH) * SR)
            gain = 0.55 + s_idx * 0.15
            mix_into(left, snare_s, fill_t, gain)
            mix_into(right, snare_s, fill_t, gain)

    if beat_in_bar == 0 and bar_idx in [0, 8, 16, 24]:
        mix_into(left, crash_s, t_start, 0.75)
        mix_into(right, crash_s, t_start, 0.75)

# ---------------------------------------------------------------------------
# Bass & Chords
# ---------------------------------------------------------------------------
def synth_slap_bass(freq, dur_sec, is_pop=False):
    n_samples = int(dur_sec * SR)
    t = np.linspace(0, dur_sec, n_samples, endpoint=False)
    saw = 2.0 * (t * freq - np.floor(t * freq + 0.5))
    sq = np.sign(np.sin(2 * np.pi * freq * t))
    wave_b = 0.6 * saw + 0.4 * sq

    start_f = 2600.0 if is_pop else 1600.0
    end_f = 180.0
    f_env = end_f + (start_f - end_f) * np.exp(-t * (24.0 if is_pop else 18.0))
    mod = np.sin(2 * np.pi * np.cumsum(f_env) / SR)
    amp = np.exp(-t * (18.0 if is_pop else 11.0))
    bass = (wave_b * 0.65 + mod * 0.35) * amp
    return bass * (0.88 if is_pop else 0.95)

BAR_CHORDS = [
    'Em', 'A', 'Em', 'D', 'Em', 'A', 'Em', 'D',
    'D', 'Bm', 'Em', 'A', 'F', 'Dm', 'Gm', 'A',
    'G', 'D', 'G', 'D', 'Gm', 'C', 'F', 'A',
    'Em', 'A', 'Em', 'D', 'Em', 'A', 'Em', 'D',
    # Extra bar 32 (loops back to bar 0 chord)
    'Em'
]

BASS_ROOTS = {
    'D': ('D2', 'D3'),
    'Bm': ('B1', 'B2'),
    'Em': ('E2', 'E3'),
    'A': ('A1', 'A2'),
    'F': ('F2', 'F3'),
    'Dm': ('D2', 'D3'),
    'Gm': ('G1', 'G2'),
    'C': ('C2', 'C3'),
    'G': ('G1', 'G2')
}

def synth_offbeat_bass(freq, dur_sec):
    n_samples = int(dur_sec * SR)
    t = np.linspace(0, dur_sec, n_samples, endpoint=False)
    saw = 2.0 * (t * freq - np.floor(t * freq + 0.5))
    sub = np.sin(2 * np.pi * (freq * 0.5) * t)
    wave_out = saw * 0.7 + sub * 0.3
    b, a = signal.butter(2, 850 / (SR/2), btype='low')
    filtered = signal.lfilter(b, a, wave_out)
    env = np.exp(-t * 8.0)
    return filtered * env * 0.65

print("Synthesizing Brazilian Boogie Slap Bass & Driving Synth Bass...")
for bar_idx in range(RENDER_BARS):
    chord = BAR_CHORDS[bar_idx]
    r_low, r_high = BASS_ROOTS[chord]
    pattern = [
        (0, r_low, False, 1.8),
        (2, r_high, True, 1.2),
        (4, r_low, False, 1.6),
        (6, r_low, False, 1.2),
        (8, r_low, False, 1.8),
        (10, r_high, True, 1.3),
        (12, r_low, False, 1.6),
        (14, r_high, True, 1.4)
    ]
    for s_step, note, is_pop, dur_mult in pattern:
        t_sec = (bar_idx * 4 * BEAT) + (s_step * SIXTEENTH)
        dur = SIXTEENTH * dur_mult
        freq = note_freq(note)
        b_sample = synth_slap_bass(freq, dur, is_pop)
        t_start = int(t_sec * SR)
        mix_into(left, b_sample, t_start, 0.72)
        mix_into(right, b_sample, t_start, 0.72)

    # Driving offbeat Eurobeat/Boogie synth bass on 8th offbeats (2, 6, 10, 14)
    for s_step in [2, 6, 10, 14]:
        t_sec = (bar_idx * 4 * BEAT) + (s_step * SIXTEENTH)
        dur = SIXTEENTH * 1.95
        freq = note_freq(r_low)
        ob_sample = synth_offbeat_bass(freq, dur)
        t_start = int(t_sec * SR)
        mix_into(left, ob_sample, t_start, 0.68)
        mix_into(right, ob_sample, t_start, 0.68)

# ---------------------------------------------------------------------------
# Lush Analog Strings & Synth Pad
# ---------------------------------------------------------------------------
CHORD_VOICINGS = {
    'D': ['D4', 'F#4', 'A4', 'D5'],
    'Bm': ['B3', 'D4', 'F#4', 'B4'],
    'Em': ['E4', 'G4', 'B4', 'E5'],
    'A': ['A3', 'C#4', 'E4', 'A4'],
    'F': ['F3', 'A3', 'C4', 'F4'],
    'Dm': ['D4', 'F4', 'A4', 'D5'],
    'Gm': ['G3', 'Bb3', 'D4', 'G4'],
    'C': ['C4', 'E4', 'G4', 'C5'],
    'G': ['G3', 'B3', 'D4', 'G4']
}

def synth_pad_chord(freqs, dur_sec):
    n_samples = int(dur_sec * SR)
    t = np.linspace(0, dur_sec, n_samples, endpoint=False)
    pad = np.zeros(n_samples, dtype=np.float64)
    for f in freqs:
        s1 = 2.0 * (t * f * 0.997 - np.floor(t * f * 0.997 + 0.5))
        s2 = 2.0 * (t * f * 1.003 - np.floor(t * f * 1.003 + 0.5))
        sub = np.sin(2 * np.pi * (f * 0.5) * t) * 0.3
        pad += (s1 + s2 + sub) * 0.4
    pad /= len(freqs)
    # Continuous legato sustain across the entire bar
    att = int(0.015 * SR)
    rel = int(0.015 * SR)
    env = np.ones(n_samples)
    if n_samples > att:
        env[:att] = np.linspace(0.85, 1.0, att)
    if n_samples > rel:
        env[-rel:] = np.linspace(1.0, 0.85, rel)
    b, a = signal.butter(2, [280 / (SR/2), 3600 / (SR/2)], btype='band')
    return signal.lfilter(b, a, pad) * env * 0.42

print("Synthesizing Warm Analog Pad Layer...")
for bar_idx in range(RENDER_BARS):
    chord = BAR_CHORDS[bar_idx]
    freqs = [note_freq(n) for n in CHORD_VOICINGS[chord]]
    t_sec = bar_idx * 4 * BEAT
    dur = 4 * BEAT
    pad_sample = synth_pad_chord(freqs, dur)
    t_start = int(t_sec * SR)
    mix_into(left, pad_sample, t_start, 0.52)
    mix_into(right, pad_sample, t_start, 0.52)

# ---------------------------------------------------------------------------
# Funky Brass Section
# ---------------------------------------------------------------------------
def synth_brass_stab(freqs, dur_sec):
    n_samples = int(dur_sec * SR)
    t = np.linspace(0, dur_sec, n_samples, endpoint=False)
    chord_wave = np.zeros(n_samples, dtype=np.float64)
    for f in freqs:
        saw1 = 2.0 * (t * f - np.floor(t * f + 0.5))
        saw2 = 2.0 * (t * (f * 1.005) - np.floor(t * (f * 1.005) + 0.5))
        chord_wave += (saw1 + saw2) * 0.5
    chord_wave /= len(freqs)
    env = np.clip(t / 0.012, 0, 1) * np.exp(-t * 8.5)
    b, a = signal.butter(2, [500 / (SR/2), 3600 / (SR/2)], btype='band')
    filtered = signal.lfilter(b, a, chord_wave)
    return filtered * env * 0.72

print("Synthesizing Funky Horns & Brass Stabs...")
for bar_idx in range(RENDER_BARS):
    chord = BAR_CHORDS[bar_idx]
    freqs = [note_freq(n) for n in CHORD_VOICINGS[chord]]
    for s_step in [2, 6, 12]:
        t_sec = (bar_idx * 4 * BEAT) + (s_step * SIXTEENTH)
        dur = SIXTEENTH * 2.2
        stab = synth_brass_stab(freqs, dur)
        t_start = int(t_sec * SR)
        mix_into(left, stab, t_start, 0.55)
        mix_into(right, stab, t_start, 0.42)

# ---------------------------------------------------------------------------
# Funky Clavinet Comping
# ---------------------------------------------------------------------------
def synth_clavinet_note(freq, dur_sec):
    n_samples = int(dur_sec * SR)
    t = np.linspace(0, dur_sec, n_samples, endpoint=False)
    pulse = np.where((t * freq) % 1.0 < 0.22, 1.0, -1.0)
    env = np.exp(-t * 22.0)
    b, a = signal.butter(2, [700 / (SR/2), 4200 / (SR/2)], btype='band')
    return signal.lfilter(b, a, pulse) * env * 0.35

print("Synthesizing Clavinet Comping...")
for bar_idx in range(RENDER_BARS):
    chord = BAR_CHORDS[bar_idx]
    voicing = CHORD_VOICINGS[chord]
    for s_step in [0, 3, 6, 8, 11, 14]:
        t_sec = (bar_idx * 4 * BEAT) + (s_step * SIXTEENTH)
        dur = SIXTEENTH * 1.5
        t_start = int(t_sec * SR)
        for n in voicing[1:]:
            sample = synth_clavinet_note(note_freq(n), dur)
            mix_into(left, sample, t_start, 0.28)
            mix_into(right, sample, t_start, 0.34)

# ---------------------------------------------------------------------------
# Lead Synth: The Core "Lança Perfume" Melody (Stereo Supersaw)
# ---------------------------------------------------------------------------
def synth_lead(freq, dur_sec, pan=0.0):
    n_samples = int(dur_sec * SR)
    t = np.linspace(0, dur_sec, n_samples, endpoint=False)
    saws = np.zeros(n_samples, dtype=np.float64)
    detunes = [-0.012, -0.005, 0.0, 0.005, 0.012]
    vib_depth = np.clip((t - 0.1) * 0.025, 0, 0.024)
    vib = np.sin(2 * np.pi * 6.2 * t) * vib_depth

    for d in detunes:
        f = freq * (1.0 + d + vib)
        saws += 2.0 * (t * f - np.floor(t * f + 0.5))
    saws /= len(detunes)

    attack = int(0.015 * SR)
    decay = int(0.03 * SR)
    env = np.ones(n_samples)
    if n_samples > attack:
        env[:attack] = np.linspace(0, 1, attack)
    if n_samples > decay:
        env[-decay:] = np.linspace(1, 0, decay)

    b, a = signal.butter(2, [350 / (SR/2), 8500 / (SR/2)], btype='band')
    sig_out = signal.lfilter(b, a, saws) * env * 0.74

    p_l = np.sqrt(0.5 * (1.0 - pan))
    p_r = np.sqrt(0.5 * (1.0 + pan))
    return sig_out * p_l, sig_out * p_r

# PART 1: The Iconic "Lança... Lança Perfume!" Hook (8 bars = 128 steps)
MELODY_HOOK_A = [
    (0, 'F#5', 6), (6, 'E5', 6),
    (16, 'F#5', 2), (18, 'E5', 2), (20, 'D5', 2), (22, 'B4', 3), (26, 'D5', 6),
    (32, 'A4', 2), (34, 'B4', 2), (36, 'D5', 2), (38, 'E5', 2), (40, 'F#5', 4), (44, 'E5', 4),
    (48, 'F#5', 2), (50, 'E5', 2), (52, 'D5', 2), (54, 'B4', 3), (58, 'D5', 6),
    (64, 'A5', 4), (68, 'G5', 2), (70, 'F#5', 2), (72, 'E5', 2), (74, 'F#5', 2), (76, 'G5', 4),
    (80, 'F#5', 3), (83, 'E5', 3), (86, 'D5', 3), (90, 'B4', 3), (94, 'D5', 6),
    (96, 'A4', 2), (98, 'B4', 2), (100, 'D5', 2), (102, 'E5', 2), (104, 'F#5', 4), (108, 'E5', 4),
    (112, 'F#5', 2), (114, 'E5', 2), (116, 'D5', 2), (118, 'B4', 2), (120, 'D5', 4), (124, 'E5', 4)
]

# PART 2: The Verse Melody ("Lança Menina, Desbaratina") (8 bars = 128 steps)
MELODY_VERSE = [
    (0, 'F#5', 2), (2, 'F#5', 2), (4, 'E5', 2), (6, 'D5', 2),
    (8, 'F#5', 2), (10, 'F#5', 2), (12, 'E5', 2), (14, 'D5', 2),
    (16, 'E5', 3), (20, 'F#5', 5), (26, 'D5', 6),
    (32, 'F#5', 2), (34, 'F#5', 2), (36, 'E5', 2), (38, 'D5', 2),
    (40, 'F#5', 2), (42, 'F#5', 2), (44, 'E5', 2), (46, 'D5', 2),
    (48, 'B4', 3), (52, 'D5', 5), (58, 'E5', 6),
    (64, 'A5', 2), (66, 'A5', 2), (68, 'G5', 2), (70, 'F5', 2),
    (72, 'A5', 2), (74, 'A5', 2), (76, 'G5', 2), (78, 'F5', 2),
    (80, 'G5', 3), (84, 'A5', 5), (90, 'F5', 6),
    (96, 'Bb5', 2), (98, 'Bb5', 2), (100, 'A5', 2), (102, 'G5', 2),
    (104, 'Bb5', 2), (106, 'A5', 2), (108, 'G5', 4),
    (112, 'F5', 2), (114, 'G5', 2), (116, 'A5', 2), (118, 'B5', 2), (120, 'C#6', 4), (124, 'D6', 4)
]

# PART 3: The Bridge ("Me aqueça / De ponta cabeça") (8 bars = 128 steps)
MELODY_BRIDGE = [
    (0, 'B5', 3), (4, 'A5', 3), (8, 'G5', 3), (12, 'F#5', 3),
    (16, 'D5', 2), (18, 'E5', 2), (20, 'F#5', 3), (24, 'G5', 3), (28, 'F#5', 4),
    (32, 'B5', 3), (36, 'A5', 3), (40, 'G5', 3), (44, 'F#5', 3),
    (48, 'D5', 2), (50, 'E5', 2), (52, 'F#5', 4), (58, 'A5', 6),
    (64, 'Bb5', 3), (68, 'A5', 3), (72, 'G5', 3), (76, 'F5', 3),
    (80, 'D5', 2), (82, 'F5', 2), (84, 'G5', 4), (90, 'A5', 6),
    (96, 'Bb5', 3), (100, 'A5', 3), (104, 'G5', 3), (108, 'E5', 3),
    (112, 'F#5', 2), (114, 'G5', 2), (116, 'A5', 2), (118, 'B5', 2), (120, 'C#6', 4), (124, 'E6', 4)
]

# PART 4: The Climax Anthemic Return (8 bars = 128 steps) + Extra bar 32 pickup
MELODY_CLIMAX = [
    (0, 'F#6', 6), (6, 'E6', 6),
    (16, 'F#6', 2), (18, 'E6', 2), (20, 'D6', 2), (22, 'B5', 3), (26, 'D6', 6),
    (32, 'A5', 2), (34, 'B5', 2), (36, 'D6', 2), (38, 'E6', 2), (40, 'F#6', 4), (44, 'E6', 4),
    (48, 'F#6', 2), (50, 'E6', 2), (52, 'D6', 2), (54, 'B5', 3), (58, 'D6', 6),
    (64, 'A6', 4), (68, 'G6', 2), (70, 'F#6', 2), (72, 'E6', 2), (74, 'F#6', 2), (76, 'G6', 4),
    (80, 'F#6', 3), (83, 'E6', 3), (86, 'D6', 3), (90, 'B5', 3), (94, 'D6', 6),
    (96, 'A5', 2), (98, 'B5', 2), (100, 'D6', 2), (102, 'E6', 2), (104, 'F#6', 4), (108, 'E6', 4),
    # Bar 31 (steps 112-127): Smooth resolve into the next loop
    (112, 'F#6', 2), (114, 'E6', 2), (116, 'D6', 2), (118, 'B5', 2), (120, 'A5', 2), (122, 'B5', 2), (124, 'D6', 4),
    # Bar 32 (Pre-roll: Bar 0 of next loop)
    (128, 'F#6', 6), (134, 'E6', 6)
]

print("Synthesizing Lança Perfume Lead Melody across all 32 bars...")
def place_melody(phrase, bar_offset, pan=0.0):
    for step, note, dur_steps in phrase:
        t_sec = (bar_offset * 4 * BEAT) + (step * SIXTEENTH)
        dur_sec = dur_steps * SIXTEENTH * 0.95
        freq = note_freq(note)
        s_l, s_r = synth_lead(freq, dur_sec, pan)
        t_start = int(t_sec * SR)
        mix_into(left, s_l, t_start, 1.0)
        mix_into(right, s_r, t_start, 1.0)

        echo_delay = int(3 * SIXTEENTH * SR)
        mix_into(left, s_r, t_start + echo_delay, 0.28)
        mix_into(right, s_l, t_start + echo_delay, 0.28)

place_melody(MELODY_HOOK_A, 0, pan=-0.15)
place_melody(MELODY_VERSE, 8, pan=0.15)
place_melody(MELODY_BRIDGE, 16, pan=-0.2)
place_melody(MELODY_CLIMAX, 24, pan=0.2)

# ---------------------------------------------------------------------------
# Sparkling Arpeggiator
# ---------------------------------------------------------------------------
def synth_arp_note(freq, dur_sec):
    n_samples = int(dur_sec * SR)
    t = np.linspace(0, dur_sec, n_samples, endpoint=False)
    wave_a = 0.55 * np.sin(2 * np.pi * freq * t) + 0.45 * (2.0 * (t * freq - np.floor(t * freq + 0.5)))
    env = np.exp(-t * 28.0)
    return wave_a * env * 0.2

ARP_CHORDS = {
    'D': ['D4', 'F#4', 'A4', 'D5', 'F#5', 'D5', 'A4', 'F#4'],
    'Bm': ['B3', 'D4', 'F#4', 'B4', 'D5', 'B4', 'F#4', 'D4'],
    'Em': ['E4', 'G4', 'B4', 'E5', 'G5', 'E5', 'B4', 'G4'],
    'A': ['A3', 'C#4', 'E4', 'A4', 'C#5', 'A4', 'E4', 'C#4'],
    'F': ['F3', 'A3', 'C4', 'F4', 'A4', 'F4', 'C4', 'A3'],
    'Dm': ['D4', 'F4', 'A4', 'D5', 'F5', 'D5', 'A4', 'F4'],
    'Gm': ['G3', 'Bb3', 'D4', 'G4', 'Bb4', 'G4', 'D4', 'Bb3'],
    'C': ['C4', 'E4', 'G4', 'C5', 'E5', 'C5', 'G4', 'E4'],
    'G': ['G3', 'B3', 'D4', 'G4', 'B4', 'G4', 'D4', 'B3']
}

print("Synthesizing Sparkling Arpeggios...")
for bar_idx in range(RENDER_BARS):
    chord = BAR_CHORDS[bar_idx]
    notes = ARP_CHORDS[chord]
    for s_step in range(16):
        note = notes[s_step % len(notes)]
        t_sec = (bar_idx * 4 * BEAT) + (s_step * SIXTEENTH)
        dur = SIXTEENTH * 0.82
        sample = synth_arp_note(note_freq(note), dur)
        t_start = int(t_sec * SR)
        pan = np.sin(s_step * np.pi / 4.0) * 0.55
        p_l = np.sqrt(0.5 * (1.0 - pan))
        p_r = np.sqrt(0.5 * (1.0 + pan))
        mix_into(left, sample, t_start, p_l)
        mix_into(right, sample, t_start, p_r)

# ---------------------------------------------------------------------------
# Seamless Pre-roll Loop Seam Treatment
# ---------------------------------------------------------------------------
print("Performing Seamless Pre-roll Seam Crossfade...")
ramp = np.linspace(0.0, 1.0, FADE_SAMPLES)
out_left = left[:TOTAL_SAMPLES].copy()
out_left[:FADE_SAMPLES] = left[TOTAL_SAMPLES:TOTAL_SAMPLES + FADE_SAMPLES] * (1.0 - ramp) + left[:FADE_SAMPLES] * ramp

out_right = right[:TOTAL_SAMPLES].copy()
out_right[:FADE_SAMPLES] = right[TOTAL_SAMPLES:TOTAL_SAMPLES + FADE_SAMPLES] * (1.0 - ramp) + right[:FADE_SAMPLES] * ramp

# ---------------------------------------------------------------------------
# Closed-Loop Mastering & Normalization
# Target Headroom: 0.88 (-1.1 dBFS), mono compatibility <= 1.0
# ---------------------------------------------------------------------------
print("Mastering & Normalizing to -1 dBFS target headroom...")
peak = max(np.max(np.abs(out_left)), np.max(np.abs(out_right)))
if peak > 0.01:
    out_left = np.tanh(out_left / peak * 1.32)
    out_right = np.tanh(out_right / peak * 1.32)
    max_mastered = max(np.max(np.abs(out_left)), np.max(np.abs(out_right)))
    out_left = (out_left / max_mastered) * 0.875
    out_right = (out_right / max_mastered) * 0.875

stereo = np.empty((TOTAL_SAMPLES, 2), dtype=np.float32)
stereo[:, 0] = out_left.astype(np.float32)
stereo[:, 1] = out_right.astype(np.float32)

raw_wav = "/tmp/lanca_bgm_raw.wav"
out_mp3 = sys.argv[1] if len(sys.argv) > 1 else "/tmp/lanca_bgm_test.mp3"

print(f"Writing temporary PCM WAV to {raw_wav}...")
scipy.io.wavfile.write(raw_wav, SR, stereo)

print(f"Encoding to MP3 via ffmpeg V0: {out_mp3}...")
cmd = [
    "ffmpeg", "-y", "-i", raw_wav,
    "-codec:a", "libmp3lame", "-q:a", "0",
    out_mp3
]
subprocess.run(cmd, check=True)
if os.path.exists(raw_wav):
    os.remove(raw_wav)

print(f"Done! Created {out_mp3}")

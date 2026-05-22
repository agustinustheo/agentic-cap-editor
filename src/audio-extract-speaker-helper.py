from __future__ import annotations

import argparse
import json
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from clearvoice import ClearVoice


def mono16k(path: Path) -> np.ndarray:
    audio, sr = sf.read(path)
    if audio.ndim > 1:
        audio = np.mean(audio, axis=1)
    if sr != 16000:
        audio = librosa.resample(audio, orig_sr=sr, target_sr=16000)
    return audio.astype(np.float32)


def voice_score(audio: np.ndarray, sr: int = 16000) -> dict[str, float]:
    signal = np.asarray(audio, dtype=np.float32)
    if signal.ndim != 1:
        signal = signal.reshape(-1)
    signal = np.nan_to_num(signal)
    rms = float(np.sqrt(np.mean(np.square(signal)) + 1e-12))
    stft = librosa.stft(signal, n_fft=1024, hop_length=256)
    power = np.abs(stft) ** 2
    freqs = librosa.fft_frequencies(sr=sr, n_fft=1024)
    voice_band = (freqs >= 120) & (freqs <= 4200)
    low_band = freqs < 120
    high_band = freqs > 4200
    voice_power = float(np.sum(power[voice_band]) + 1e-12)
    low_power = float(np.sum(power[low_band]) + 1e-12)
    high_power = float(np.sum(power[high_band]) + 1e-12)
    total_power = float(np.sum(power) + 1e-12)
    centroid = float(librosa.feature.spectral_centroid(S=np.abs(stft), sr=sr).mean())
    flatness = float(librosa.feature.spectral_flatness(S=np.abs(stft) + 1e-12).mean())
    zcr = float(librosa.feature.zero_crossing_rate(signal, frame_length=1024, hop_length=256).mean())
    score = (
        voice_power / total_power * 4.0
        + voice_power / (low_power + high_power) * 1.5
        + rms * 4.0
        - flatness * 1.5
        - abs(centroid - 1800.0) / 4000.0
        - zcr * 0.5
    )
    return {
        "score": float(score),
        "rms": rms,
        "voicePowerRatio": float(voice_power / total_power),
        "voiceVsRestRatio": float(voice_power / (low_power + high_power)),
        "spectralCentroid": centroid,
        "spectralFlatness": flatness,
        "zeroCrossingRate": zcr,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--meta-out", required=True)
    parser.add_argument("--model", default="MossFormer2_SS_16K")
    parser.add_argument("--keep-stem", choices=["auto", "1", "2"], default="auto")
    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)
    meta_out = Path(args.meta_out)

    model = ClearVoice(task="speech_separation", model_names=[args.model])
    audio = mono16k(input_path)
    batch = np.expand_dims(audio, axis=0)
    separated = model(batch, False)

    stem1 = np.asarray(separated[0, 0, :], dtype=np.float32)
    stem2 = np.asarray(separated[1, 0, :], dtype=np.float32)
    score1 = voice_score(stem1)
    score2 = voice_score(stem2)

    chosen_index = 0
    decision = "auto"
    if args.keep_stem == "1":
        chosen_index = 0
        decision = "forced-1"
    elif args.keep_stem == "2":
        chosen_index = 1
        decision = "forced-2"
    else:
        chosen_index = 0 if score1["score"] >= score2["score"] else 1

    chosen = stem1 if chosen_index == 0 else stem2
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(output_path, chosen, 16000)

    meta = {
        "model": args.model,
        "keepStem": args.keep_stem,
        "decision": decision,
        "chosenStem": chosen_index + 1,
        "stemScores": {
            "1": score1,
            "2": score2,
        },
    }
    meta_out.parent.mkdir(parents=True, exist_ok=True)
    meta_out.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()

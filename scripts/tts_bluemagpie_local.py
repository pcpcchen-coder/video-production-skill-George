#!/usr/bin/env python3
"""Local BlueMagpie-TTS bridge for slide narration projects.

Reads project config.json + narration.json, synthesizes each narration entry with a
single BlueMagpie speaker centroid, and writes audio/slide_XX.mp3 files.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_DIR = SCRIPT_DIR.parent
DEFAULT_BLUEMAGPIE_DIR = (REPO_DIR / ".." / ".." / "external" / "BlueMagpie-TTS").resolve()


def maybe_reexec_in_bluemagpie_venv(bluemagpie_dir: Path) -> None:
    venv_python = bluemagpie_dir / ".venv" / "bin" / "python"
    if venv_python.exists() and Path(sys.executable).resolve() != venv_python.resolve():
        os.execv(str(venv_python), [str(venv_python), *sys.argv])


def load_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def han_len(text: str) -> int:
    return len(re.findall(r"[\u3400-\u9fff]", text))


def clean_tts_text(text: str) -> str:
    text = re.sub(r"[。！？，；、：「」『』（）《》〈〉【】〔〕｛｝…—–‐~～]", " ", text)
    text = re.sub(r"""[.,!?;:"'(){}\[\]‐\-―‘-‟…]""", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def split_with_delimiters(text: str, delimiters: set[str]) -> list[str]:
    out: list[str] = []
    cur: list[str] = []
    for ch in text:
        cur.append(ch)
        if ch in delimiters:
            segment = "".join(cur).strip()
            if segment:
                out.append(segment)
            cur = []
    rest = "".join(cur).strip()
    if rest:
        out.append(rest)
    return out


def pack_units(units: list[str], max_han: int) -> list[str]:
    packed: list[str] = []
    cur = ""
    for unit in units:
        candidate = cur + unit if cur else unit
        if cur and han_len(candidate) > max_han:
            packed.append(cur)
            cur = unit
        else:
            cur = candidate
    if cur:
        packed.append(cur)
    return packed


def split_breath_segments(text: str, max_han: int) -> list[str]:
    sentence_delims = set("。！？")
    weak_delims = set("，、；：…—–")
    sentences = split_with_delimiters(text, sentence_delims)
    segments: list[str] = []
    for sentence in sentences:
        if han_len(sentence) <= max_han:
            segments.append(sentence)
        else:
            segments.extend(pack_units(split_with_delimiters(sentence, weak_delims), max_han))
    return [re.sub(r"\s+", " ", s).strip() for s in segments if s.strip()]


def ffmpeg_concat(parts: list[Path], output_path: Path, ffmpeg: str) -> None:
    list_path = output_path.with_suffix(".concat.txt")
    list_path.write_text(
        "\n".join(f"file '{str(p).replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}'" for p in parts),
        encoding="utf-8",
    )
    subprocess.run(
        [
            ffmpeg,
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(list_path),
            "-ar",
            "44100",
            "-ac",
            "1",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "160k",
            str(output_path),
        ],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    list_path.unlink(missing_ok=True)


def load_speaker_centroid(model_dir: Path, bluemagpie_dir: Path, tts_config: dict, speaker: str):
    import torch

    explicit_path = tts_config.get("blueMagpieSpeakerPath")
    if explicit_path:
        centroid_path = Path(explicit_path).expanduser()
        if not centroid_path.is_absolute():
            centroid_path = (bluemagpie_dir / centroid_path).resolve()
        return torch.load(centroid_path, map_location="cpu", weights_only=True), f"file:{centroid_path}"

    table = torch.load(model_dir / "checkpoints" / "speaker_centroids.pt", map_location="cpu", weights_only=True)
    if speaker in table["speaker_ids"]:
        return table["centroids"][table["speaker_ids"].index(speaker)], f"built-in:{speaker}"

    speaker_dir = Path(tts_config.get("blueMagpieSpeakerDir") or (bluemagpie_dir / "speaker_centroids")).expanduser()
    if not speaker_dir.is_absolute():
        speaker_dir = (bluemagpie_dir / speaker_dir).resolve()
    custom_path = speaker_dir / f"{speaker}.pt"
    if custom_path.exists():
        return torch.load(custom_path, map_location="cpu", weights_only=True), f"file:{custom_path}"

    available = [*table["speaker_ids"]]
    if speaker_dir.exists():
        available.extend(sorted(p.stem for p in speaker_dir.glob("*.pt")))
    raise ValueError(f"Unknown BlueMagpie speaker {speaker!r}; available: {available}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate local BlueMagpie narration audio.")
    parser.add_argument("project_dir", nargs="?", default=".", help="Project directory with narration.json")
    parser.add_argument("--only", help="Comma-separated 1-based slide numbers to regenerate")
    args = parser.parse_args()

    project_dir = Path(args.project_dir).resolve()
    config = load_json(project_dir / "config.json", {})
    tts_config = config.get("tts", {})
    bluemagpie_dir = Path(
        tts_config.get("blueMagpieDir") or os.environ.get("BLUEMAGPIE_TTS_DIR") or DEFAULT_BLUEMAGPIE_DIR
    ).expanduser().resolve()

    maybe_reexec_in_bluemagpie_venv(bluemagpie_dir)

    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

    import torch
    import soundfile as sf
    from huggingface_hub import snapshot_download
    from transformers import PreTrainedTokenizerFast
    from bluemagpie import BlueMagpieModel

    narration_path = project_dir / "narration.json"
    if not narration_path.exists():
        raise FileNotFoundError(f"narration.json not found in {project_dir}")
    narration = load_json(narration_path, [])

    audio_dir = project_dir / "audio"
    tmp_dir = audio_dir / ".bluemagpie_parts"
    audio_dir.mkdir(parents=True, exist_ok=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)

    only = None
    if args.only:
        only = {int(x) for x in re.split(r"\s*,\s*", args.only.strip()) if x}

    model_dir = Path(tts_config.get("blueMagpieModelDir") or snapshot_download("OpenFormosa/BlueMagpie-TTS"))
    tokenizer = PreTrainedTokenizerFast(tokenizer_file=str(model_dir / "tokenizer.json"))

    configured_device = tts_config.get("blueMagpieDevice")
    if configured_device and configured_device != "auto":
        device = configured_device
    else:
        device = "cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu")

    model = BlueMagpieModel.from_local(str(model_dir), tokenizer=tokenizer, training=False, device=device)
    speaker = tts_config.get("blueMagpieSpeaker", "George_Chen")
    cfg_value = float(tts_config.get("blueMagpieCfg", 2.0))
    max_han = int(tts_config.get("blueMagpieMaxHan", tts_config.get("breathSegmentMaxHan", 30)))
    strip_punct = tts_config.get("stripPunctuation", True) is not False
    ffmpeg = config.get("ffmpeg") or os.environ.get("FFMPEG_PATH") or "ffmpeg"

    centroid, speaker_source = load_speaker_centroid(model_dir, bluemagpie_dir, tts_config, speaker)

    print(f"Project: {project_dir}")
    print(
        f"Slides: {len(narration)} | Provider: BlueMagpie local | "
        f"Speaker: {speaker} ({speaker_source}) | Device: {device}"
    )
    print("---")

    for idx, text in enumerate(narration, start=1):
        if only and idx not in only:
            continue
        num = f"{idx:02d}"
        out_path = audio_dir / f"slide_{num}.mp3"
        segments = split_breath_segments(text, max_han)
        if not segments:
            raise ValueError(f"Slide {num} has no synthesizable text")

        part_paths: list[Path] = []
        print(f"[{num}/{len(narration):02d}] Synthesizing {len(segments)} segment(s)...")
        for seg_idx, segment in enumerate(segments, start=1):
            tts_text = clean_tts_text(segment) if strip_punct else segment
            wav_path = tmp_dir / f"slide_{num}_seg_{seg_idx:02d}.wav"
            audio = model.generate(target_text=tts_text, speaker_centroid=centroid, cfg_value=cfg_value)
            sf.write(wav_path, audio.squeeze().cpu().numpy(), model.sample_rate)
            part_paths.append(wav_path)

        ffmpeg_concat(part_paths, out_path, ffmpeg)
        for part_path in part_paths:
            part_path.unlink(missing_ok=True)
        print(f"  Wrote {out_path.relative_to(project_dir)} ({out_path.stat().st_size // 1024} KB)")

    try:
        tmp_dir.rmdir()
    except OSError:
        pass
    print("\nDone! Local BlueMagpie audio written to audio/slide_XX.mp3")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

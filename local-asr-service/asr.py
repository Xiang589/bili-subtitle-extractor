from __future__ import annotations

import os
from pathlib import Path
from typing import Any

_MODEL = None


def env_flag(name: str, default: str = "0") -> bool:
    return str(os.getenv(name, default)).strip().lower() in {"1", "true", "yes", "on"}


def get_asr_settings() -> dict[str, Any]:
    return {
        "mock": env_flag("ASR_MOCK"),
        "model": os.getenv("ASR_MODEL", "base"),
        "device": os.getenv("ASR_DEVICE", "cpu"),
        "compute_type": os.getenv("ASR_COMPUTE_TYPE", "int8"),
    }


def mock_segments() -> list[dict[str, Any]]:
    return [
        {"from": 0.0, "to": 3.5, "content": "这是本地 ASR mock 模式生成的第一条字幕。"},
        {"from": 3.5, "to": 7.2, "content": "扩展录音、上传和下载流程可以在不下载模型的情况下测试。"},
    ]


def load_model():
    global _MODEL
    if _MODEL is not None:
        return _MODEL

    settings = get_asr_settings()
    try:
        from faster_whisper import WhisperModel
    except ImportError as error:
        raise RuntimeError("缺少 faster-whisper，请先安装 requirements.txt。") from error

    _MODEL = WhisperModel(
        settings["model"],
        device=settings["device"],
        compute_type=settings["compute_type"],
    )
    return _MODEL


def transcribe_audio(audio_path: str | Path, language: str = "zh") -> list[dict[str, Any]]:
    settings = get_asr_settings()
    if settings["mock"]:
        return mock_segments()

    model = load_model()
    segments, _info = model.transcribe(
        str(audio_path),
        language=language or None,
        vad_filter=True,
    )

    output = []
    for segment in segments:
        content = str(segment.text or "").strip()
        if not content:
            continue
        output.append(
            {
                "from": float(segment.start),
                "to": float(segment.end),
                "content": content,
            }
        )

    return output

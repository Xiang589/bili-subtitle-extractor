from __future__ import annotations

import json
import re
from typing import Any

SUPPORTED_FORMATS = {"md", "txt", "srt", "json"}


def format_clock_time(seconds: float) -> str:
    total_seconds = max(0, int(float(seconds or 0)))
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    rest_seconds = total_seconds % 60
    return f"{hours:02d}:{minutes:02d}:{rest_seconds:02d}"


def format_srt_time(seconds: float) -> str:
    total_milliseconds = max(0, round(float(seconds or 0) * 1000))
    milliseconds = total_milliseconds % 1000
    total_seconds = total_milliseconds // 1000
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    rest_seconds = total_seconds % 60
    return f"{hours:02d}:{minutes:02d}:{rest_seconds:02d},{milliseconds:03d}"


def safe_filename(name: str) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|]', "_", str(name or ""))
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned[:180] or "bilibili-local-asr"


def normalize_segments(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized = []
    for segment in segments:
        content = str(segment.get("content") or "").strip()
        if not content:
            continue
        normalized.append(
            {
                "from": float(segment.get("from") or 0),
                "to": float(segment.get("to") or 0),
                "content": content,
            }
        )
    return normalized


def build_payload(title: str, url: str, language: str, segments: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "source": "asr",
        "title": title or "Bilibili 本地 ASR",
        "url": url or "",
        "language": language or "zh",
        "segments": normalize_segments(segments),
    }


def to_markdown(payload: dict[str, Any]) -> str:
    lines = [
        f"# {payload['title']}",
        "",
        "- 来源：Bilibili",
        "- 方式：本地 ASR",
        f"- 原始链接：{payload['url']}",
        f"- 语言：{payload['language']}",
        "",
        "## 字幕正文",
        "",
    ]

    for segment in payload["segments"]:
        lines.append(
            f"- [{format_clock_time(segment['from'])} - {format_clock_time(segment['to'])}] {segment['content']}"
        )

    return "\n".join(lines) + "\n"


def to_txt(payload: dict[str, Any]) -> str:
    return "\n".join(segment["content"] for segment in payload["segments"]) + "\n"


def to_srt(payload: dict[str, Any]) -> str:
    blocks = []
    for index, segment in enumerate(payload["segments"], start=1):
        blocks.append(
            "\n".join(
                [
                    str(index),
                    f"{format_srt_time(segment['from'])} --> {format_srt_time(segment['to'])}",
                    segment["content"],
                ]
            )
        )
    return "\n\n".join(blocks) + "\n"


def to_json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def export_transcript(payload: dict[str, Any], output_format: str) -> dict[str, str]:
    normalized_format = str(output_format or "md").lower().lstrip(".")
    if normalized_format not in SUPPORTED_FORMATS:
        raise ValueError(f"不支持的导出格式：{output_format}")

    exporters = {
        "md": to_markdown,
        "txt": to_txt,
        "srt": to_srt,
        "json": to_json,
    }
    content = exporters[normalized_format](payload)
    filename = f"{safe_filename(payload['title'])}_local_asr.{normalized_format}"

    return {
        "filename": filename,
        "content": content,
        "format": normalized_format,
    }

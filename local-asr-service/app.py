from __future__ import annotations

import argparse
import os
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from asr import env_flag, get_asr_settings, transcribe_audio
from export import SUPPORTED_FORMATS, build_payload, export_transcript

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = Path(os.getenv("ASR_UPLOAD_DIR", BASE_DIR / "tmp" / "uploads"))

app = FastAPI(title="bili-subtitle-extractor local ASR service", version="0.2-alpha")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1", "http://localhost"],
    allow_origin_regex=r"^chrome-extension://.*$",
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    settings = get_asr_settings()
    return {
        "ok": True,
        "service": "bili-subtitle-extractor-local-asr",
        "mock": settings["mock"],
        "model": settings["model"],
        "device": settings["device"],
        "compute_type": settings["compute_type"],
    }


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    source_url: str = Form(""),
    title: str = Form("Bilibili 本地 ASR"),
    format: str = Form("md"),
    language: str = Form("zh"),
):
    output_format = normalize_format(format)
    audio_path = await save_upload(file)

    try:
        segments = transcribe_audio(audio_path, language=language or "zh")
        payload = build_payload(title=title, url=source_url, language=language or "zh", segments=segments)
        exported = export_transcript(payload, output_format)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error
    finally:
        if not env_flag("ASR_KEEP_FILES"):
            audio_path.unlink(missing_ok=True)

    return {
        "segments": payload["segments"],
        "filename": exported["filename"],
        "content": exported["content"],
        "format": exported["format"],
    }


def normalize_format(format_name: str) -> str:
    output_format = str(format_name or "md").lower().lstrip(".")
    if output_format not in SUPPORTED_FORMATS:
        raise HTTPException(status_code=400, detail=f"不支持的导出格式：{format_name}")
    return output_format


async def save_upload(file: UploadFile) -> Path:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="上传音频为空。")

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    suffix = Path(file.filename or "recording.webm").suffix or ".webm"
    audio_path = UPLOAD_DIR / f"{uuid.uuid4().hex}{suffix}"
    audio_path.write_bytes(data)
    return audio_path


def main():
    parser = argparse.ArgumentParser(description="Run the local ASR service.")
    parser.add_argument("--mock", action="store_true", help="Enable ASR_MOCK=1 without loading faster-whisper.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    if args.mock:
        os.environ["ASR_MOCK"] = "1"

    import uvicorn

    uvicorn.run("app:app", host=args.host, port=args.port, reload=False)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Zero-dependency Python 3.11 stdlib backend for StudyFlow Exam & Concept Studio."""

from __future__ import annotations

import json
import mimetypes
import os
import re
import sys
import tempfile
import threading
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
APP_DIR = ROOT / "app"
PROGRESS_PATH = ROOT / "progress.json"

IGNORED_DIRS = {"app", "graphify-out", "__pycache__", "node_modules"}
RESERVED_SLUGS = IGNORED_DIRS | {"api", "files", "static", "progress"}
SLUG_RE = re.compile(r"^[a-z0-9_-]{1,48}$")
WIN_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *{f"COM{i}" for i in range(1, 10)},
    *{f"LPT{i}" for i in range(1, 10)},
}
INVALID_FILENAME_CHARS = set('<>:"|?*')

ALLOWED_UPLOAD_EXTS = {".pdf", ".md", ".txt", ".json", ".png", ".jpg", ".jpeg", ".webp"}
FORBIDDEN_FILE_NAMES = {"study.json", "graph.json"}

MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MB
MAX_JSON_BYTES = 20 * 1024 * 1024    # 20 MB

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".csv": "text/csv; charset=utf-8",
}

# ponytail: single global lock serializes JSON writes in this local single-user server.
WRITE_LOCK = threading.Lock()


class ApiError(Exception):
    """Structured HTTP API error."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def validate_slug(slug: str) -> str:
    """Validate subject directory slug against strict allowlist."""
    if not isinstance(slug, str) or not SLUG_RE.fullmatch(slug):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Invalid subject id; use 1-48 chars [a-z0-9_-].")
    if slug in RESERVED_SLUGS or slug.startswith((".", "_")):
        raise ApiError(HTTPStatus.BAD_REQUEST, f"Subject id '{slug}' is reserved.")
    return slug


def slugify_name(name: str) -> str:
    """Derive a valid subject slug from a human-readable name."""
    slug = re.sub(r"[^a-z0-9_-]+", "-", name.strip().lower()).strip("-_")[:48]
    if not slug or slug in RESERVED_SLUGS or slug.startswith((".", "_")):
        raise ApiError(
            HTTPStatus.BAD_REQUEST,
            "Could not derive a valid ASCII subject slug; provide an explicit 'id' matching [a-z0-9_-].",
        )
    return slug


def validate_filename(raw_name: str) -> str:
    """Validate a single-segment filename without traversal or control characters."""
    if not isinstance(raw_name, str):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Filename must be a string.")
    name = raw_name.strip()
    if not name or len(name) > 180:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Invalid filename length.")
    if name in {".", ".."} or ".." in name or "/" in name or "\\" in name or "\x00" in name:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Unsafe filename.")
    if any(ord(ch) < 32 or ord(ch) == 127 or ch in INVALID_FILENAME_CHARS for ch in name):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Filename contains invalid characters.")
    if name.endswith((".", " ")):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Filename cannot end with a dot or space.")
    stem = Path(name).stem.upper()
    if stem in WIN_RESERVED_NAMES:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Filename uses a reserved system name.")
    return name


def resolve_subject_dir(subject_id: str) -> Path:
    """Resolve and verify an existing subject directory directly under ROOT."""
    slug = validate_slug(subject_id)
    root_resolved = ROOT.resolve()
    subject_dir = (ROOT / slug).resolve()
    if not subject_dir.is_relative_to(root_resolved) or subject_dir.parent != root_resolved:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Invalid subject path.")
    if not subject_dir.exists() or not subject_dir.is_dir() or subject_dir.is_symlink():
        raise ApiError(HTTPStatus.NOT_FOUND, f"Subject '{slug}' not found.")
    return subject_dir


def resolve_subject_file(subject_dir: Path, filename: str) -> Path:
    """Resolve a single-segment file inside subject_dir and verify containment."""
    safe_name = validate_filename(filename)
    base_resolved = subject_dir.resolve()
    target = (subject_dir / safe_name).resolve()
    if not target.is_relative_to(base_resolved) or target.parent != base_resolved:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Path escapes subject directory.")
    if target.exists() and target.is_symlink():
        raise ApiError(HTTPStatus.FORBIDDEN, "Symlinks are not permitted.")
    return target


def atomic_write_bytes(target: Path, payload: bytes) -> None:
    """Atomically write bytes via a temp file in the same directory + os.replace()."""
    parent = target.parent
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=parent,
            prefix=f".tmp_{target.name}_",
            delete=False,
        ) as tmp:
            tmp_path = Path(tmp.name)
            tmp.write(payload)
            tmp.flush()
            os.fsync(tmp.fileno())
        os.replace(tmp_path, target)
    finally:
        if tmp_path is not None and tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass


def atomic_write_json(target: Path, data: Any) -> None:
    """Serialize JSON cleanly and write atomically."""
    encoded = (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    atomic_write_bytes(target, encoded)


def read_json_safe(path: Path) -> Any | None:
    """Read and parse JSON file if present, returning None when absent."""
    if not path.is_file() or path.is_symlink():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ApiError(HTTPStatus.INTERNAL_SERVER_ERROR, f"Corrupt JSON in {path.name}: {exc}") from exc


def empty_study(subject_id: str, name: str = "", code: str = "", description: str = "") -> dict[str, Any]:
    """Return canonical empty study.json structure."""
    return {
        "id": subject_id,
        "name": name or subject_id,
        "code": code or subject_id.upper(),
        "description": description or "",
        "topics": [],
        "formulas": [],
        "flashcards": [],
        "questions": [],
    }


def normalize_study(subject_id: str, raw: dict[str, Any] | None) -> dict[str, Any]:
    """Ensure study object has all expected fields."""
    base = empty_study(subject_id)
    if not isinstance(raw, dict):
        return base
    return {
        "id": subject_id,
        "name": str(raw.get("name") or base["name"]),
        "code": str(raw.get("code") if raw.get("code") is not None else base["code"]),
        "description": str(raw.get("description") or ""),
        "topics": raw.get("topics") if isinstance(raw.get("topics"), list) else [],
        "formulas": raw.get("formulas") if isinstance(raw.get("formulas"), list) else [],
        "flashcards": raw.get("flashcards") if isinstance(raw.get("flashcards"), list) else [],
        "questions": raw.get("questions") if isinstance(raw.get("questions"), list) else [],
    }


def validate_study_payload(subject_id: str, data: Any) -> dict[str, Any]:
    """Validate PUT /study JSON body."""
    if not isinstance(data, dict):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Study payload must be a JSON object.")
    for key in ("topics", "formulas", "flashcards", "questions"):
        if key not in data or not isinstance(data[key], list):
            raise ApiError(HTTPStatus.BAD_REQUEST, f"Study payload must include list '{key}'.")
    return {
        "id": subject_id,
        "name": str(data.get("name") or subject_id),
        "code": str(data.get("code") if data.get("code") is not None else subject_id.upper()),
        "description": str(data.get("description") or ""),
        "topics": data["topics"],
        "formulas": data["formulas"],
        "flashcards": data["flashcards"],
        "questions": data["questions"],
    }


def count_graph_nodes(subject_dir: Path) -> int:
    """Count nodes in graph.json if present and valid."""
    graph_path = resolve_subject_file(subject_dir, "graph.json")
    if not graph_path.is_file():
        return 0
    try:
        data = json.loads(graph_path.read_text(encoding="utf-8"))
        nodes = data.get("nodes") if isinstance(data, dict) else None
        return len(nodes) if isinstance(nodes, list) else 0
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return 0


def list_subject_files(subject_dir: Path, subject_id: str) -> list[dict[str, Any]]:
    """List user-facing material files inside subject_dir."""
    base_resolved = subject_dir.resolve()
    files: list[dict[str, Any]] = []
    for entry in sorted(subject_dir.iterdir(), key=lambda p: p.name.lower()):
        if entry.name.startswith((".", "_")) or entry.name.lower() in FORBIDDEN_FILE_NAMES:
            continue
        if entry.is_symlink() or not entry.is_file():
            continue
        resolved = entry.resolve()
        if not resolved.is_relative_to(base_resolved) or resolved.parent != base_resolved:
            continue
        ext = entry.suffix.lower()
        files.append({
            "name": entry.name,
            "size": entry.stat().st_size,
            "ext": ext,
            "url": f"/files/{subject_id}/{urllib.parse.quote(entry.name)}",
        })
    return files


def build_subject_summary(subject_dir: Path) -> dict[str, Any]:
    """Construct summary metadata, counts, and files list for a subject."""
    subject_id = subject_dir.name
    study_path = resolve_subject_file(subject_dir, "study.json")
    raw_study: dict[str, Any] | None = None
    if study_path.is_file():
        try:
            parsed = json.loads(study_path.read_text(encoding="utf-8"))
            if isinstance(parsed, dict):
                raw_study = parsed
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            raw_study = None
    study = normalize_study(subject_id, raw_study)
    return {
        "id": subject_id,
        "name": study["name"],
        "code": study["code"],
        "description": study["description"],
        "counts": {
            "topics": len(study["topics"]),
            "questions": len(study["questions"]),
            "formulas": len(study["formulas"]),
            "flashcards": len(study["flashcards"]),
            "graphNodes": count_graph_nodes(subject_dir),
        },
        "files": list_subject_files(subject_dir, subject_id),
    }


def discover_subjects() -> list[dict[str, Any]]:
    """Discover all valid subject directories directly under ROOT."""
    root_resolved = ROOT.resolve()
    summaries: list[dict[str, Any]] = []
    for entry in sorted(ROOT.iterdir(), key=lambda p: p.name.lower()):
        if not entry.is_dir() or entry.is_symlink():
            continue
        if entry.name in IGNORED_DIRS or entry.name.startswith((".", "_")):
            continue
        if not SLUG_RE.fullmatch(entry.name) or entry.name in RESERVED_SLUGS:
            continue
        resolved = entry.resolve()
        if not resolved.is_relative_to(root_resolved) or resolved.parent != root_resolved:
            continue
        summaries.append(build_subject_summary(entry))
    return summaries


def merge_by_id(existing: list[Any], incoming: list[Any], key_name: str) -> list[Any]:
    """Merge lists of dict items by 'id', updating existing matches in place or appending."""
    result = [item for item in existing if isinstance(item, dict)]
    index_by_id: dict[str, int] = {}
    for idx, item in enumerate(result):
        item_id = item.get("id")
        if isinstance(item_id, str) and item_id:
            index_by_id[item_id] = idx

    for item in incoming:
        if not isinstance(item, dict):
            raise ApiError(HTTPStatus.BAD_REQUEST, f"Each item in '{key_name}' must be a JSON object.")
        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id.strip():
            raise ApiError(HTTPStatus.BAD_REQUEST, f"Each item in '{key_name}' must have a non-empty string 'id'.")
        if item_id in index_by_id:
            result[index_by_id[item_id]] = item
        else:
            index_by_id[item_id] = len(result)
            result.append(item)
    return result


def get_mime_type(path: Path) -> str:
    """Resolve MIME type for static assets and uploaded files."""
    ext = path.suffix.lower()
    if ext in MIME_TYPES:
        return MIME_TYPES[ext]
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


class StudyRequestHandler(BaseHTTPRequestHandler):
    """HTTP handler for static UI and REST API."""

    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write(f"[studyflow] {self.address_string()} - {format % args}\n")

    def send_json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status: int, message: str) -> None:
        self.close_connection = True
        body = json.dumps({"error": message}, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def read_body_bounded(self, max_bytes: int) -> bytes:
        raw_len = self.headers.get("Content-Length")
        if raw_len is None:
            raise ApiError(HTTPStatus.LENGTH_REQUIRED, "Content-Length header is required.")
        try:
            content_len = int(raw_len)
        except ValueError as exc:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Invalid Content-Length header.") from exc
        if content_len < 0:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Invalid Content-Length header.")
        if content_len > max_bytes:
            raise ApiError(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                f"Payload exceeds {max_bytes // (1024 * 1024)} MB limit.",
            )
        remaining = content_len
        chunks: list[bytes] = []
        while remaining > 0:
            chunk = self.rfile.read(min(65536, remaining))
            if not chunk:
                raise ApiError(HTTPStatus.BAD_REQUEST, "Incomplete request body.")
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def read_json_body(self) -> Any:
        raw = self.read_body_bounded(MAX_JSON_BYTES)
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError(HTTPStatus.BAD_REQUEST, f"Invalid JSON body: {exc}") from exc

    def serve_file(self, path: Path, *, inline: bool = False, cache_control: str = "no-cache") -> None:
        if not path.is_file() or path.is_symlink():
            raise ApiError(HTTPStatus.NOT_FOUND, "File not found.")
        size = path.stat().st_size
        mime = get_mime_type(path)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", cache_control)
        self.send_header("X-Content-Type-Options", "nosniff")
        if inline:
            encoded_name = urllib.parse.quote(path.name)
            self.send_header("Content-Disposition", f"inline; filename*=UTF-8''{encoded_name}")
        self.end_headers()
        with path.open("rb") as fh:
            while True:
                chunk = fh.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)

    def resolve_app_asset(self, rel_segments: list[str]) -> Path:
        if not rel_segments or any(seg in {"", ".", ".."} or "\\" in seg or "\x00" in seg for seg in rel_segments):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Invalid asset path.")
        app_resolved = APP_DIR.resolve()
        candidate = (APP_DIR.joinpath(*rel_segments)).resolve()
        if not candidate.is_relative_to(app_resolved):
            raise ApiError(HTTPStatus.FORBIDDEN, "Access denied.")
        if not candidate.is_file() or candidate.is_symlink():
            raise ApiError(HTTPStatus.NOT_FOUND, "Asset not found.")
        return candidate

    def resolve_root_index(self) -> Path:
        root_idx = (ROOT / "index.html").resolve()
        if root_idx.is_file() and not root_idx.is_symlink():
            return root_idx
        return self.resolve_app_asset(["index.html"])

    def do_GET(self) -> None:
        try:
            parsed = urllib.parse.urlsplit(self.path)
            raw_path = parsed.path

            if raw_path == "/":
                self.serve_file(self.resolve_root_index())
                return

            if raw_path.startswith("/app/"):
                raw_rel = raw_path[len("/app/"):].split("/")
                segments = [urllib.parse.unquote(s) for s in raw_rel if s != ""]
                self.serve_file(self.resolve_app_asset(segments))
                return

            if raw_path == "/api/subjects":
                self.send_json(HTTPStatus.OK, {"subjects": discover_subjects()})
                return

            if raw_path == "/api/progress":
                with WRITE_LOCK:
                    data = read_json_safe(PROGRESS_PATH)
                if not isinstance(data, dict):
                    data = {"subjects": {}}
                elif not isinstance(data.get("subjects"), dict):
                    data["subjects"] = {}
                self.send_json(HTTPStatus.OK, data)
                return

            raw_parts = [p for p in raw_path.split("/") if p != ""]

            # GET /files/<id>/<filename>
            if len(raw_parts) == 3 and raw_parts[0] == "files":
                subject_id = urllib.parse.unquote(raw_parts[1])
                filename = urllib.parse.unquote(raw_parts[2])
                subject_dir = resolve_subject_dir(subject_id)
                if filename.startswith((".", "_")):
                    raise ApiError(HTTPStatus.FORBIDDEN, "Access denied.")
                target = resolve_subject_file(subject_dir, filename)
                self.serve_file(target, inline=True, cache_control="no-cache")
                return

            # GET /api/subjects/<id>/study | /graph
            if len(raw_parts) == 4 and raw_parts[0] == "api" and raw_parts[1] == "subjects":
                subject_id = urllib.parse.unquote(raw_parts[2])
                action = raw_parts[3]
                subject_dir = resolve_subject_dir(subject_id)
                if action == "study":
                    study_path = resolve_subject_file(subject_dir, "study.json")
                    with WRITE_LOCK:
                        raw = read_json_safe(study_path)
                    self.send_json(HTTPStatus.OK, normalize_study(subject_dir.name, raw))
                    return
                if action == "graph":
                    graph_path = resolve_subject_file(subject_dir, "graph.json")
                    with WRITE_LOCK:
                        raw = read_json_safe(graph_path)
                    if not isinstance(raw, dict):
                        raw = {"nodes": [], "links": []}
                    self.send_json(HTTPStatus.OK, raw)
                    return

            # Top-level asset fallback inside app/ (e.g., /styles.css, /app.js, /graph.js)
            if len(raw_parts) >= 1 and raw_parts[0] not in {"api", "files"}:
                segments = [urllib.parse.unquote(s) for s in raw_parts]
                self.serve_file(self.resolve_app_asset(segments))
                return

            raise ApiError(HTTPStatus.NOT_FOUND, "Endpoint not found.")
        except ApiError as err:
            self.send_error_json(err.status, err.message)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self.send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"Internal error: {exc}")

    def do_POST(self) -> None:
        try:
            parsed = urllib.parse.urlsplit(self.path)
            raw_parts = [p for p in parsed.path.split("/") if p != ""]

            # POST /api/subjects
            if raw_parts == ["api", "subjects"]:
                body = self.read_json_body()
                if not isinstance(body, dict):
                    raise ApiError(HTTPStatus.BAD_REQUEST, "Body must be a JSON object.")
                name = str(body.get("name") or "").strip()
                if not name:
                    raise ApiError(HTTPStatus.BAD_REQUEST, "Subject 'name' is required.")
                raw_id = body.get("id")
                slug = validate_slug(str(raw_id).strip()) if raw_id else slugify_name(name)
                code = str(body.get("code") if body.get("code") is not None else slug.upper()).strip()
                description = str(body.get("description") or "").strip()

                with WRITE_LOCK:
                    subject_dir = (ROOT / slug).resolve()
                    if not subject_dir.is_relative_to(ROOT.resolve()) or subject_dir.parent != ROOT.resolve():
                        raise ApiError(HTTPStatus.BAD_REQUEST, "Invalid subject path.")
                    if subject_dir.exists():
                        raise ApiError(HTTPStatus.CONFLICT, f"Subject '{slug}' already exists.")
                    subject_dir.mkdir(parents=False, exist_ok=False)
                    study_path = resolve_subject_file(subject_dir, "study.json")
                    atomic_write_json(study_path, empty_study(slug, name=name, code=code, description=description))
                    summary = build_subject_summary(subject_dir)
                self.send_json(HTTPStatus.CREATED, summary)
                return

            # POST /api/subjects/<id>/import | /upload
            if len(raw_parts) == 4 and raw_parts[0] == "api" and raw_parts[1] == "subjects":
                subject_id = urllib.parse.unquote(raw_parts[2])
                action = raw_parts[3]
                subject_dir = resolve_subject_dir(subject_id)

                if action == "import":
                    body = self.read_json_body()
                    if not isinstance(body, dict):
                        raise ApiError(HTTPStatus.BAD_REQUEST, "Import payload must be a JSON object.")
                    mode = body.get("mode", "merge")
                    if mode not in {"merge", "replace"}:
                        raise ApiError(HTTPStatus.BAD_REQUEST, "Import 'mode' must be 'merge' or 'replace'.")
                    data = body.get("data")
                    if not isinstance(data, dict):
                        raise ApiError(HTTPStatus.BAD_REQUEST, "Import 'data' must be a JSON object.")

                    # Support singular 'topic' helper format alongside 'topics'
                    incoming_topics = data.get("topics")
                    if incoming_topics is None and isinstance(data.get("topic"), dict):
                        incoming_topics = [data["topic"]]

                    with WRITE_LOCK:
                        study_path = resolve_subject_file(subject_dir, "study.json")
                        current = normalize_study(subject_dir.name, read_json_safe(study_path))

                        collections = {
                            "topics": incoming_topics,
                            "formulas": data.get("formulas"),
                            "flashcards": data.get("flashcards"),
                            "questions": data.get("questions"),
                        }

                        if mode == "replace":
                            updated = empty_study(
                                subject_dir.name,
                                name=str(data.get("name") or current["name"]),
                                code=str(data.get("code") if data.get("code") is not None else current["code"]),
                                description=str(data.get("description") if data.get("description") is not None else current["description"]),
                            )
                            for key, items in collections.items():
                                if items is not None:
                                    if not isinstance(items, list):
                                        raise ApiError(HTTPStatus.BAD_REQUEST, f"'{key}' must be a list.")
                                    updated[key] = merge_by_id([], items, key)
                        else:
                            updated = dict(current)
                            for meta_key in ("name", "code", "description"):
                                if isinstance(data.get(meta_key), str) and data[meta_key].strip():
                                    if current[meta_key] in {"", subject_dir.name, subject_dir.name.upper()}:
                                        updated[meta_key] = data[meta_key].strip()
                            for key, items in collections.items():
                                if items is not None:
                                    if not isinstance(items, list):
                                        raise ApiError(HTTPStatus.BAD_REQUEST, f"'{key}' must be a list.")
                                    updated[key] = merge_by_id(current[key], items, key)

                        atomic_write_json(study_path, updated)
                        summary = build_subject_summary(subject_dir)

                    self.send_json(HTTPStatus.OK, {"ok": True, "counts": summary["counts"], "study": updated})
                    return

                if action == "upload":
                    qs = urllib.parse.parse_qs(parsed.query, keep_blank_values=False)
                    raw_names = qs.get("filename")
                    if not raw_names:
                        raise ApiError(HTTPStatus.BAD_REQUEST, "Query parameter 'filename' is required.")
                    filename = validate_filename(raw_names[0])
                    if filename.startswith((".", "_")) or filename.lower() in FORBIDDEN_FILE_NAMES:
                        raise ApiError(HTTPStatus.FORBIDDEN, f"Uploading '{filename}' directly is forbidden.")
                    ext = Path(filename).suffix.lower()
                    if ext not in ALLOWED_UPLOAD_EXTS:
                        raise ApiError(
                            HTTPStatus.BAD_REQUEST,
                            f"Unsupported extension '{ext}'. Allowed: {', '.join(sorted(ALLOWED_UPLOAD_EXTS))}",
                        )
                    payload = self.read_body_bounded(MAX_UPLOAD_BYTES)
                    target = resolve_subject_file(subject_dir, filename)
                    with WRITE_LOCK:
                        atomic_write_bytes(target, payload)
                    self.send_json(
                        HTTPStatus.CREATED,
                        {
                            "name": filename,
                            "size": len(payload),
                            "ext": ext,
                            "url": f"/files/{subject_dir.name}/{urllib.parse.quote(filename)}",
                        },
                    )
                    return

            raise ApiError(HTTPStatus.NOT_FOUND, "Endpoint not found.")
        except ApiError as err:
            self.send_error_json(err.status, err.message)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self.send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"Internal error: {exc}")

    def do_PUT(self) -> None:
        try:
            parsed = urllib.parse.urlsplit(self.path)
            raw_parts = [p for p in parsed.path.split("/") if p != ""]

            # PUT /api/progress
            if raw_parts == ["api", "progress"]:
                body = self.read_json_body()
                if not isinstance(body, dict) or not isinstance(body.get("subjects"), dict):
                    raise ApiError(HTTPStatus.BAD_REQUEST, "Progress payload must be a JSON object with 'subjects' object.")
                with WRITE_LOCK:
                    atomic_write_json(PROGRESS_PATH, body)
                self.send_json(HTTPStatus.OK, {"ok": True})
                return

            # PUT /api/subjects/<id>/study | /graph
            if len(raw_parts) == 4 and raw_parts[0] == "api" and raw_parts[1] == "subjects":
                subject_id = urllib.parse.unquote(raw_parts[2])
                action = raw_parts[3]
                subject_dir = resolve_subject_dir(subject_id)

                if action == "study":
                    body = self.read_json_body()
                    validated = validate_study_payload(subject_dir.name, body)
                    study_path = resolve_subject_file(subject_dir, "study.json")
                    with WRITE_LOCK:
                        atomic_write_json(study_path, validated)
                        summary = build_subject_summary(subject_dir)
                    self.send_json(HTTPStatus.OK, {"ok": True, "counts": summary["counts"], "study": validated})
                    return

                if action == "graph":
                    body = self.read_json_body()
                    if not isinstance(body, dict) or not isinstance(body.get("nodes"), list):
                        raise ApiError(HTTPStatus.BAD_REQUEST, "Graph payload must be a JSON object with 'nodes' list.")
                    links = body.get("links") if "links" in body else body.get("edges")
                    if not isinstance(links, list):
                        raise ApiError(HTTPStatus.BAD_REQUEST, "Graph payload must include 'links' or 'edges' list.")
                    graph_path = resolve_subject_file(subject_dir, "graph.json")
                    with WRITE_LOCK:
                        atomic_write_json(graph_path, body)
                    self.send_json(
                        HTTPStatus.OK,
                        {"ok": True, "counts": {"nodes": len(body["nodes"]), "edges": len(links)}},
                    )
                    return

            raise ApiError(HTTPStatus.NOT_FOUND, "Endpoint not found.")
        except ApiError as err:
            self.send_error_json(err.status, err.message)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self.send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"Internal error: {exc}")

    def do_DELETE(self) -> None:
        try:
            parsed = urllib.parse.urlsplit(self.path)
            raw_parts = [p for p in parsed.path.split("/") if p != ""]

            # DELETE /api/subjects/<id>/files/<filename>
            if len(raw_parts) == 5 and raw_parts[0] == "api" and raw_parts[1] == "subjects" and raw_parts[3] == "files":
                subject_id = urllib.parse.unquote(raw_parts[2])
                filename = urllib.parse.unquote(raw_parts[4])
                subject_dir = resolve_subject_dir(subject_id)
                safe_name = validate_filename(filename)
                if safe_name.startswith((".", "_")) or safe_name.lower() in FORBIDDEN_FILE_NAMES:
                    raise ApiError(HTTPStatus.FORBIDDEN, f"Deleting '{safe_name}' is forbidden.")
                target = resolve_subject_file(subject_dir, safe_name)
                if not target.is_file():
                    raise ApiError(HTTPStatus.NOT_FOUND, f"File '{safe_name}' not found.")
                with WRITE_LOCK:
                    target.unlink()
                self.send_json(HTTPStatus.OK, {"ok": True, "deleted": safe_name})
                return

            raise ApiError(HTTPStatus.NOT_FOUND, "Endpoint not found.")
        except ApiError as err:
            self.send_error_json(err.status, err.message)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self.send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"Internal error: {exc}")


class StudyHTTPServer(ThreadingHTTPServer):
    """Threaded HTTP server configured for clean local restarts and Ctrl+C exit."""

    allow_reuse_address = True
    daemon_threads = True


def main() -> None:
    port = int(os.environ.get("PORT", 8765))
    server = StudyHTTPServer(("127.0.0.1", port), StudyRequestHandler)
    print(f"StudyFlow server running at http://127.0.0.1:{port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print("\nShutting down StudyFlow server...", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

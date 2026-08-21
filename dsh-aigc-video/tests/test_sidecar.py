"""
Tests for the quality sidecar's pure helpers.

The FastAPI / pHash / hamming functions are pure-Python and need no
GPU or external services. We cover:
  - _phash_64 determinism + collision properties
  - _hamming_similarity
  - subject_consistency JSON shape (with stubbed frames)
  - /health endpoint
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

# Make scripts/ importable when running from project root.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import pytest

from sidecar import _phash_64, _hamming_similarity, create_app, app as default_app  # noqa: E402


# ── pHash determinism ───────────────────────────────────────────────
def test_phash_deterministic():
    h1 = _phash_64(b"hello world" * 10)
    h2 = _phash_64(b"hello world" * 10)
    assert h1 == h2


def test_phash_differs_for_different_content():
    a = _phash_64(b"\x00" * 1024)
    b = _phash_64(b"\xff" * 1024)
    assert a != b


def test_phash_handles_empty():
    h = _phash_64(b"")
    assert h == 0


def test_phash_handles_short_input():
    # Fewer than 64 bytes — chunk size becomes 1.
    h = _phash_64(b"abc")
    assert 0 <= h <= (1 << 64) - 1


def test_phash_is_bounded_64bit():
    h = _phash_64(b"x" * 4096)
    assert 0 <= h < (1 << 64)


# ── Hamming similarity ──────────────────────────────────────────────
def test_hamming_identical():
    h = _phash_64(b"identical payload content")
    assert _hamming_similarity(h, h) == 1.0


def test_hamming_complementary():
    a = 0
    b = (1 << 64) - 1
    assert _hamming_similarity(a, b) == 0.0


def test_hamming_in_range():
    h1 = _phash_64(b"one")
    h2 = _phash_64(b"two")
    sim = _hamming_similarity(h1, h2)
    assert 0.0 <= sim <= 1.0


# ── FastAPI app + endpoints ───────────────────────────────────────────────────────
def _client():
    from fastapi.testclient import TestClient
    return TestClient(default_app)


def test_health_endpoint():
    c = _client()
    r = c.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["version"] == "3.2.0"
    assert "ml" in body
    assert body["ml"]["dinov2"] is False  # default = no ML
    assert body["ml"]["arcface"] is False


def test_subject_consistency_endpoint_missing_file():
    c = _client()
    r = c.post("/subject_consistency", json={"clip_path":"/nonexistent/file.mp4"})
    assert r.status_code == 200  # sidecar returns 0.5 not 404 for missing
    body = r.json()
    assert "score" in body
    assert body["details"]["frame_count"] == 0


def test_subject_consistency_endpoint_missing_field():
    c = _client()
    r = c.post("/subject_consistency", json={})
    assert r.status_code == 400


def test_prompt_alignment_endpoint_basic():
    c = _client()
    r = c.post("/prompt_alignment", json={"prompt": "a cat on a chair", "caption": "a cat sits"})
    assert r.status_code == 200
    body = r.json()
    assert 0.0 <= body["score"] <= 1.0


def test_prompt_alignment_empty_inputs():
    c = _client()
    r = c.post("/prompt_alignment", json={"prompt": "", "caption": ""})
    assert r.status_code == 200
    assert r.json()["score"] == 0.0


def test_create_app_factory():
    a = create_app({})
    assert a.title.startswith("dsh-aigc-video")


# ── End-to-end with a real JPEG ─────────────────────────────────────────────
def _make_test_jpeg() -> bytes:
    """Build a minimal valid JPEG in memory (10x10 black)."""
    try:
        from PIL import Image
    except ImportError:
        pytest.skip("Pillow not installed")
    img = Image.new("RGB", (10, 10), color=(0, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


def test_phash_real_image_bytes():
    jpg = _make_test_jpeg()
    h1 = _phash_64(jpg)
    h2 = _phash_64(jpg)
    assert h1 == h2
    # Different content → different hash.
    from PIL import Image
    img2 = Image.new("RGB", (10, 10), color=(255, 255, 255))
    buf2 = io.BytesIO()
    img2.save(buf2, format="JPEG")
    assert _phash_64(jpg) != _phash_64(buf2.getvalue())
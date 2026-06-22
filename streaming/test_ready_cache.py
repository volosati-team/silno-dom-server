from fastapi.testclient import TestClient

from streaming.app import _cache_put, app


def test_ready_uses_audio_cache_key():
    client = TestClient(app)
    url = "https://soundcloud.com/example-track"

    empty = client.get("/api/stream/ready", params={"url": url})
    assert empty.status_code == 200
    assert empty.json() == {"ready": False}

    _cache_put(f"audio:{url}", {"stream_url": "/api/stream/proxy/test", "title": "Example"})

    cached = client.get("/api/stream/ready", params={"url": url})
    assert cached.status_code == 200
    assert cached.json() == {
        "ready": True,
        "payload": {"stream_url": "/api/stream/proxy/test", "title": "Example"},
    }

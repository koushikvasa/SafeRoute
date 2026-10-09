"""VSS login and clip download. Tokens stay on the server."""

import os
import threading
import time

import requests

_lock = threading.Lock()
_token = {"value": None, "at": 0}


def _base():
    return os.environ["VSS_URL"].rstrip("/")


def login(force=False):
    with _lock:
        if not force and _token["value"] and time.time() - _token["at"] < 20 * 60:
            return _token["value"]
        response = requests.post(
            f"{_base()}/api/v1/auth/login",
            json={"username": os.environ["VSS_USERNAME"], "password": os.environ["VSS_PASSWORD"]},
            timeout=15,
        )
        response.raise_for_status()
        _token["value"] = response.json()["access_token"]
        _token["at"] = time.time()
        return _token["value"]


def _headers():
    return {"Authorization": f"Bearer {login()}"}


def open_stream(source, range_header):
    headers = {}
    if range_header:
        headers["Range"] = range_header
    return requests.get(
        f"{_base()}/api/v1/videos/stream",
        params={"source": source, "token": login()},
        headers=headers,
        stream=True,
        timeout=60,
    )

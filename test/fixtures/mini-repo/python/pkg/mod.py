"""Module docstring mentioning # noqa and # type: ignore as plain text."""
import requests


def fetch(url):
    try:
        return requests.get(url)
    except Exception:  # noqa: BLE001 - boundary catch logs and re-raises
        raise

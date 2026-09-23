"""JSON-file backed user data store: watch progress + favorites.

Port of the site's server/store.ts so both backends can read the same
server/data/store.json file. Debounced atomic writes; same shape:
``{"progress": {animeId: entry}, "favorites": {animeId: entry}}``.
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import time
from typing import Any

from .models import FavoriteEntry, ProgressEntry


def _now_ms() -> int:
    return int(time.time() * 1000)


async def _poster_for(http, provider, anime_id: str) -> str | None:
    """Best-effort poster lookup (cached provider call)."""
    try:
        details = await provider.details(anime_id)
        return details.poster
    except Exception:
        return None

def _default_data_dir() -> str:
    """Pick the first writable data directory.

    Order: $ANISTREAM_DATA_DIR → ./server/data → a temp dir. The temp-dir
    fallback matters on read-only filesystems (e.g. Vercel's serverless
    /var/task), where writes to the working directory would crash.
    """
    env = os.environ.get("ANISTREAM_DATA_DIR")
    if env:
        return env
    candidates = [
        os.path.join(os.getcwd(), "server", "data"),
        os.path.join(tempfile.gettempdir(), "anistream-data"),
    ]
    for d in candidates:
        try:
            os.makedirs(d, exist_ok=True)
            probe = os.path.join(d, ".write-probe")
            with open(probe, "w", encoding="utf-8") as f:
                f.write("1")
            os.unlink(probe)
            return d
        except OSError:
            continue
    return candidates[-1]


DATA_DIR = _default_data_dir()
DATA_FILE = os.path.join(DATA_DIR, "store.json")


class UserDataStore:
    def __init__(self, path: str = DATA_FILE) -> None:
        self.path = path
        self._data: dict[str, dict[str, Any]] = {"progress": {}, "favorites": {}}
        self._write_task: asyncio.Task | None = None

    async def init(self) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        try:
            with open(self.path, encoding="utf-8") as f:
                parsed = json.load(f)
            self._data = {
                "progress": parsed.get("progress") or {},
                "favorites": parsed.get("favorites") or {},
            }
        except (OSError, ValueError):
            await self._persist_now()

    # ---- persistence ----

    def _schedule_persist(self) -> None:
        """Debounced persist when inside a loop; sync fallback otherwise."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # no loop (e.g. scripts/tests): write immediately
            import threading

            threading.Thread(target=lambda: asyncio.run(self._persist_now()), daemon=True).start()
            return
        if self._write_task is None or self._write_task.done():

            async def debounced() -> None:
                await asyncio.sleep(0.4)
                await self._persist_now()

            self._write_task = loop.create_task(debounced())

    async def _persist_now(self) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(self.path) or ".")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(self._data, f, indent=2)
            os.replace(tmp, self.path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    # ---- progress ----

    def list_progress(self) -> list[ProgressEntry]:
        items = [ProgressEntry.model_validate(v) for v in self._data["progress"].values()]
        return sorted(items, key=lambda e: e.updated_at, reverse=True)

    def get_progress(self, anime_id: str) -> ProgressEntry | None:
        raw = self._data["progress"].get(anime_id)
        return ProgressEntry.model_validate(raw) if raw else None

    def save_progress(self, entry: ProgressEntry, poster: str | None = None) -> None:
        entry.updated_at = _now_ms()
        existing = self._data["progress"].get(entry.anime_id)
        watched = set((existing or {}).get("watchedEpisodes") or [])
        if (
            entry.duration_seconds > 0
            and entry.position_seconds / max(1, entry.duration_seconds) >= 0.9
        ):
            watched.add(entry.episode_number)
        entry.watched_episodes = sorted(watched, key=lambda n: (len(n), n))
        if poster:
            entry.poster = poster
        elif existing and existing.get("poster"):
            entry.poster = existing["poster"]
        self._data["progress"][entry.anime_id] = entry.model_dump(mode="json")
        self._schedule_persist()

    def delete_progress(self, anime_id: str) -> None:
        self._data["progress"].pop(anime_id, None)
        self._schedule_persist()

    # ---- favorites ----

    def list_favorites(self) -> list[FavoriteEntry]:
        items = [FavoriteEntry.model_validate(v) for v in self._data["favorites"].values()]
        return sorted(items, key=lambda e: e.added_at, reverse=True)

    def is_favorite(self, anime_id: str) -> bool:
        return anime_id in self._data["favorites"]

    def add_favorite(self, anime_id: str, anime_title: str = "", poster: str | None = None) -> None:
        existing = self._data["favorites"].get(anime_id) or {}
        self._data["favorites"][anime_id] = FavoriteEntry(
            anime_id=anime_id,
            anime_title=anime_title or anime_id,
            poster=poster or existing.get("poster"),
        ).model_dump(mode="json")
        self._schedule_persist()

    def remove_favorite(self, anime_id: str) -> None:
        self._data["favorites"].pop(anime_id, None)
        self._schedule_persist()

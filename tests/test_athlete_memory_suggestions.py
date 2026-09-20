"""insert_suggestions() must skip a candidate that's already pending (identical
category/key/value, unresolved) so a re-run check-in doesn't pile up duplicate rows for
the same fact — see migration 047 and services/ai/coaching_memory.py.

Fake Supabase client, same minimal in-memory style as test_completed_activities_hr_zone.py.
"""

from services.ai.coaching_memory import MemoryFactCandidate
from services.supabase import athlete_memory_suggestions


class _FakeResult:
    def __init__(self, data):
        self.data = data


class _FakeQuery:
    def __init__(self, table_name, store):
        self._table_name = table_name
        self._store = store

    def select(self, *args, **kwargs):
        return self

    def eq(self, *args, **kwargs):
        return self

    def insert(self, rows, **kwargs):
        self._store["inserted"].extend(rows)
        return self

    def execute(self):
        if self._table_name == "athlete_memory_suggestions":
            return _FakeResult(self._store["pending"])
        return _FakeResult(None)


class _FakeClient:
    def __init__(self, pending):
        self._store = {"pending": pending, "inserted": []}

    def table(self, name):
        return _FakeQuery(name, self._store)

    @property
    def inserted(self):
        return self._store["inserted"]


def _install_fake(monkeypatch, pending):
    client = _FakeClient(pending)
    monkeypatch.setattr(athlete_memory_suggestions, "get_supabase", lambda: client)
    return client


def test_skips_candidate_already_pending(monkeypatch):
    client = _install_fake(
        monkeypatch,
        pending=[{"category": "injuries", "key": "shin_splints", "value": "Ongoing shin splints."}],
    )
    candidates = [MemoryFactCandidate(category="injuries", key="shin_splints", value="Ongoing shin splints.")]

    athlete_memory_suggestions.insert_suggestions("user-1", candidates, source_note="note")

    assert client.inserted == []


def test_inserts_new_candidate_not_already_pending(monkeypatch):
    client = _install_fake(monkeypatch, pending=[])
    candidates = [MemoryFactCandidate(category="injuries", key="shin_splints", value="Ongoing shin splints.")]

    athlete_memory_suggestions.insert_suggestions("user-1", candidates, source_note="note", replan_job_id="job-1")

    assert len(client.inserted) == 1
    assert client.inserted[0]["key"] == "shin_splints"
    assert client.inserted[0]["user_id"] == "user-1"
    assert client.inserted[0]["replan_job_id"] == "job-1"


def test_inserts_candidate_with_changed_value_even_if_key_pending(monkeypatch):
    client = _install_fake(
        monkeypatch,
        pending=[{"category": "injuries", "key": "shin_splints", "value": "Mild shin splints."}],
    )
    candidates = [MemoryFactCandidate(category="injuries", key="shin_splints", value="Shin splints have worsened.")]

    athlete_memory_suggestions.insert_suggestions("user-1", candidates, source_note="note")

    assert len(client.inserted) == 1

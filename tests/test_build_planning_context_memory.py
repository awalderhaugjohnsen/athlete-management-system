"""Confirmed athlete_memory facts (e.g. an injury mentioned in a past check-in and
approved from the dashboard) must reach build_planning_context()'s output, since that's
what's injected into every future check-in's prompt — see migration 047 and
services/ai/coaching_memory.py.

Fake Supabase client, same minimal in-memory style as test_completed_activities_hr_zone.py.
"""

from services.supabase import athlete_profile


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

    def maybe_single(self, *args, **kwargs):
        return self

    def execute(self):
        if self._table_name == "athlete_profile":
            return _FakeResult(self._store["profile"])
        return _FakeResult(None)


class _FakeClient:
    def __init__(self, profile):
        self._store = {"profile": profile}

    def table(self, name):
        return _FakeQuery(name, self._store)


def _install_fake(monkeypatch, profile, memory_text):
    monkeypatch.setattr(athlete_profile, "get_supabase", lambda: _FakeClient(profile))
    monkeypatch.setattr(athlete_profile, "get_athlete_memory", lambda user_id: memory_text)


_MINIMAL_PROFILE = {"available_days": ["monday"]}


def test_includes_learned_section_when_memory_present(monkeypatch):
    _install_fake(monkeypatch, _MINIMAL_PROFILE, "\n### INJURIES\n- shin_splints: Started getting shin splints in early September.\n")

    context = athlete_profile.build_planning_context("test-user")

    assert "=== LEARNED FROM PAST CHECK-INS (confirmed by athlete) ===" in context
    assert "shin_splints" in context


def test_omits_learned_section_when_memory_empty(monkeypatch):
    _install_fake(monkeypatch, _MINIMAL_PROFILE, None)

    context = athlete_profile.build_planning_context("test-user")

    assert "LEARNED FROM PAST CHECK-INS" not in context

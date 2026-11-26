"""Make the bundled Korean text frontend usable without network access.

``g2pk2`` tries to pip-install ``eunjeon`` and download the NLTK ``cmudict``
corpus while it is imported.  Both actions can block for minutes on a machine
without network access, which looks like a stuck TTS request.  This module is
applied by the TTS worker before GPT-SoVITS imports ``text.korean``.

If a real mecab/eunjeon installation exists it is still used.  Otherwise a
small whitespace tokenizer keeps Korean pronunciation rules running instead
of leaving the worker blocked on pip.
"""

from __future__ import annotations

import importlib.util


class _FallbackMecab:
    """Minimal POS tagger shape used by g2pk2.utils.annotate."""

    def pos(self, text: str) -> list[tuple[str, str]]:
        return [(word, "NNG") for word in text.split() if word]


class _EmptyCmu:
    """Stand-in for nltk.corpus.cmudict when the corpus is not installed."""

    def dict(self) -> dict[str, list[list[str]]]:
        return {}


def prepare_korean_compat() -> str:
    """Patch g2pk2/NLTK import-time behaviour.  Safe to call more than once."""
    try:
        import nltk

        # g2pk2 calls nltk.download('cmudict') at import time.  Never let that
        # reach the network; a missing corpus is handled below.
        nltk.download = lambda *args, **kwargs: True  # type: ignore[assignment]

        import g2pk2.g2pk2 as g2pk
    except Exception as exc:  # pragma: no cover - depends on the shipped runtime
        return f"korean compat skipped: {exc}"

    # g2pk2's Windows path runs `pip install eunjeon` and waits for it.
    # GPT-SoVITS already overrides check_mecab, but it calls super() first.
    g2pk.G2p.check_mecab = lambda self: None  # type: ignore[assignment]

    fallback = _FallbackMecab()
    original_get_mecab = g2pk.G2p.get_mecab

    def get_mecab(self):
        # Calling the original on Windows without eunjeon prints a noisy
        # message and raises; skip straight to the fallback in that case.
        if importlib.util.find_spec("eunjeon") is None:
            return fallback
        try:
            mecab = original_get_mecab(self)
            if mecab is not None:
                return mecab
        except Exception:
            pass
        return fallback

    g2pk.G2p.get_mecab = get_mecab  # type: ignore[assignment]

    try:
        nltk.data.find("corpora/cmudict.zip")
    except Exception:
        g2pk.cmudict = _EmptyCmu()  # type: ignore[assignment]

    # Build the Korean module once, while filtering g2pk2's misleading
    # "install eunjeon" notice.  Doing it here also means the first Korean
    # request cannot block on a late import.
    try:
        import sys

        class _FilteredStdout:
            def __init__(self, wrapped):
                self.wrapped = wrapped

            def write(self, text):
                if "eunjeon" in text.lower():
                    return len(text)
                return self.wrapped.write(text)

            def flush(self):
                return self.wrapped.flush()

        previous = sys.stdout
        sys.stdout = _FilteredStdout(previous)
        try:
            from text import korean as _korean  # noqa: F401
        finally:
            sys.stdout = previous
    except Exception as exc:  # pragma: no cover - depends on the shipped runtime
        return f"korean fallback active (preload failed: {exc})"

    return "korean fallback ready"

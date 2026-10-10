"""Compatibility shim for legacy build frontends.

All real metadata lives in ``pyproject.toml`` (PEP 621); setuptools >= 68
reads it and provides the PEP 660 ``build_editable`` hook that
``pip install -e`` uses.

This file exists for two real-world cases:

* pip < 21.3 (pre-PEP-660): ``pip install -e`` refuses pyproject-only
  projects with "build backend is missing the 'build_editable' hook ... does
  not have a 'setup.py' nor a 'setup.cfg'". With this shim it falls back to
  the legacy ``setup.py develop`` path.
* Old setuptools in an ambient build env (``--no-build-isolation``, or a
  frontend that reuses the caller's environment): setuptools < 61 cannot
  read the ``[project]`` table and would silently build ``UNKNOWN-0.0.0``.
  The floor check below turns that into a loud, actionable error.
"""

import setuptools

_MAJOR = int(setuptools.__version__.split(".", 1)[0])
if _MAJOR < 68:
    raise RuntimeError(
        "latticeag-vekrevert requires setuptools>=68 to build "
        f"(found {setuptools.__version__}). Older setuptools ignore the "
        "PEP 621 [project] table in pyproject.toml and would build the "
        "package as UNKNOWN-0.0.0. Upgrade and retry: "
        "`python -m pip install --upgrade pip setuptools`, or install the "
        "published release instead: `pip install latticeag-vekrevert`."
    )

setuptools.setup()

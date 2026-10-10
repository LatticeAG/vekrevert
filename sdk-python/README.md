# latticeag-vekrevert

Python SDK for VekRevert. See the repository README.

## In-tree vs packaged

This directory is a **partial port** used to pin the cross-language
conformance vectors:

- `latticeag_vekrevert/core/` — taxonomy, plan, chain, JCS — is real and
  exercised by `tests/` against the frozen vectors in `conformance/`.
- The client surface is stubbed: sagas keep `sag_pending` ids,
  `instrument_fs` is a no-op, and the only ledger is the HTTP client
  (`ledger/http.py`).

`pip install latticeag-vekrevert` (PyPI) is the packaged artifact — do not
expect the source tree to be a fuller version of it.

## Building from this directory

Requires Python >= 3.11. `pyproject.toml` declares
`setuptools>=68` in `build-system.requires`, which is what makes the PEP 621
`[project]` metadata and the PEP 660 `build_editable` hook available:

```bash
pip install -e .          # editable; needs pip >= 21.3 or the setup.py fallback
pip install .             # regular install
```

`setup.py` is a compatibility shim only: it lets `pip install -e` fall back
to `setup.py develop` on pre-PEP-660 pip, and it fails loudly on
`setuptools<68` instead of silently building `UNKNOWN-0.0.0` when the build
runs against an ambient environment (e.g. `--no-build-isolation`).

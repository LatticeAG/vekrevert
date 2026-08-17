# TS / Python method parity

Source of truth for public surfaces. `scripts/check_parity.ts` fails CI if a row is missing from TS exports or Python `__all__`.

| TS | Python |
|---|---|
| `openSaga` / `resumeSaga` | `saga()` / `resume_saga()` |
| `saga.effect({run})` | `with saga.effect(...) as eff` |
| `classify` / `plan` / `verify` / `execute` | `classify` / `plan` / `verify` / `execute` |
| `undo` / `status` / `receipts` / `escalate` | `undo` / `status` / `receipts` / `escalate` |
| `registry.register/list/match` | `registry.register/list/match` |
| `wrapFetch` / `instrumentFs` / `instrumentPg` / `wrapMcpServer` | `instrument_httpx` / `instrument_fs` / `instrument_sqlalchemy` / `instrument_mcp` |

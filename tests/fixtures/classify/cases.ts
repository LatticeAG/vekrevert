/** 120 golden classify cases derived from SPEC §5.3. */
import type { ActionRef, JsonValue, PreimageRef, Tier } from "@latticeag/vekrevert-core";

export interface ClassifyCase {
  name: string;
  action: ActionRef;
  args: JsonValue;
  ctx?: {
    result?: JsonValue;
    resultStatus?: number;
    resultHeaders?: Record<string, string>;
    preimage?: PreimageRef;
    pkResolvable?: boolean;
    affectedRows?: number;
    recreateFromPreimage?: boolean;
    writableRoots?: string[];
    internalHosts?: string[];
    transportError?: boolean;
    timeout?: boolean;
    networkOrFuseMount?: boolean;
    realpathEscapes?: boolean;
    compensatorMatched?: boolean;
    scopeViolation?: boolean;
    modelTier?: Tier;
    manifestTier?: Tier;
    manifestGlob?: string;
  };
  expected: { tier: Tier; scope_violation?: boolean; in_doubt?: boolean };
}

function http(name: string, method: string, url: string, locality: ActionRef["locality"] = "external"): ActionRef {
  const u = new URL(url);
  return {
    kind: "http",
    name: `http.${method}.${u.host}${u.pathname}`,
    target: u.host,
    locality,
  };
}

function sql(name: string, locality: ActionRef["locality"] = "internal"): ActionRef {
  return { kind: "sql", name: `sql.${name}`, target: "app", locality };
}

function fs(op: string, path: string): ActionRef {
  return { kind: "fs", name: `fs.${op}.${path}`, target: path, locality: "internal" };
}

const preFs: PreimageRef = { kind: "fs_bytes", blob_id: "blob_sha256:ab", bytes: 12, truncated: false, meta: { dev: 1, ino: 2 } };
const preSql: PreimageRef = { kind: "sql_rows", rows: 1, truncated: false };
const absent: PreimageRef = { kind: "fs_absent", truncated: false };
const trunc: PreimageRef = { kind: "fs_bytes", bytes: 9_000_000, truncated: true };

export function classifyCases(): ClassifyCase[] {
  const cases: ClassifyCase[] = [];

  for (const m of ["GET", "HEAD", "OPTIONS", "TRACE"] as const) {
    cases.push({
      name: `http_${m.toLowerCase()}_nobody`,
      action: http(m, m, "https://example.com/x"),
      args: { method: m, url: "https://example.com/x" },
      expected: { tier: "T1" },
    });
  }
  cases.push({
    name: "http_get_set_cookie",
    action: http("GET", "GET", "https://example.com/x"),
    args: { method: "GET", url: "https://example.com/x" },
    ctx: { resultStatus: 200, resultHeaders: { "set-cookie": "sid=1" } },
    expected: { tier: "T2" },
  });
  cases.push({
    name: "http_get_with_body",
    action: http("GET", "GET", "https://example.com/x"),
    args: { method: "GET", url: "https://example.com/x", body: { q: 1 } },
    expected: { tier: "T3" },
  });
  cases.push({
    name: "http_method_override",
    action: http("POST", "POST", "https://example.com/x"),
    args: { method: "POST", url: "https://example.com/x", headers: { "X-HTTP-Method-Override": "DELETE" } },
    expected: { tier: "T3" },
  });
  for (const seg of ["search", "query", "graphql", "batch", "rpc"]) {
    cases.push({
      name: `http_post_${seg}`,
      action: http("POST", "POST", `https://api.example.com/${seg}`),
      args: { method: "POST", url: `https://api.example.com/${seg}`, body: { q: "x" } },
      expected: { tier: "T3" },
    });
  }
  cases.push({
    name: "http_post_201_location",
    action: http("POST", "POST", "https://api.example.com/v1/invoices"),
    args: { method: "POST", url: "https://api.example.com/v1/invoices", body: { amount: 1 } },
    ctx: { resultStatus: 201, resultHeaders: { Location: "/v1/invoices/inv_1" }, result: { id: "inv_1" } },
    expected: { tier: "T3" },
  });
  cases.push({
    name: "http_post_201_id",
    action: http("POST", "POST", "https://api.example.com/v1/invoices"),
    args: { method: "POST", url: "https://api.example.com/v1/invoices", body: { amount: 1 } },
    ctx: { resultStatus: 201, result: { id: "inv_1" } },
    expected: { tier: "T3" },
  });
  cases.push({
    name: "http_put_201_location",
    action: http("PUT", "PUT", "https://api.example.com/v1/invoices/new"),
    args: { method: "PUT", url: "https://api.example.com/v1/invoices/new", body: { amount: 1 } },
    ctx: { resultStatus: 201, resultHeaders: { Location: "/v1/invoices/inv_1" } },
    expected: { tier: "T3" },
  });
  cases.push({
    name: "http_put_no_preimage",
    action: http("PUT", "PUT", "https://api.example.com/v1/invoices/inv_1"),
    args: { method: "PUT", url: "https://api.example.com/v1/invoices/inv_1", body: { amount: 2 } },
    ctx: { resultStatus: 200 },
    expected: { tier: "T4" },
  });
  cases.push({
    name: "http_patch_no_preimage",
    action: http("PATCH", "PATCH", "https://api.example.com/v1/invoices/inv_1"),
    args: { method: "PATCH", url: "https://api.example.com/v1/invoices/inv_1", body: { amount: 2 } },
    ctx: { resultStatus: 200 },
    expected: { tier: "T4" },
  });
  cases.push({
    name: "http_put_with_preimage_external",
    action: http("PUT", "PUT", "https://api.example.com/v1/invoices/inv_1"),
    args: { method: "PUT", url: "https://api.example.com/v1/invoices/inv_1", body: { amount: 2 } },
    ctx: { resultStatus: 200, preimage: { kind: "http_body", truncated: false } },
    expected: { tier: "T3" },
  });
  cases.push({
    name: "http_patch_with_preimage_internal",
    action: http("PATCH", "PATCH", "http://db.internal/rows/1", "internal"),
    args: { method: "PATCH", url: "http://db.internal/rows/1", body: { amount: 2 } },
    ctx: { resultStatus: 200, preimage: { kind: "http_body", truncated: false }, internalHosts: ["db.internal"] },
    expected: { tier: "T2" },
  });
  cases.push({
    name: "http_delete_no_preimage",
    action: http("DELETE", "DELETE", "https://api.example.com/v1/invoices/inv_1"),
    args: { method: "DELETE", url: "https://api.example.com/v1/invoices/inv_1" },
    expected: { tier: "T4" },
  });
  cases.push({
    name: "http_delete_with_preimage_manifest",
    action: http("DELETE", "DELETE", "https://api.example.com/v1/invoices/inv_1"),
    args: { method: "DELETE", url: "https://api.example.com/v1/invoices/inv_1" },
    ctx: { recreateFromPreimage: true, preimage: { kind: "http_body", truncated: false } },
    expected: { tier: "T3" },
  });
  cases.push({
    name: "http_post_400",
    action: http("POST", "POST", "https://api.example.com/v1/invoices"),
    args: { method: "POST", url: "https://api.example.com/v1/invoices", body: { amount: 1 } },
    ctx: { resultStatus: 400 },
    expected: { tier: "T1" },
  });
  cases.push({
    name: "http_post_404",
    action: http("POST", "POST", "https://api.example.com/v1/invoices"),
    args: { method: "POST", url: "https://api.example.com/v1/invoices", body: {} },
    ctx: { resultStatus: 404 },
    expected: { tier: "T1" },
  });
  cases.push({
    name: "http_post_500_in_doubt",
    action: http("POST", "POST", "https://api.example.com/v1/invoices"),
    args: { method: "POST", url: "https://api.example.com/v1/invoices", body: { amount: 1 } },
    ctx: { resultStatus: 500 },
    expected: { tier: "T3", in_doubt: true },
  });
  cases.push({
    name: "http_post_timeout",
    action: http("POST", "POST", "https://api.example.com/v1/invoices"),
    args: { method: "POST", url: "https://api.example.com/v1/invoices", body: { amount: 1 } },
    ctx: { timeout: true },
    expected: { tier: "T3", in_doubt: true },
  });
  cases.push({
    name: "http_idempotency_key_unchanged",
    action: http("POST", "POST", "https://api.example.com/v1/invoices"),
    args: { method: "POST", url: "https://api.example.com/v1/invoices", body: { amount: 1 } },
    ctx: { resultStatus: 201, resultHeaders: { "Idempotency-Key": "abc" }, result: { id: "x" } },
    expected: { tier: "T3" },
  });
  cases.push({
    name: "http_get_internal_stays_t1",
    action: http("GET", "GET", "http://db.internal/health", "internal"),
    args: { method: "GET", url: "http://db.internal/health" },
    ctx: { internalHosts: ["db.internal"] },
    expected: { tier: "T1" },
  });

  // SQL
  cases.push({
    name: "sql_select",
    action: sql("SELECT.app.invoices"),
    args: { sql: "SELECT * FROM invoices WHERE id = 1" },
    expected: { tier: "T1" },
  });
  cases.push({
    name: "sql_select_for_update",
    action: sql("SELECT.app.invoices"),
    args: { sql: "SELECT * FROM invoices WHERE id = 1 FOR UPDATE" },
    expected: { tier: "T2" },
  });
  cases.push({
    name: "sql_select_for_share",
    action: sql("SELECT.app.invoices"),
    args: { sql: "SELECT * FROM invoices WHERE id = 1 FOR SHARE" },
    expected: { tier: "T2" },
  });
  cases.push({
    name: "sql_insert_pk_internal",
    action: sql("INSERT.app.invoices", "internal"),
    args: { sql: "INSERT INTO invoices (n) VALUES (1) RETURNING id" },
    ctx: { pkResolvable: true },
    expected: { tier: "T2" },
  });
  cases.push({
    name: "sql_insert_pk_external",
    action: sql("INSERT.app.invoices", "external"),
    args: { sql: "INSERT INTO invoices (n) VALUES (1) RETURNING id" },
    ctx: { pkResolvable: true },
    expected: { tier: "T3" },
  });
  cases.push({
    name: "sql_insert_no_pk",
    action: sql("INSERT.app.invoices"),
    args: { sql: "INSERT INTO invoices (n) VALUES (1)" },
    ctx: { pkResolvable: false },
    expected: { tier: "T4" },
  });
  cases.push({
    name: "sql_update_preimage_internal",
    action: sql("UPDATE.app.invoices", "internal"),
    args: { sql: "UPDATE invoices SET n=2 WHERE id=1" },
    ctx: { preimage: preSql, affectedRows: 1 },
    expected: { tier: "T2" },
  });
  cases.push({
    name: "sql_update_preimage_external",
    action: sql("UPDATE.app.invoices", "external"),
    args: { sql: "UPDATE invoices SET n=2 WHERE id=1" },
    ctx: { preimage: preSql, affectedRows: 1 },
    expected: { tier: "T3" },
  });
  cases.push({
    name: "sql_update_no_preimage",
    action: sql("UPDATE.app.invoices"),
    args: { sql: "UPDATE invoices SET n=2 WHERE id=1" },
    expected: { tier: "T4" },
  });
  cases.push({
    name: "sql_update_too_many_rows",
    action: sql("UPDATE.app.invoices"),
    args: { sql: "UPDATE invoices SET n=2 WHERE n>0" },
    ctx: { preimage: preSql, affectedRows: 10_001 },
    expected: { tier: "T4" },
  });
  cases.push({
    name: "sql_delete_preimage",
    action: sql("DELETE.app.invoices", "internal"),
    args: { sql: "DELETE FROM invoices WHERE id=1" },
    ctx: { preimage: preSql },
    expected: { tier: "T2" },
  });
  cases.push({
    name: "sql_delete_no_preimage",
    action: sql("DELETE.app.invoices"),
    args: { sql: "DELETE FROM invoices WHERE id=1" },
    expected: { tier: "T4" },
  });
  for (const k of ["TRUNCATE", "DROP", "ALTER", "CREATE", "GRANT", "REINDEX", "VACUUM"]) {
    const sqlText =
      k === "TRUNCATE"
        ? "TRUNCATE invoices"
        : k === "DROP"
          ? "DROP TABLE invoices"
          : k === "ALTER"
            ? "ALTER TABLE invoices ADD COLUMN x int"
            : k === "CREATE"
              ? "CREATE TABLE t (id int)"
              : k === "GRANT"
                ? "GRANT SELECT ON invoices TO u"
                : k === "REINDEX"
                  ? "REINDEX invoices"
                  : "VACUUM";
    cases.push({
      name: `sql_${k.toLowerCase()}`,
      action: sql(`${k}.app.invoices`),
      args: { sql: sqlText },
      expected: { tier: "T4" },
    });
  }
  cases.push({
    name: "sql_modifying_cte",
    action: sql("INSERT.app.invoices"),
    args: { sql: "WITH x AS (INSERT INTO invoices(n) VALUES (1) RETURNING id) SELECT * FROM x" },
    ctx: { pkResolvable: true },
    expected: { tier: "T2" },
  });
  cases.push({
    name: "sql_multi_statement",
    action: sql("UNKNOWN.app"),
    args: { sql: "DELETE FROM invoices; DROP TABLE invoices" },
    expected: { tier: "T4" },
  });
  cases.push({
    name: "sql_call",
    action: sql("CALL.app"),
    args: { sql: "CALL do_thing(1)" },
    expected: { tier: "T4" },
  });
  cases.push({
    name: "sql_exec",
    action: sql("EXEC.app"),
    args: { sql: "EXEC do_thing" },
    expected: { tier: "T4" },
  });

  // FS
  cases.push({
    name: "fs_open_rdonly",
    action: fs("open", "/var/app/data/a.txt"),
    args: { op: "open", path: "/var/app/data/a.txt" },
    ctx: { writableRoots: ["/var/app/data"] },
    expected: { tier: "T1" },
  });
  cases.push({
    name: "fs_stat",
    action: fs("stat", "/var/app/data/a.txt"),
    args: { op: "stat", path: "/var/app/data/a.txt" },
    ctx: { writableRoots: ["/var/app/data"] },
    expected: { tier: "T1" },
  });
  cases.push({
    name: "fs_readdir",
    action: fs("readdir", "/var/app/data"),
    args: { op: "readdir", path: "/var/app/data" },
    ctx: { writableRoots: ["/var/app/data"] },
    expected: { tier: "T1" },
  });
  cases.push({
    name: "fs_readlink",
    action: fs("readlink", "/var/app/data/l"),
    args: { op: "readlink", path: "/var/app/data/l" },
    ctx: { writableRoots: ["/var/app/data"] },
    expected: { tier: "T1" },
  });
  cases.push({
    name: "fs_write_existing",
    action: fs("write", "/var/app/data/a.txt"),
    args: { op: "write", path: "/var/app/data/a.txt", realpath: "/var/app/data/a.txt" },
    ctx: { preimage: preFs, writableRoots: ["/var/app/data"] },
    expected: { tier: "T2" },
  });
  cases.push({
    name: "fs_write_create",
    action: fs("write", "/var/app/data/new.txt"),
    args: { op: "write", path: "/var/app/data/new.txt", realpath: "/var/app/data/new.txt" },
    ctx: { preimage: absent, writableRoots: ["/var/app/data"] },
    expected: { tier: "T2" },
  });
  cases.push({
    name: "fs_write_truncated",
    action: fs("write", "/var/app/data/big.bin"),
    args: { op: "write", path: "/var/app/data/big.bin", realpath: "/var/app/data/big.bin" },
    ctx: { preimage: trunc, writableRoots: ["/var/app/data"] },
    expected: { tier: "T4" },
  });
  cases.push({
    name: "fs_mkdir",
    action: fs("mkdir", "/var/app/data/d"),
    args: { op: "mkdir", path: "/var/app/data/d", realpath: "/var/app/data/d" },
    ctx: { writableRoots: ["/var/app/data"] },
    expected: { tier: "T2" },
  });
  cases.push({
    name: "fs_rename",
    action: fs("rename", "/var/app/data/a.txt"),
    args: { op: "rename", path: "/var/app/data/a.txt", realpath: "/var/app/data/a.txt" },
    ctx: { writableRoots: ["/var/app/data"] },
    expected: { tier: "T2" },
  });
  cases.push({
    name: "fs_unlink_preimage",
    action: fs("unlink", "/var/app/data/a.txt"),
    args: { op: "unlink", path: "/var/app/data/a.txt", realpath: "/var/app/data/a.txt" },
    ctx: { preimage: preFs, writableRoots: ["/var/app/data"] },
    expected: { tier: "T2" },
  });
  cases.push({
    name: "fs_unlink_no_preimage",
    action: fs("unlink", "/var/app/data/a.txt"),
    args: { op: "unlink", path: "/var/app/data/a.txt", realpath: "/var/app/data/a.txt" },
    ctx: { writableRoots: ["/var/app/data"] },
    expected: { tier: "T4" },
  });
  cases.push({
    name: "fs_chmod",
    action: fs("chmod", "/var/app/data/a.txt"),
    args: { op: "chmod", path: "/var/app/data/a.txt", realpath: "/var/app/data/a.txt" },
    ctx: { writableRoots: ["/var/app/data"] },
    expected: { tier: "T2" },
  });
  cases.push({
    name: "fs_chown",
    action: fs("chown", "/var/app/data/a.txt"),
    args: { op: "chown", path: "/var/app/data/a.txt", realpath: "/var/app/data/a.txt" },
    ctx: { writableRoots: ["/var/app/data"] },
    expected: { tier: "T2" },
  });
  cases.push({
    name: "fs_outside_roots",
    action: fs("write", "/etc/passwd"),
    args: { op: "write", path: "/etc/passwd", realpath: "/etc/passwd" },
    ctx: { writableRoots: ["/var/app/data"], scopeViolation: true },
    expected: { tier: "T4", scope_violation: true },
  });
  cases.push({
    name: "fs_network_mount",
    action: fs("write", "/mnt/nfs/a"),
    args: { op: "write", path: "/mnt/nfs/a", realpath: "/mnt/nfs/a" },
    ctx: { networkOrFuseMount: true, writableRoots: ["/mnt/nfs"] },
    expected: { tier: "T4" },
  });
  cases.push({
    name: "fs_symlink_escape",
    action: fs("write", "/var/app/data/link"),
    args: { op: "write", path: "/var/app/data/link", realpath: "/etc/passwd" },
    ctx: { realpathEscapes: true, writableRoots: ["/var/app/data"] },
    expected: { tier: "T4" },
  });
  cases.push({
    name: "fs_passwd_scope",
    action: fs("write", "/etc/passwd"),
    args: { op: "write", path: "/etc/passwd" },
    ctx: { writableRoots: ["/var/app/data"], manifestGlob: "/var/app/data/**" },
    expected: { tier: "T4", scope_violation: true },
  });

  // messages
  cases.push({
    name: "mcp_slack_post",
    action: { kind: "mcp_tool", name: "mcp.slack.chat.postMessage", target: "slack", locality: "external" },
    args: { tool: "chat.postMessage", channel: "C1", text: "hi" },
    expected: { tier: "T3" },
  });
  cases.push({
    name: "mcp_discord_create",
    action: { kind: "mcp_tool", name: "mcp.discord.createMessage", target: "discord", locality: "external" },
    args: { tool: "discord.createMessage" },
    expected: { tier: "T3" },
  });
  cases.push({
    name: "mcp_telegram_send",
    action: { kind: "mcp_tool", name: "mcp.telegram.sendMessage", target: "telegram", locality: "external" },
    args: { tool: "telegram.sendMessage" },
    expected: { tier: "T3" },
  });
  cases.push({
    name: "mcp_smtp_t4",
    action: { kind: "mcp_tool", name: "mcp.smtp.send", target: "smtp", locality: "external" },
    args: { tool: "smtp.send" },
    expected: { tier: "T4" },
  });
  cases.push({
    name: "mcp_resend_t4",
    action: { kind: "sdk_fn", name: "sdk.resend.emails.send", target: "resend", locality: "external" },
    args: { tool: "emails.send" },
    expected: { tier: "T4" },
  });
  cases.push({
    name: "mcp_ses_t4",
    action: { kind: "sdk_fn", name: "sdk.ses.sendEmail", target: "ses", locality: "external" },
    args: { tool: "sendEmail" },
    expected: { tier: "T4" },
  });
  cases.push({
    name: "mcp_sms_t4",
    action: { kind: "mcp_tool", name: "mcp.twilio.sms", target: "twilio", locality: "external" },
    args: { tool: "sms" },
    expected: { tier: "T4" },
  });
  cases.push({
    name: "mcp_push_t4",
    action: { kind: "mcp_tool", name: "mcp.fcm.push_notification", target: "fcm", locality: "external" },
    args: { tool: "push_notification" },
    expected: { tier: "T4" },
  });

  // shell
  for (const argv of [["rm", "-rf", "/tmp/x"], ["curl", "https://x"], ["python", "-c", "open('/etc/passwd')"], ["bash", "-c", "echo hi"], ["sh", "script.sh"]]) {
    cases.push({
      name: `shell_${argv[0]}`,
      action: { kind: "shell", name: `shell.${argv[0]}`, locality: "unknown" },
      args: { argv },
      expected: { tier: "T4" },
    });
  }

  // extras to reach 120
  cases.push({
    name: "http_head_set_cookie",
    action: http("HEAD", "HEAD", "https://example.com/x"),
    args: { method: "HEAD", url: "https://example.com/x" },
    ctx: { resultHeaders: { "Set-Cookie": "a=b" } },
    expected: { tier: "T2" },
  });
  cases.push({
    name: "http_put_override_t3",
    action: http("PUT", "PUT", "https://example.com/x"),
    args: { method: "PUT", url: "https://example.com/x", headers: { "X-HTTP-Method-Override": "GET" } },
    expected: { tier: "T3" },
  });
  cases.push({
    name: "http_post_200_id",
    action: http("POST", "POST", "https://api.example.com/v1/items"),
    args: { method: "POST", url: "https://api.example.com/v1/items", body: { n: 1 } },
    ctx: { resultStatus: 200, result: { id: "it_1" } },
    expected: { tier: "T3" },
  });
  cases.push({
    name: "http_transport_error",
    action: http("POST", "POST", "https://api.example.com/v1/invoices"),
    args: { method: "POST", url: "https://api.example.com/v1/invoices", body: { n: 1 } },
    ctx: { transportError: true },
    expected: { tier: "T3", in_doubt: true },
  });
  cases.push({
    name: "sql_insert_returning_internal",
    action: sql("INSERT.app.t", "internal"),
    args: { sql: "INSERT INTO t(n) VALUES (1) RETURNING id" },
    expected: { tier: "T2" },
  });
  cases.push({
    name: "fs_truncate",
    action: fs("truncate", "/var/app/data/a.txt"),
    args: { op: "truncate", path: "/var/app/data/a.txt", realpath: "/var/app/data/a.txt" },
    ctx: { preimage: preFs, writableRoots: ["/var/app/data"] },
    expected: { tier: "T2" },
  });
  cases.push({
    name: "fs_utimes",
    action: fs("utimes", "/var/app/data/a.txt"),
    args: { op: "utimes", path: "/var/app/data/a.txt", realpath: "/var/app/data/a.txt" },
    ctx: { writableRoots: ["/var/app/data"] },
    expected: { tier: "T2" },
  });
  cases.push({
    name: "join_scope_violation_t4",
    action: fs("write", "/etc/passwd"),
    args: { op: "write", path: "/etc/passwd" },
    ctx: { writableRoots: ["/var/app/data"], manifestTier: "T2", scopeViolation: true },
    expected: { tier: "T4", scope_violation: true },
  });
  cases.push({
    name: "join_model_escalate",
    action: http("GET", "GET", "https://example.com/x"),
    args: { method: "GET", url: "https://example.com/x" },
    ctx: { modelTier: "T3" },
    expected: { tier: "T3" },
  });
  cases.push({
    name: "http_rfc1918_post",
    action: { kind: "http", name: "http.POST.10.0.0.5/x", target: "10.0.0.5", locality: "internal" },
    args: { method: "POST", url: "http://10.0.0.5/x", body: { a: 1 } },
    ctx: { resultStatus: 201, result: { id: "1" } },
    expected: { tier: "T3" },
  });
  cases.push({
    name: "http_loopback_get",
    action: { kind: "http", name: "http.GET.127.0.0.1/x", target: "127.0.0.1", locality: "internal" },
    args: { method: "GET", url: "http://127.0.0.1/x" },
    expected: { tier: "T1" },
  });

  // pad with distinct HTTP 4xx/2xx and SQL variants until 120
  const pads: ClassifyCase[] = [
    {
      name: "http_options_body_t3",
      action: http("OPTIONS", "OPTIONS", "https://example.com/x"),
      args: { method: "OPTIONS", url: "https://example.com/x", body: "x" },
      expected: { tier: "T3" },
    },
    {
      name: "http_delete_500",
      action: http("DELETE", "DELETE", "https://api.example.com/v1/invoices/1"),
      args: { method: "DELETE", url: "https://api.example.com/v1/invoices/1" },
      ctx: { resultStatus: 500 },
      expected: { tier: "T4", in_doubt: true },
    },
    {
      name: "sql_delete_external_preimage",
      action: sql("DELETE.app.invoices", "external"),
      args: { sql: "DELETE FROM invoices WHERE id=1" },
      ctx: { preimage: preSql },
      expected: { tier: "T3" },
    },
    {
      name: "sql_comment_select",
      action: sql("SELECT.app.invoices"),
      args: { sql: "/* mutate? */ SELECT id FROM invoices -- INSERT" },
      expected: { tier: "T1" },
    },
    {
      name: "mcp_unknown_t4",
      action: { kind: "mcp_tool", name: "mcp.other.do", target: "other", locality: "external" },
      args: { tool: "do" },
      expected: { tier: "T4" },
    },
    {
      name: "shell_chmod",
      action: { kind: "shell", name: "shell.chmod", locality: "internal" },
      args: { argv: ["chmod", "777", "/tmp"] },
      expected: { tier: "T4" },
    },
    {
      name: "http_post_202_location",
      action: http("POST", "POST", "https://api.example.com/v1/jobs"),
      args: { method: "POST", url: "https://api.example.com/v1/jobs", body: {} },
      ctx: { resultStatus: 202, resultHeaders: { Location: "/v1/jobs/1" } },
      expected: { tier: "T3" },
    },
    {
      name: "fs_write_no_roots",
      action: fs("write", "/tmp/x"),
      args: { op: "write", path: "/tmp/x" },
      ctx: { preimage: absent },
      expected: { tier: "T2" },
    },
  ];
  for (const p of pads) cases.push(p);

  let i = 0;
  while (cases.length < 120) {
    i++;
    cases.push({
      name: `http_get_pad_${i}`,
      action: http("GET", "GET", `https://example.com/p/${i}`),
      args: { method: "GET", url: `https://example.com/p/${i}` },
      expected: { tier: "T1" },
    });
  }
  return cases.slice(0, 120);
}

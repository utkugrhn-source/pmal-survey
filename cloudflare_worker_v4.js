/**
 * PMAL R2 API Worker — V4
 *
 * Public endpoints (survey):
 *   GET /?prefix=case1/do/       → JSON file list from the DICOM bucket
 *   GET /file/<key>              → proxy a DICOM file from the DICOM bucket
 *   GET /health                  → R2 + Supabase + backup status (no secrets)
 *
 * Admin endpoints (X-Admin-Token header required, never a query parameter):
 *   GET  /admin/responses?<q>    → Supabase responses SELECT
 *   GET  /admin/errors?<q>       → Supabase client_errors SELECT
 *   GET  /admin/feedback?<q>     → Supabase feedback SELECT
 *   GET  /admin/backups          → latest backup, last error, recent history
 *   POST /admin/backups/run      → take a backup now
 *   GET  /admin/backups/file?key=backups/…json → download one backup
 *
 * Scheduled: a daily cron (wrangler.toml) writes a full JSON snapshot of the
 * survey tables to the private BACKUP bucket.
 *
 * Bindings / secrets (wrangler.toml + `wrangler secret put`):
 *   BUCKET                = pm-survey-dicom   (public DICOM files)
 *   BACKUP                = pmal-backup       (private; never served by /file/)
 *   SUPABASE_SERVICE_KEY  = secret
 *   ADMIN_TOKEN           = secret
 * The admin endpoints and backups refuse to run without these; there are no
 * fallbacks, so a missing secret fails loudly instead of returning empty data.
 */

const SB_URL = "https://ozltzozlnfpqhgviidvc.supabase.co";

const BACKUP_TABLES = ["responses", "client_errors", "mailing_list", "feedback"];
const BACKUP_STALE_HOURS = 72;
const PAGE_SIZE = 1000;

const ADMIN_ORIGINS = [
  "https://pmal-survey.vercel.app",
  "https://pmalsurvey.org",
  "https://www.pmalsurvey.org",
  "http://localhost:3000",
  "http://localhost:8080",
];

const corsHeaders = (origin) => ({
  "Access-Control-Allow-Origin": ADMIN_ORIGINS.includes(origin) ? origin : "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range",
  "Access-Control-Expose-Headers": "Content-Length, Content-Type, Content-Range, Accept-Ranges, ETag",
});

const adminCorsHeaders = (origin) => ({
  "Access-Control-Allow-Origin": ADMIN_ORIGINS.includes(origin) ? origin : ADMIN_ORIGINS[0],
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
  "Access-Control-Expose-Headers": "Content-Disposition",
  "Vary": "Origin",
});

const json = (obj, status, headers) =>
  new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...headers },
  });

// Constant-time comparison so the token can't be guessed byte by byte.
function tokenMatches(got, expected) {
  if (typeof got !== "string" || typeof expected !== "string") return false;
  const a = new TextEncoder().encode(got);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a[i] || 0) ^ (b[i] || 0);
  }
  return diff === 0;
}

const sbHeaders = (env, extra) => ({
  "apikey": env.SUPABASE_SERVICE_KEY,
  "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`,
  ...extra,
});

// ── Backup ──

// Read every row of a table, page by page, and check the row count against
// the total PostgREST reports so a truncated read is never saved as complete.
async function fetchTable(env, table) {
  const rows = [];
  let total = null;
  let order = "&order=created_at.asc";
  for (let from = 0; ; from += PAGE_SIZE) {
    const url = `${SB_URL}/rest/v1/${table}?select=*${order}`;
    let r = await fetch(url, {
      headers: sbHeaders(env, {
        "Range-Unit": "items",
        "Range": `${from}-${from + PAGE_SIZE - 1}`,
        "Prefer": "count=exact",
      }),
    });
    if (r.status === 400 && order) {
      // Table has no created_at column: fall back to the default order.
      order = "";
      from -= PAGE_SIZE;
      continue;
    }
    if (r.status === 416) break; // asked past the end of an exactly-sized table
    if (!r.ok) throw new Error(`${table}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    const page = await r.json();
    const m = (r.headers.get("Content-Range") || "").match(/\/(\d+)$/);
    if (m) total = parseInt(m[1], 10);
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  if (total !== null && rows.length !== total) {
    throw new Error(`${table}: read ${rows.length} rows but the table reports ${total}`);
  }
  return rows;
}

async function readJson(bucket, key) {
  const obj = await bucket.get(key);
  return obj ? await obj.json() : null;
}

async function runBackup(env, trigger) {
  const started = new Date();
  try {
    if (!env.BACKUP) throw new Error("BACKUP bucket binding is missing");
    if (!env.SUPABASE_SERVICE_KEY) throw new Error("SUPABASE_SERVICE_KEY secret is missing");

    const tables = {};
    const counts = {};
    for (const t of BACKUP_TABLES) {
      tables[t] = await fetchTable(env, t);
      counts[t] = tables[t].length;
    }

    // Survey rows are never deleted, so fewer responses than last time means
    // something is wrong with the read (e.g. wrong key, RLS) — don't save it.
    const prev = await readJson(env.BACKUP, "latest.json");
    if (prev && prev.counts && counts.responses < prev.counts.responses) {
      throw new Error(
        `responses dropped from ${prev.counts.responses} to ${counts.responses}; backup not saved`
      );
    }

    const iso = started.toISOString();
    const key = `backups/${iso.slice(0, 10)}/${iso.slice(11, 19).replace(/:/g, "")}.json`;
    const body = JSON.stringify({ version: 1, created_at: iso, trigger, counts, tables });
    await env.BACKUP.put(key, body, { httpMetadata: { contentType: "application/json" } });

    const meta = { created_at: iso, trigger, key, bytes: body.length, counts };
    await env.BACKUP.put("latest.json", JSON.stringify(meta), {
      httpMetadata: { contentType: "application/json" },
    });
    await env.BACKUP.delete("last_error.json");
    return { ok: true, ...meta };
  } catch (e) {
    const err = { at: started.toISOString(), trigger, error: String((e && e.message) || e) };
    if (env.BACKUP) {
      await env.BACKUP.put("last_error.json", JSON.stringify(err), {
        httpMetadata: { contentType: "application/json" },
      });
    }
    return { ok: false, ...err };
  }
}

async function backupStatus(env) {
  const latest = await readJson(env.BACKUP, "latest.json");
  const lastError = await readJson(env.BACKUP, "last_error.json");
  const listed = await env.BACKUP.list({ prefix: "backups/" });
  let objects = listed.objects;
  let cursor = listed.truncated ? listed.cursor : null;
  while (cursor) {
    const more = await env.BACKUP.list({ prefix: "backups/", cursor });
    objects = objects.concat(more.objects);
    cursor = more.truncated ? more.cursor : null;
  }
  const history = objects
    .map((o) => ({ key: o.key, bytes: o.size, uploaded: o.uploaded }))
    .sort((a, b) => (a.key < b.key ? 1 : -1));
  const ageHours = latest ? (Date.now() - Date.parse(latest.created_at)) / 3600000 : null;
  return {
    latest,
    last_error: lastError,
    stale: ageHours === null || ageHours > BACKUP_STALE_HOURS,
    age_hours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
    total: history.length,
    history: history.slice(0, 60),
  };
}

// ── Router ──

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const isAdmin = url.pathname.startsWith("/admin/");

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: isAdmin ? adminCorsHeaders(origin) : corsHeaders(origin),
      });
    }

    // ── /health — reachability + configuration (never secret values) ──
    if (url.pathname === "/health") {
      const out = { worker: "ok", ts: new Date().toISOString() };
      try {
        const l = await env.BUCKET.list({ limit: 1 });
        out.r2 = l && Array.isArray(l.objects) ? "ok" : "unexpected";
      } catch (e) {
        out.r2 = "fail: " + e.message;
      }
      out.serviceKey = env.SUPABASE_SERVICE_KEY ? "configured" : "MISSING";
      out.adminToken = env.ADMIN_TOKEN ? "configured" : "MISSING";
      if (env.SUPABASE_SERVICE_KEY) {
        try {
          const r = await fetch(SB_URL + "/rest/v1/responses?select=id&limit=1", {
            headers: sbHeaders(env),
          });
          out.supabase = r.ok ? "ok" : "http " + r.status;
        } catch (e) {
          out.supabase = "fail: " + e.message;
        }
      } else {
        out.supabase = "no service key";
      }
      if (env.BACKUP) {
        try {
          const latest = await readJson(env.BACKUP, "latest.json");
          const age = latest ? (Date.now() - Date.parse(latest.created_at)) / 3600000 : null;
          out.backup = age === null ? "none" : age > BACKUP_STALE_HOURS ? "stale" : "ok";
        } catch (e) {
          out.backup = "fail: " + e.message;
        }
      } else {
        out.backup = "no bucket";
      }
      return json(out, 200, corsHeaders(origin));
    }

    // ── /admin/* — token-gated ──
    if (isAdmin) {
      const h = adminCorsHeaders(origin);
      if (!env.ADMIN_TOKEN) return new Response("Admin token not configured", { status: 503, headers: h });
      if (!tokenMatches(request.headers.get("X-Admin-Token") || "", env.ADMIN_TOKEN)) {
        return new Response("Forbidden", { status: 403, headers: h });
      }

      if (url.pathname === "/admin/backups" && request.method === "GET") {
        if (!env.BACKUP) return new Response("BACKUP bucket not configured", { status: 503, headers: h });
        return json(await backupStatus(env), 200, h);
      }
      if (url.pathname === "/admin/backups/run" && request.method === "POST") {
        const result = await runBackup(env, "manual");
        return json(result, result.ok ? 200 : 500, h);
      }
      if (url.pathname === "/admin/backups/file" && request.method === "GET") {
        const key = url.searchParams.get("key") || "";
        if (!/^backups\/\d{4}-\d{2}-\d{2}\/\d{6}\.json$/.test(key)) {
          return new Response("Bad key", { status: 400, headers: h });
        }
        const obj = env.BACKUP && (await env.BACKUP.get(key));
        if (!obj) return new Response("Not Found", { status: 404, headers: h });
        const name = "pmal_yedek_" + key.slice(8).replace("/", "_");
        return new Response(obj.body, {
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition": `attachment; filename="${name}"`,
            ...h,
          },
        });
      }

      const tables = { "/admin/responses": "responses", "/admin/errors": "client_errors", "/admin/feedback": "feedback" };
      const table = tables[url.pathname];
      if (table && request.method === "GET") {
        if (!env.SUPABASE_SERVICE_KEY) {
          return new Response("Supabase service key not configured", { status: 503, headers: h });
        }
        try {
          const r = await fetch(`${SB_URL}/rest/v1/${table}?${url.searchParams.toString()}`, {
            headers: sbHeaders(env),
          });
          return new Response(await r.text(), {
            status: r.status,
            headers: { "Content-Type": "application/json", ...h },
          });
        } catch (e) {
          return new Response("Proxy error: " + e.message, { status: 502, headers: h });
        }
      }
      return new Response("Not Found", { status: 404, headers: h });
    }

    // The public routes below are read-only.
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: corsHeaders(origin) });
    }

    // ── /file/<key> — proxy DICOM file from R2 ──
    if (url.pathname.startsWith("/file/")) {
      const key = url.pathname.slice("/file/".length);
      if (!key) {
        return new Response("Missing key", { status: 400, headers: corsHeaders(origin) });
      }
      try {
        // Only honor Range if the client sent it: some viewers (Cornerstone
        // WADO loader) choke on 206 responses they never asked for.
        const rangeHeader = request.headers.get("Range");
        const r2Options = {};
        let isRangeRequest = false;
        if (rangeHeader) {
          const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
          if (m) {
            const offset = parseInt(m[1], 10);
            const length = m[2] ? parseInt(m[2], 10) - offset + 1 : undefined;
            r2Options.range = length !== undefined ? { offset, length } : { offset };
            isRangeRequest = true;
          }
        }

        const obj = await env.BUCKET.get(key, r2Options);
        if (!obj) {
          return new Response("Not Found", { status: 404, headers: corsHeaders(origin) });
        }

        const headers = new Headers(corsHeaders(origin));
        headers.set("Content-Type", "application/dicom");
        headers.set("ETag", obj.httpEtag);
        headers.set("Accept-Ranges", "bytes");
        headers.set("Cache-Control", "public, max-age=3600");

        if (isRangeRequest && obj.range) {
          const start = obj.range.offset || 0;
          const len = obj.range.length !== undefined ? obj.range.length : obj.size - start;
          headers.set("Content-Length", String(len));
          headers.set("Content-Range", `bytes ${start}-${start + len - 1}/${obj.size}`);
          return new Response(obj.body, { status: 206, headers });
        }

        headers.set("Content-Length", obj.size.toString());
        return new Response(obj.body, { status: 200, headers });
      } catch (e) {
        return new Response("Server error: " + e.message, { status: 500, headers: corsHeaders(origin) });
      }
    }

    // ── /?prefix=... — list DICOM files ──
    const prefix = url.searchParams.get("prefix") || "";
    try {
      const files = [];
      let cursor = undefined;
      let truncated = true;
      while (truncated) {
        const result = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
        for (const obj of result.objects) files.push({ key: obj.key, size: obj.size });
        truncated = result.truncated;
        cursor = result.cursor;
      }
      return json({ prefix, count: files.length, files }, 200, corsHeaders(origin));
    } catch (e) {
      return new Response("List error: " + e.message, { status: 500, headers: corsHeaders(origin) });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBackup(env, "cron"));
  },
};

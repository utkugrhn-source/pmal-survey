/**
 * PMAL R2 API Worker — V3
 *
 * Endpoints:
 *   GET /?prefix=case1/do/       → JSON file list from R2 (existing)
 *   GET /file/<key>              → proxy a DICOM file from R2 (existing)
 *   GET /admin/responses?<query> → proxy Supabase responses SELECT (NEW)
 *   GET /admin/errors?<query>    → proxy Supabase client_errors SELECT (NEW)
 *   GET /health                  → health check for R2 + Supabase (NEW)
 *
 * The /admin/* endpoints exist because direct anon-key SELECT on the
 * responses table has been revoked (RLS) so survey data is no longer
 * publicly downloadable via the standard Supabase REST path. The worker
 * reads with the service-role key stored as a secret and requires a
 * shared token from the admin panel.
 *
 * REQUIRED SETUP (Cloudflare Dashboard → Worker → Settings):
 *   Bindings:  BUCKET = pm-survey-dicom            (already set)
 *   Secrets:   SUPABASE_SERVICE_KEY = <service_role key from Supabase
 *              Dashboard → Project Settings → API → service_role>
 *   Variables: ADMIN_TOKEN = pmal-ctrl-2026        (plain text var is fine)
 *
 * If SUPABASE_SERVICE_KEY is not set, /admin/* falls back to the anon key
 * (works only until the RLS migration revokes anon SELECT).
 */

const SB_URL = "https://ozltzozlnfpqhgviidvc.supabase.co";
const SB_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im96bHR6b3psbmZwcWhndmlpZHZjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNjY0OTMsImV4cCI6MjA5MTg0MjQ5M30.L3RZdu4lLqnPaXKGPyXsoYYQI53Lcv9B3bTYFsT5CVQ";
const ADMIN_TOKEN_FALLBACK = "pmal-ctrl-2026";

const ALLOWED_ORIGINS = [
  "https://pmal-survey.vercel.app",
  "http://localhost:3000",
  "http://localhost:8080",
];

const corsHeaders = (origin) => ({
  "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range, X-Admin-Token",
  "Access-Control-Expose-Headers": "Content-Length, Content-Type, Content-Range, Accept-Ranges, ETag",
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // ── ROUTE: /health — check R2 + Supabase reachability ──
    if (url.pathname === "/health") {
      const out = { worker: "ok", ts: new Date().toISOString() };
      try {
        const l = await env.BUCKET.list({ limit: 1 });
        out.r2 = l && Array.isArray(l.objects) ? "ok" : "unexpected";
      } catch (e) {
        out.r2 = "fail: " + e.message;
      }
      // Report whether the service-role secret is configured (never its value)
      out.serviceKey = env.SUPABASE_SERVICE_KEY ? "configured" : "MISSING";
      try {
        const key = env.SUPABASE_SERVICE_KEY || SB_ANON_KEY;
        const r = await fetch(SB_URL + "/rest/v1/responses?select=id&limit=1", {
          headers: { "apikey": key, "Authorization": "Bearer " + key },
        });
        out.supabase = r.ok ? "ok" : "http " + r.status;
      } catch (e) {
        out.supabase = "fail: " + e.message;
      }
      return new Response(JSON.stringify(out), {
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    // ── ROUTE: /admin/<table> — proxied Supabase SELECT for the admin panel ──
    if (url.pathname === "/admin/responses" || url.pathname === "/admin/errors" || url.pathname === "/admin/feedback") {
      const expected = (env.ADMIN_TOKEN || ADMIN_TOKEN_FALLBACK);
      const got = request.headers.get("X-Admin-Token") || url.searchParams.get("token") || "";
      if (got !== expected) {
        return new Response("Forbidden", { status: 403, headers: corsHeaders(origin) });
      }
      const table = url.pathname === "/admin/responses" ? "responses"
                  : url.pathname === "/admin/errors" ? "client_errors"
                  : "feedback";
      // Forward the query string minus our token param
      url.searchParams.delete("token");
      const qs = url.searchParams.toString();
      const key = env.SUPABASE_SERVICE_KEY || SB_ANON_KEY;
      try {
        const r = await fetch(`${SB_URL}/rest/v1/${table}?${qs}`, {
          headers: {
            "apikey": key,
            "Authorization": `Bearer ${key}`,
            "Prefer": "return=representation",
          },
        });
        const body = await r.text();
        return new Response(body, {
          status: r.status,
          headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
        });
      } catch (e) {
        return new Response("Proxy error: " + e.message, {
          status: 502,
          headers: corsHeaders(origin),
        });
      }
    }

    // ── ROUTE: /file/<key> — proxy DICOM file from R2 ──
    if (url.pathname.startsWith("/file/")) {
      const key = url.pathname.slice("/file/".length);
      if (!key) {
        return new Response("Missing key", { status: 400, headers: corsHeaders(origin) });
      }

      try {
        // Only honor Range if client explicitly sent the header.
        // Some viewers (Cornerstone WADO loader) choke on 206 responses
        // when they never asked for a partial body.
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
        headers.set("Content-Length", obj.size.toString());
        headers.set("ETag", obj.httpEtag);
        headers.set("Accept-Ranges", "bytes");
        headers.set("Cache-Control", "public, max-age=3600");

        if (isRangeRequest && obj.range) {
          headers.set(
            "Content-Range",
            `bytes ${obj.range.offset}-${obj.range.offset + obj.range.length - 1}/${obj.size}`
          );
          return new Response(obj.body, { status: 206, headers });
        }

        return new Response(obj.body, { status: 200, headers });
      } catch (e) {
        return new Response("Server error: " + e.message, {
          status: 500,
          headers: corsHeaders(origin),
        });
      }
    }

    // ── ROUTE: /?prefix=... — list files ──
    const prefix = url.searchParams.get("prefix") || "";

    try {
      const files = [];
      let cursor = undefined;
      let truncated = true;
      while (truncated) {
        const result = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
        for (const obj of result.objects) {
          files.push({ key: obj.key, size: obj.size });
        }
        truncated = result.truncated;
        cursor = result.cursor;
      }

      return new Response(
        JSON.stringify({ prefix, count: files.length, files }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders(origin),
          },
        }
      );
    } catch (e) {
      return new Response("List error: " + e.message, {
        status: 500,
        headers: corsHeaders(origin),
      });
    }
  },
};

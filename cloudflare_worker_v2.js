/**
 * PMAL R2 API Worker — V2
 *
 * Two endpoints:
 *   GET /?prefix=case1/do/    → JSON file list (existing behavior)
 *   GET /file/case1/do/abc.dcm → proxy the DICOM file from R2
 *
 * The proxy endpoint exists because some ISPs (e.g. several in Turkey)
 * block the public r2.dev subdomain. Routing files through the worker's
 * own domain (workers.dev) avoids that block since R2 binding is internal.
 *
 * Bucket binding required (Cloudflare Dashboard → Worker → Settings → Variables):
 *   BUCKET = pm-survey-dicom
 */

const ALLOWED_ORIGINS = [
  "https://pmal-survey.vercel.app",
  "http://localhost:3000",
  "http://localhost:8080",
];

const corsHeaders = (origin) => ({
  "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range",
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

    // ── ROUTE 1: /file/<key> — proxy DICOM file from R2 ──
    if (url.pathname.startsWith("/file/")) {
      const key = url.pathname.slice("/file/".length);
      if (!key) {
        return new Response("Missing key", { status: 400, headers: corsHeaders(origin) });
      }

      try {
        // Support HTTP Range requests for partial downloads (some viewers use this)
        const rangeHeader = request.headers.get("Range");
        const r2Options = {};
        if (rangeHeader) {
          const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
          if (m) {
            const offset = parseInt(m[1], 10);
            const length = m[2] ? parseInt(m[2], 10) - offset + 1 : undefined;
            r2Options.range = length !== undefined ? { offset, length } : { offset };
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

        if (obj.range) {
          headers.set(
            "Content-Range",
            `bytes ${obj.range.offset}-${obj.range.offset + obj.range.length - 1}/${obj.size}`
          );
          return new Response(obj.body, { status: 206, headers });
        }

        return new Response(obj.body, { headers });
      } catch (e) {
        return new Response("Server error: " + e.message, {
          status: 500,
          headers: corsHeaders(origin),
        });
      }
    }

    // ── ROUTE 2: /?prefix=... — list files ──
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

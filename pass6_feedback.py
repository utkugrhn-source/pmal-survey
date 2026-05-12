#!/usr/bin/env python3
"""Implement feedback submission: stateful CommentBox + global submit + Supabase + mailto."""
from pathlib import Path

p = Path("/home/claude/pmal-work/admin.html")
text = p.read_text()
orig_size = len(text)


# ───────────────────────────────────────────────────────────────
# 1. Pass user prop to FeedPage so we know who submitted
# ───────────────────────────────────────────────────────────────
old_feedpage_render = '''    feedback: /*#__PURE__*/React.createElement(FeedPage, null),'''
new_feedpage_render = '''    feedback: /*#__PURE__*/React.createElement(FeedPage, { user }),'''
assert old_feedpage_render in text, "FeedPage render not found"
text = text.replace(old_feedpage_render, new_feedpage_render)
print("✓ 1/4: FeedPage now receives user prop")


# ───────────────────────────────────────────────────────────────
# 2. Replace CommentBox — stateful, controlled, syncs to parent
# ───────────────────────────────────────────────────────────────
old_commentbox = '''function CommentBox({
  qid,
  openId,
  setOpenId
}) {
  const isOpen = openId === qid;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 6
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setOpenId(isOpen ? null : qid),
    style: {
      padding: "3px 10px",
      borderRadius: 5,
      border: `1px solid ${TH.br}`,
      background: isOpen ? `${TH.ac}22` : "transparent",
      color: isOpen ? TH.ac : TH.td,
      fontSize: 10,
      cursor: "pointer"
    }
  }, "\\uD83D\\uDCAC ", isOpen ? "Kapat" : "Yorum ekle"), isOpen && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 6,
      display: "flex",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "text",
    placeholder: "Yorumunuzu yaz\\u0131n...",
    style: {
      flex: 1,
      padding: "7px 10px",
      borderRadius: 5,
      border: `1px solid ${TH.br}`,
      background: TH.bg,
      color: TH.tx,
      fontSize: 10,
      outline: "none"
    }
  }), /*#__PURE__*/React.createElement("button", {
    style: {
      padding: "7px 12px",
      borderRadius: 5,
      border: "none",
      background: TH.ac,
      color: "#fff",
      fontSize: 10,
      fontWeight: 600,
      cursor: "pointer",
      whiteSpace: "nowrap"
    }
  }, "Kaydet")));
}'''

new_commentbox = '''function CommentBox({
  qid,
  openId,
  setOpenId,
  comments,
  setComments
}) {
  const isOpen = openId === qid;
  const existing = comments[qid] || "";
  const hasComment = existing.trim().length > 0;
  const update = (v) => {
    const next = { ...comments };
    if (v.trim().length === 0) {
      delete next[qid];
    } else {
      next[qid] = v;
    }
    setComments(next);
  };
  const remove = () => {
    const next = { ...comments };
    delete next[qid];
    setComments(next);
    setOpenId(null);
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 6
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setOpenId(isOpen ? null : qid),
    style: {
      padding: "3px 10px",
      borderRadius: 5,
      border: `1px solid ${hasComment ? TH.ac : TH.br}`,
      background: isOpen ? `${TH.ac}22` : hasComment ? `${TH.ac}11` : "transparent",
      color: isOpen || hasComment ? TH.ac : TH.td,
      fontSize: 10,
      cursor: "pointer"
    }
  }, "\\uD83D\\uDCAC ", isOpen ? "Kapat" : hasComment ? `Yorum (${existing.length} karakter)` : "Yorum ekle"), isOpen && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 6,
      display: "flex",
      gap: 6,
      flexDirection: "column"
    }
  }, /*#__PURE__*/React.createElement("textarea", {
    value: existing,
    onChange: (e) => update(e.target.value),
    placeholder: "Yorumunuzu yazın...",
    rows: 3,
    style: {
      width: "100%",
      padding: "8px 10px",
      borderRadius: 5,
      border: `1px solid ${TH.br}`,
      background: TH.bg,
      color: TH.tx,
      fontSize: 11,
      outline: "none",
      resize: "vertical",
      fontFamily: "inherit",
      boxSizing: "border-box"
    }
  }), hasComment && /*#__PURE__*/React.createElement("button", {
    onClick: remove,
    style: {
      alignSelf: "flex-end",
      padding: "4px 10px",
      borderRadius: 5,
      border: `1px solid ${TH.br}`,
      background: "transparent",
      color: TH.td,
      fontSize: 10,
      cursor: "pointer"
    }
  }, "Yorumu sil")));
}'''

assert old_commentbox in text, "CommentBox marker not found"
text = text.replace(old_commentbox, new_commentbox)
print("✓ 2/4: CommentBox stateful, controlled, with delete button")


# ───────────────────────────────────────────────────────────────
# 3. FeedPage signature + state + submission logic
# ───────────────────────────────────────────────────────────────
old_feedpage_header = '''function FeedPage() {
  const [openId, setOpenId] = useState(null);
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h3", {
    style: {
      color: TH.tx,
      fontSize: 15,
      fontWeight: 600,
      margin: "0 0 6px"
    }
  }, "Geri Bildirim Paneli"), /*#__PURE__*/React.createElement("p", {
    style: {
      color: TH.tm,
      fontSize: 12,
      margin: "0 0 18px"
    }
  }, "Anketin tam kopyas\\u0131. Her sorunun alt\\u0131ndaki yorum butonuyla geri bildirim b\\u0131rakabilirsiniz."),'''

new_feedpage_header = '''function FeedPage({ user }) {
  const [openId, setOpenId] = useState(null);
  // comments: { qid: "yorum metni", ... }
  const [comments, setComments] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState(null); // null | 'ok' | 'err'

  const commentCount = Object.keys(comments).length;

  // Build qid → { qtext, section } lookup once
  const qInfo = {};
  FB_SECTIONS.forEach(sec => {
    sec.questions.forEach(q => {
      qInfo[q.id] = { qtext: q.text, section: sec.title };
    });
  });

  const handleSubmit = async () => {
    if (commentCount === 0) return;
    setSubmitting(true);
    setSubmitStatus(null);

    // Build the comment payload — array of { qid, qtext, section, comment }
    const payload = Object.entries(comments).map(([qid, comment]) => ({
      qid,
      qtext: qInfo[qid]?.qtext || qid,
      section: qInfo[qid]?.section || "",
      comment
    }));

    let supabaseOk = false;
    try {
      const res = await sbFetch("feedback", "POST", {
        researcher_id: user?.id || null,
        researcher_name: user?.name || null,
        comments: payload,
        comment_count: commentCount,
        user_agent: navigator.userAgent
      });
      supabaseOk = res && res.ok;
      if (!supabaseOk) {
        console.error("Supabase feedback insert failed:", res?.status, await res?.text?.());
      }
    } catch (e) {
      console.error("Supabase feedback error:", e);
    }

    // Build mailto body — formatted comments
    const lines = [
      `PMAL Anket Geri Bildirimi`,
      `Gönderen: ${user?.name || "Bilinmiyor"} (${user?.id || "?"})`,
      `Tarih: ${new Date().toLocaleString("tr-TR")}`,
      `Toplam yorum: ${commentCount}`,
      `Supabase kayıt: ${supabaseOk ? "Başarılı" : "BAŞARISIZ — bu mail yoksa veri kaybolur"}`,
      ``,
      `${"=".repeat(50)}`,
      ``,
    ];
    payload.forEach((c, i) => {
      lines.push(`[${i + 1}] ${c.section}`);
      lines.push(`Soru (${c.qid}): ${c.qtext}`);
      lines.push(`Yorum: ${c.comment}`);
      lines.push("");
    });

    const subject = encodeURIComponent(`PMAL Geri Bildirim — ${user?.name || "?"} — ${commentCount} yorum`);
    const body = encodeURIComponent(lines.join("\\n"));
    const mailto = `mailto:utkugrhn@gmail.com?subject=${subject}&body=${body}`;

    // Trigger the mailto link
    window.location.href = mailto;

    setSubmitting(false);
    setSubmitStatus(supabaseOk ? "ok" : "partial");
  };

  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h3", {
    style: {
      color: TH.tx,
      fontSize: 15,
      fontWeight: 600,
      margin: "0 0 6px"
    }
  }, "Geri Bildirim Paneli"), /*#__PURE__*/React.createElement("p", {
    style: {
      color: TH.tm,
      fontSize: 12,
      margin: "0 0 18px"
    }
  }, "Anketin tam kopyas\u0131. Her sorunun alt\u0131ndaki yorum butonuyla geri bildirim b\u0131rakabilirsiniz. Hepsini bitirince en alttaki \"T\u00fcm yorumlar\u0131 g\u00f6nder\" butonuna bas\u0131n."),'''

assert old_feedpage_header in text, "FeedPage header marker not found"
text = text.replace(old_feedpage_header, new_feedpage_header)
print("✓ 3a/4: FeedPage signature + state + handleSubmit added")


# ───────────────────────────────────────────────────────────────
# 4. Find all CommentBox usages inside FeedPage and pass comments+setComments
# ───────────────────────────────────────────────────────────────
# Locate every React.createElement(CommentBox, { qid: ..., openId, setOpenId }) call
# and inject comments, setComments props.

import re
pattern = re.compile(
    r'(React\.createElement\(CommentBox,\s*\{\s*qid:\s*[^,}]+,\s*openId:\s*openId,\s*setOpenId:\s*setOpenId)(\s*\}\))',
    re.MULTILINE
)

count_before = len(pattern.findall(text))
text = pattern.sub(
    r'\1, comments: comments, setComments: setComments\2',
    text
)
count_after = len(re.findall(
    r'React\.createElement\(CommentBox,\s*\{[^}]*comments:\s*comments[^}]*\}\)',
    text
))
print(f"✓ 3b/4: CommentBox usage updated — {count_before} matches before, {count_after} with new props after")
if count_before == 0:
    print("⚠ No CommentBox usages found — may need different pattern")


# ───────────────────────────────────────────────────────────────
# 5. Add the "Tüm yorumları gönder" button at the bottom of FeedPage
# Find the closing of FeedPage render — currently ends with FB_SECTIONS.map(...).
# Add a footer with the submit button after the map but inside the wrapping div.
# ───────────────────────────────────────────────────────────────
# Best approach: find the very last "})))" or similar at end of FeedPage and inject before it.
# Actually the FB_SECTIONS.map(sec => ...) is followed by ); closing the outer
# React.createElement("div", null, ...). We need to inject a comma + new child before that ).

# Find the end of FeedPage function - look for the unique closing pattern
# FeedPage ends with ");\n}\nfunction ReadOnlyRadio"
# The body ends with FB_SECTIONS.map() closing; we need to inject right before ");\n}"

# Simpler: find the line where map ends and outer div closes. The pattern is:
# "}))));\n}\nfunction ReadOnlyRadio" - the last ))) closes map+createElement+createElement(div)

# We'll inject a new child to the outer div after the map.
# Strategy: locate "FB_SECTIONS.map(sec => " and find its matching closing paren count.

# Easier strategy: locate the line right before "}\nfunction ReadOnlyRadio" and inject before the
# final closing of the outer React.createElement("div", null, ...).

# Search for sentinel
sentinel = "}\nfunction ReadOnlyRadio"
sentinel_idx = text.find(sentinel)
if sentinel_idx < 0:
    raise SystemExit("✗ Could not locate ReadOnlyRadio sentinel")

# Walk back to find the closing ");" that ends FeedPage's return statement
# FeedPage ends with "));" then a newline then "}"
# We want to inject before "));" — that is, add a sibling element to the outer div.

# Find the last "))" before "}\nfunction"
# The outermost call is React.createElement("div", null, <header>, <p>, <map>)
# We need to insert a new child after the map. The map ends with a ")", then the outer
# React.createElement closes with another ")", then the return closes with ");".

# Approach: locate "FB_SECTIONS.map(sec =>" and trace bracket depth from there.

map_start = text.find("FB_SECTIONS.map(sec =>")
if map_start < 0:
    raise SystemExit("✗ Could not locate FB_SECTIONS.map start")

# Walk forward from map_start tracking ( and ) depth until depth goes back to 0
depth = 0
i = map_start
map_end = None
text_len = len(text)
while i < text_len:
    ch = text[i]
    if ch == "(":
        depth += 1
    elif ch == ")":
        depth -= 1
        if depth == 0:
            # This is the close of the .map(...) call
            map_end = i
            break
    i += 1
if map_end is None:
    raise SystemExit("✗ Could not find matching close for FB_SECTIONS.map")

# After map_end we expect ")" closing the outer createElement("div", null, ...)
# We want to inject a new child between map_end+1 (after the map's ")") and the outer div's ")".

# Find next ")" after map_end
inject_at = map_end + 1
# Add a comma and the new footer JSX
footer_js = ''',
    // Submit footer
    /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 20,
        padding: 18,
        background: TH.cd,
        border: `1px solid ${TH.br}`,
        borderRadius: 12,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 12
      }
    },
      /*#__PURE__*/React.createElement("p", {
        style: { color: TH.tm, fontSize: 12, margin: 0, textAlign: "center" }
      }, commentCount === 0
        ? "Henüz yorum eklemediniz."
        : `${commentCount} yorum hazır. Göndere basınca tüm yorumlar Utku'nun e-postasına iletilecek ve veritabanına kaydedilecek.`),
      /*#__PURE__*/React.createElement("button", {
        onClick: handleSubmit,
        disabled: commentCount === 0 || submitting,
        style: {
          padding: "12px 28px",
          borderRadius: 8,
          border: "none",
          background: commentCount === 0 || submitting ? "#444" : TH.ac,
          color: "#fff",
          fontSize: 13,
          fontWeight: 600,
          cursor: commentCount === 0 || submitting ? "not-allowed" : "pointer",
          minWidth: 240
        }
      }, submitting
        ? "Gönderiliyor..."
        : commentCount === 0
        ? "Yorum yok"
        : `Tüm yorumları gönder (${commentCount})`),
      submitStatus === "ok" && /*#__PURE__*/React.createElement("p", {
        style: { color: "#22c55e", fontSize: 11, margin: 0 }
      }, "✓ Kaydedildi ve e-posta açıldı. E-posta uygulamanızdan 'Gönder' butonuna basmayı unutmayın."),
      submitStatus === "partial" && /*#__PURE__*/React.createElement("p", {
        style: { color: "#f59e0b", fontSize: 11, margin: 0, textAlign: "center" }
      }, "⚠ Veritabanına kaydedilemedi. E-posta açıldı — lütfen mutlaka gönderin.")
    )'''

text = text[:inject_at] + footer_js + text[inject_at:]
print("✓ 4/4: Submit footer injected after FB_SECTIONS.map")


p.write_text(text)
print(f"\n✓ admin.html size: {len(text)} (Δ {len(text)-orig_size:+d})")

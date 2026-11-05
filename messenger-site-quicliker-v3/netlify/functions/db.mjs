import { getStore } from "@netlify/blobs";
import { randomUUID } from "node:crypto";

const J = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const NAME = /^[\w.-]{1,20}$/;
const KIND = /^[a-z]{1,10}$/;
const OID = /^[\w-]{1,60}$/;
const WEEK = 7 * 864e5;
// Ключ администратора задаётся в Netlify: Site configuration -> Environment variables -> ADMIN_KEY
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const okKey = (req) => ADMIN_KEY.length >= 4 && (req.headers.get("x-admin-key") || "") === ADMIN_KEY;
const BUNDLE_MAX = 5500000;
const BAD_PATH = /(^\/)|(\.\.)|(\\)|^netlify|^sw\.js$/;

// Web Push (необязательно): включается, когда в настройках Netlify заданы VAPID-ключи
const VPUB = process.env.VAPID_PUBLIC_KEY || "";
const VPRIV = process.env.VAPID_PRIVATE_KEY || "";
let wpLib = null;
async function webpush() {
  if (!VPUB || !VPRIV) return null;
  if (!wpLib) {
    try {
      const m = (await import("web-push")).default;
      m.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@example.com", VPUB, VPRIV);
      wpLib = m;
    } catch {
      return null;
    }
  }
  return wpLib;
}

async function takeSigs(st, who) {
  if (!NAME.test(who)) return [];
  const { blobs } = await st.list({ prefix: `sig/${who}/` });
  const out = [];
  for (const b of blobs.sort((x, y) => (x.key < y.key ? -1 : 1))) {
    const v = await st.get(b.key, { type: "json" });
    await st.delete(b.key);
    if (v && Date.now() - parseInt(b.key.split("/")[2]) < 120000) out.push(v);
  }
  return out;
}

// Сообщения, которые ждут получателя (если прямой канал не открыт)
async function takeRelay(st, who) {
  if (!NAME.test(who)) return [];
  const { blobs } = await st.list({ prefix: `mq/${who}/` });
  const out = [];
  for (const b of blobs) {
    const v = await st.get(b.key, { type: "json" });
    await st.delete(b.key);
    if (v && v.p && Date.now() - (v.t || 0) < WEEK) out.push(v);
  }
  return out;
}

async function notifyPush(st, to, p) {
  const wp = await webpush();
  if (!wp) return;
  const subs = (await st.get(`push/${to}`, { type: "json" })) || [];
  if (!subs.length) return;
  const m = p.m || {};
  const title = p.type === "group" ? `${m.u} · ${p.name || "группа"}` : String(m.u || "Сообщение");
  const payload = JSON.stringify({
    title: title.slice(0, 80),
    body: "Новое сообщение",
    tag: String(p.chat || "tsm").slice(0, 60),
  });
  const keep = [];
  for (const s of subs) {
    try {
      await wp.sendNotification(s, payload, { TTL: 600 });
      keep.push(s);
    } catch (e) {
      if (e.statusCode !== 404 && e.statusCode !== 410) keep.push(s);
    }
  }
  if (keep.length !== subs.length) await st.set(`push/${to}`, JSON.stringify(keep));
}

export default async (req) => {
  const st = getStore({ name: "tsmesedjer", consistency: "strong" });
  const u = new URL(req.url);
  const a = u.searchParams.get("a");
  try {
    if (a === "vapid") return J({ key: VPUB || null });

    // картинки: храним отдельно, чтобы состояние оставалось лёгким
    if (a === "img") {
      if (req.method === "POST") {
        const d = await req.text();
        if (!/^data:image\/(jpeg|png|webp|gif);base64,/.test(d) || d.length > 2000000) return J({ error: "bad" }, 400);
        const id = randomUUID();
        await st.set("img/" + id, d);
        return J({ id });
      }
      const id = u.searchParams.get("id") || "";
      if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("bad", { status: 400 });
      const d = await st.get("img/" + id, { type: "text" });
      if (!d) return new Response("not found", { status: 404 });
      const m = d.match(/^data:(image\/[\w+]+);base64,(.*)$/s);
      return new Response(Buffer.from(m[2], "base64"), {
        headers: { "content-type": m[1], "cache-control": "public, max-age=31536000, immutable" },
      });
    }

    // сигналы для звонков
    if (a === "sig" && req.method === "POST") {
      const { to, m } = await req.json();
      if (!NAME.test(to || "")) return J({ error: "bad" }, 400);
      await st.set(`sig/${to}/${String(Date.now()).padStart(15, "0")}-${randomUUID().slice(0, 6)}`, JSON.stringify(m));
      return J({ ok: 1 });
    }

    // ретрансляция сообщений/подтверждений/удалений. Ключ по id сообщения:
    // повторная отправка перезаписывает то же самое, дублей не будет
    if (a === "relay" && req.method === "POST") {
      const { to, from, p } = await req.json();
      const kind = String(p?.k || "");
      const oid = String(p?.oid || "");
      if (!NAME.test(to || "") || !NAME.test(from || "") || !KIND.test(kind) || !OID.test(oid)) return J({ error: "bad" }, 400);
      await st.set(`mq/${to}/${kind}-${oid}`, JSON.stringify({ from, p, t: Date.now() }));
      if (kind === "msg" && p.m && p.m.u !== "система") await notifyPush(st, to, p).catch(() => {});
      return J({ ok: 1 });
    }

    // подписка устройства на push-уведомления
    if (a === "sub" && req.method === "POST") {
      const { u: who, sub } = await req.json();
      if (!NAME.test(who || "") || !sub || typeof sub.endpoint !== "string" || sub.endpoint.length > 1000) return J({ error: "bad" }, 400);
      const list = ((await st.get(`push/${who}`, { type: "json" })) || []).filter((x) => x.endpoint !== sub.endpoint);
      list.push(sub);
      while (list.length > 5) list.shift();
      await st.set(`push/${who}`, JSON.stringify(list));
      return J({ ok: 1 });
    }

    // один запрос: изменилось ли состояние + сигналы + сообщения
    if (a === "poll") {
      const r = await st.getWithMetadata("state", { type: "text" });
      const tag = r ? String(r.etag) : "";
      const same = u.searchParams.get("e") === tag;
      const who = u.searchParams.get("u") || "";
      const g = await takeSigs(st, who);
      const rl = await takeRelay(st, who);
      return new Response(
        '{"e":' +
          JSON.stringify(tag) +
          ',"g":' +
          JSON.stringify(g) +
          ',"r":' +
          JSON.stringify(rl) +
          (same ? "" : ',"s":' + (r ? r.data : "null")) +
          "}",
        { headers: { "content-type": "application/json", "cache-control": "no-store" } }
      );
    }

    // ---- админ-действия: только с ключом ADMIN_KEY ----
    if (a === "check" && req.method === "POST") return J({ ok: okKey(req) }, okKey(req) ? 200 : 403);

    if ((a === "grant" || a === "revoke") && req.method === "POST") {
      if (!okKey(req)) return J({ error: "forbidden" }, 403);
      const { login } = await req.json();
      const cur = (await st.get("state", { type: "json" })) || { users: {} };
      if (!cur.users || !cur.users[login]) return J({ error: "no user" }, 404);
      if (a === "grant") cur.users[login].admin = 1;
      else delete cur.users[login].admin;
      await st.set("state", JSON.stringify(cur));
      return J({ ok: 1 });
    }

    // обновление сайта: zip распаковывается в браузере, сюда приходят файлы приложения
    if (a === "bundle" && req.method === "GET") {
      const b = await st.get("bundle", { type: "json" });
      return new Response(JSON.stringify(b || null), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    if (a === "bundle" && req.method === "POST") {
      if (!okKey(req)) return J({ error: "forbidden" }, 403);
      const body = await req.json();
      if (!body || typeof body.v !== "string" || !/^[\w.-]{1,40}$/.test(body.v) || !body.files || typeof body.files !== "object")
        return J({ error: "bad" }, 400);
      let total = 0;
      for (const [p, d] of Object.entries(body.files)) {
        if (BAD_PATH.test(p) || typeof d !== "string") return J({ error: "bad path " + p }, 400);
        total += d.length;
      }
      if (total > BUNDLE_MAX) return J({ error: "too big" }, 413);
      await st.set("bundle", JSON.stringify(body));
      const cur = (await st.get("state", { type: "json" })) || { users: {} };
      cur.bv = body.v;
      await st.set("state", JSON.stringify(cur));
      return J({ ok: 1, v: body.v });
    }

    // общее состояние
    if (req.method === "POST") {
      const inc = JSON.parse(await req.text());
      const cur = (await st.get("state", { type: "json" })) || null;
      // Права администратора и версия обновления меняются только на сервере, клиент их не может подменить.
      if (cur && inc && typeof inc === "object") {
        const bootstrap = !cur.users || !cur.users.admin; // первый запуск: создаётся стартовый admin
        for (const n of Object.keys(inc.users || {})) {
          const u = inc.users[n];
          if (!u || typeof u !== "object") continue;
          const was = cur.users && cur.users[n] && cur.users[n].admin;
          if (was || (bootstrap && n === "admin")) u.admin = 1;
          else delete u.admin;
        }
        if (cur.bv !== undefined) inc.bv = cur.bv;
        else delete inc.bv;
      }
      await st.set("state", JSON.stringify(inc));
      return new Response("ok");
    }
    const r = await st.getWithMetadata("state", { type: "text" });
    if (!r) return J(null);
    return new Response(r.data, {
      headers: { "content-type": "application/json", "cache-control": "no-store", etag: String(r.etag) },
    });
  } catch (e) {
    return J({ error: String(e) }, 500);
  }
};

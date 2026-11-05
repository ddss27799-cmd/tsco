/* updater.js — проверка обновлений через статический сайт-хаб (НЕ Netlify).
   Конфиг задаётся до подключения файла: window.UPD_CONFIG = {app, name, version, hub}
   Логика:
   - в браузере: открывается страница update.html на хабе, она ведёт в новый сайт;
   - в установленном приложении (PWA на главном экране): экран загрузки обновления, затем новый сайт.
   Сайт после перехода получает ?updated=<версия>, поэтому цикла перенаправлений не будет. */
(function () {
  var C = window.UPD_CONFIG || {};
  if (!C.app || !C.hub || /YOUR-HUB/.test(C.hub)) return;
  var hub = C.hub.replace(/\/?$/, "/");
  var qs = new URLSearchParams(location.search);
  var standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  var enc = encodeURIComponent;
  var esc = function (t) { return String(t == null ? "" : t).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };

  function newer(a, b) {
    var x = String(a).split("."), y = String(b).split("."), n = Math.max(x.length, y.length);
    for (var i = 0; i < n; i++) { var p = +x[i] || 0, q = +y[i] || 0; if (p !== q) return p > q; }
    return false;
  }

  function css() {
    var s = document.createElement("style");
    s.textContent = "#upd-ov{position:fixed;inset:0;z-index:200;display:grid;place-items:center;background:#0b0b10;color:#fff;font:15px system-ui,sans-serif;padding:20px}" +
      "#upd-ov .u-logo{font-size:44px;font-weight:900;letter-spacing:.08em;text-align:center;color:#ff3d9a}" +
      "#upd-ov p{text-align:center;opacity:.8;margin:14px 0}" +
      "#upd-ov .u-bar{width:220px;height:4px;border-radius:4px;background:#ffffff1f;overflow:hidden;margin:0 auto}" +
      "#upd-ov .u-bar i{display:block;height:100%;width:40%;background:#ff3d9a;animation:uRun 1s linear infinite}" +
      "@keyframes uRun{from{transform:translateX(-100%)}to{transform:translateX(260%)}}" +
      "#upd-ov button{display:block;margin:18px auto 0;background:#ffffff1f;color:#fff;border:0;border-radius:12px;padding:10px 18px;font:inherit}" +
      "#upd-ov small{display:block;text-align:center;opacity:.6;margin-top:10px}";
    document.head.appendChild(s);
  }

  function showOverlay(u) {
    css();
    var d = document.createElement("div");
    d.id = "upd-ov";
    d.innerHTML = '<div><div class="u-logo">' + esc(C.name || C.app) + '</div><p>Загрузка обновления ' + esc(u.version) + '…</p>' +
      '<div class="u-bar"><i></i></div>' + (u.notes ? '<small>' + esc(u.notes) + '</small>' : "") +
      (u.force ? "" : '<button id="u-later">Позже</button>') + "</div>";
    document.body.appendChild(d);
    var t = setTimeout(function () {
      location.replace(u.url + (u.url.indexOf("?") < 0 ? "?" : "&") + "updated=" + enc(u.version));
    }, 3000);
    var b = d.querySelector("#u-later");
    if (b) b.onclick = function () { clearTimeout(t); sessionStorage.setItem("upd-skip:" + C.app, String(u.version)); d.remove(); };
  }

  async function check() {
    var r = await fetch(hub + "version.json?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) return;
    var all = await r.json();
    var u = all && all[C.app];
    if (!u || !u.version || !u.url || !newer(u.version, C.version)) return;
    if (qs.get("updated") === String(u.version)) return;                       // уже обновились
    if (!u.force && (qs.get("noupd") === String(u.version) ||
        sessionStorage.getItem("upd-skip:" + C.app) === String(u.version))) return; // пользователь выбрал «позже»
    if (standalone) { showOverlay(u); return; }
    location.replace(hub + "update.html?app=" + enc(C.app) + "&to=" + enc(u.url) + "&v=" + enc(u.version) +
      "&force=" + (u.force ? 1 : 0) + "&from=" + enc(location.origin + location.pathname));
  }

  check().catch(function () {});
})();

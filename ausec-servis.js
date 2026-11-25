// AUSEC Kick Yayın Paketi - Tek Servis (Aktarıcı + OBS Sunucusu + Panel + Güncelleyici)
const http = require("http");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const WebSocket = require("ws");

const DIZIN = __dirname;
const AYAR_YOL = path.join(DIZIN, "ayarlar.json");
const VARSAYILAN_AYAR = {
  surum: "1.0.0",
  port: 8787,
  kanal_adi: "ausec",
  chatroom_id: "25980531",
  kanal_id: "",
  guncelleme_url: ""
};

function ayarOku() {
  try {
    if (fs.existsSync(AYAR_YOL)) {
      return Object.assign({}, VARSAYILAN_AYAR, JSON.parse(fs.readFileSync(AYAR_YOL, "utf8")));
    }
  } catch (e) {
    console.log("! ayarlar.json okunamadı, varsayılan kullanılıyor:", e.message);
  }
  fs.writeFileSync(AYAR_YOL, JSON.stringify(VARSAYILAN_AYAR, null, 2), "utf8");
  return Object.assign({}, VARSAYILAN_AYAR);
}

function ayarKaydet(yeni) {
  const birlesik = Object.assign({}, ayarOku(), yeni);
  fs.writeFileSync(AYAR_YOL, JSON.stringify(birlesik, null, 2), "utf8");
  return birlesik;
}

let AYAR = ayarOku();

// ============================================================================
// GÜNCELLEME MOTORU (ayarlar.json dosyasına asla dokunmaz)
// ============================================================================
async function guncellemeCalistir(logFn = console.log) {
  const base = String(AYAR.guncelleme_url || "").trim().replace(/\/+$/, "");
  if (!base) {
    return { ok: false, mesaj: "ayarlar.json içinde 'guncelleme_url' tanımlı değil." };
  }
  logFn("Güncelleme kontrol ediliyor: " + base + "/surum.json");
  const r = await fetch(base + "/surum.json?t=" + Date.now());
  if (!r.ok) throw new Error("surum.json indirilemedi (HTTP " + r.status + ")");
  const manifest = await r.json();
  const uzakSurum = String(manifest.surum || "");
  const dosyalar = Array.isArray(manifest.dosyalar) ? manifest.dosyalar : [];

  if (!dosyalar.length) {
    return { ok: false, mesaj: "surum.json içinde güncellenecek dosya listesi boş." };
  }

  let indirilen = 0;
  for (const dosya of dosyalar) {
    const temiz = path.normalize(String(dosya)).replace(/^(\.\.(\/|\\|$))+/, "");
    if (!temiz || temiz.toLowerCase() === "ayarlar.json") continue;
    const hedef = path.join(DIZIN, temiz);
    if (!hedef.startsWith(DIZIN)) continue;

    const url = base + "/" + temiz.split(path.sep).map(encodeURIComponent).join("/") + "?t=" + Date.now();
    const res = await fetch(url);
    if (!res.ok) throw new Error(temiz + " indirilemedi (HTTP " + res.status + ")");
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(hedef), { recursive: true });
    fs.writeFileSync(hedef, buf);
    indirilen++;
    logFn("  + Güncellendi: " + temiz);
  }

  if (uzakSurum) {
    AYAR = ayarKaydet({ surum: uzakSurum });
  }
  return {
    ok: true,
    surum: uzakSurum || AYAR.surum,
    not: manifest.not || "",
    indirilen,
    mesaj: `${indirilen} dosya güncellendi (Sürüm: ${uzakSurum || AYAR.surum}).`
  };
}

// CLI'dan --guncelle parametresi ile çalıştırıldıysa sadece güncelle ve çık
if (process.argv.includes("--guncelle")) {
  guncellemeCalistir(console.log)
    .then((res) => {
      console.log(res.ok ? "OK: " + res.mesaj : "UYARI: " + res.mesaj);
      if (res.not) console.log("Not: " + res.not);
      process.exit(res.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error("Güncelleme hatası:", err.message);
      process.exit(1);
    });
  return;
}

// Komut satırından geçici Chatroom/Kanal ID verildiyse üzerine yaz
const cliArgs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (cliArgs[0] && /^\d+$/.test(cliArgs[0])) AYAR.chatroom_id = cliArgs[0];
if (cliArgs[1] && /^\d+$/.test(cliArgs[1])) AYAR.kanal_id = cliArgs[1];

// ============================================================================
// DURUM VE LOG YÖNETİMİ
// ============================================================================
const loglar = [];
let sonDurum = { durum: "Başlatılıyor...", hata: false };
let aktifKickWs = null;
let yenidenBaglanTimer = null;
let baglantiDeniyor = false;

function logEkle(tur, metin) {
  const saat = new Date().toLocaleTimeString("tr-TR");
  const satir = { saat, tur, metin };
  loglar.push(satir);
  if (loglar.length > 80) loglar.shift();
  console.log(`[${saat}] [${tur}] ${metin}`);
}

function mevcutDosyaBul(adaylar) {
  for (const ad of adaylar) {
    const tam = path.join(DIZIN, ad);
    if (fs.existsSync(tam)) return tam;
  }
  return null;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav"
};

function govdeOku(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); } });
  });
}

// ============================================================================
// HTTP + WEBSOCKET SUNUCUSU (TEK PORT: 8787)
// ============================================================================
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, "http://localhost");
  const p = decodeURIComponent(parsed.pathname);

  // --- API Uçları ---
  if (p === "/api/durum" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      ayar: AYAR,
      durum: sonDurum,
      bagliIstemci: wss ? wss.clients.size : 0,
      loglar: loglar.slice(-30)
    }));
  }

  if (p === "/api/ayar" && req.method === "POST") {
    const b = await govdeOku(req);
    AYAR = ayarKaydet({
      kanal_adi: String(b.kanal_adi || "").trim(),
      chatroom_id: String(b.chatroom_id || "").trim(),
      kanal_id: String(b.kanal_id || "").trim(),
      guncelleme_url: String(b.guncelleme_url || "").trim()
    });
    logEkle("AYAR", `Ayarlar kaydedildi (Oda: ${AYAR.chatroom_id || "-"}, Kanal: ${AYAR.kanal_adi || "-"})`);
    kickYenidenBaglan();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: true, ayar: AYAR }));
  }

  if (p === "/api/test" && req.method === "POST") {
    const b = await govdeOku(req);
    const tur = String(b.tur || "");
    const isim = String(b.isim || "TestIzleyici").trim() || "TestIzleyici";
    const miktar = Number(b.miktar) || 0;

    if (tur === "abone") yay({ tip: "abone", kullanici: isim, ay: miktar || 1 });
    else if (tur === "hediye") yay({ tip: "hediye", kullanici: isim, adet: miktar || 5 });
    else if (tur === "kicks") yay({ tip: "kicks", kullanici: isim, miktar: miktar || 250 });
    else if (tur === "bagis") yay({ tip: "bagis", kullanici: isim, miktar: miktar || 100 });
    else if (tur === "takip") yay({ tip: "takip", kullanici: isim });
    else if (tur === "halay") yay({ u: isim, m: "!halay", r: true, isMod: false });
    else if (tur === "topik") yay({ u: isim, m: "!topik", r: false, isMod: false });
    else if (tur === "topik_baslat") yay({ u: "Ausec", m: "!başlat", r: true, isMod: true });

    logEkle("TEST", `Test tetiklendi: ${tur} (${isim})`);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (p === "/api/guncelle" && req.method === "POST") {
    try {
      const sonuc = await guncellemeCalistir((m) => logEkle("GUNCELLE", m));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(sonuc));
      if (sonuc.ok && sonuc.indirilen > 0) {
        logEkle("SISTEM", "Güncelleme tamamlandı, servis 2 sn içinde yeniden başlatılıyor...");
        setTimeout(() => process.exit(42), 1800); // baslat.bat 42 kodunu görünce otomatik tekrar açar
      }
    } catch (e) {
      logEkle("HATA", "Güncelleme hatası: " + e.message);
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, mesaj: e.message }));
    }
    return;
  }

  // --- Kontrol Paneli ---
  if (p === "/" || p === "/panel") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(PANEL_HTML);
  }

  // --- Kısa Overlay Rotaları ---
  let dosyaYolu = null;
  if (p === "/halay") dosyaYolu = mevcutDosyaBul(["halay.html", "kick_halay_3.html", "kick_halay_2.html"]);
  else if (p === "/topik") dosyaYolu = mevcutDosyaBul(["topik.html", "ausec-topik.html"]);
  else if (p === "/para" || p === "/yagmur") dosyaYolu = mevcutDosyaBul(["para-yagmuru.html", "sosis-yagmuru.html"]);
  else {
    const temiz = path.normalize(p.replace(/^\/+/, "")).replace(/^(\.\.(\/|\\|$))+/, "");
    const aday = path.join(DIZIN, temiz);
    if (aday.startsWith(DIZIN) && fs.existsSync(aday) && fs.statSync(aday).isFile() && !temiz.endsWith(".js") && temiz !== "ayarlar.json") {
      dosyaYolu = aday;
    }
  }

  if (!dosyaYolu) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Dosya bulunamadı: " + p);
  }

  const ext = path.extname(dosyaYolu).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  fs.createReadStream(dosyaYolu).pipe(res);
});

const wss = new WebSocket.Server({ server });
function yay(obj) {
  const str = JSON.stringify(obj);
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(str);
  });
}
function durumGuncelle(metin, hata = false) {
  sonDurum = { durum: metin, hata };
  logEkle(hata ? "HATA" : "KICK", metin);
  yay(sonDurum);
}
wss.on("connection", (c) => {
  if (sonDurum) c.send(JSON.stringify(sonDurum));
});

// ============================================================================
// KICK CANLI BAĞLANTI (CENTRIFUGO + PUSHER + ABONE / KICKS / TAKİP)
// ============================================================================
const ORIGIN = "https://kick.com";
const BASE = "https://web.kick.com/api/v1/realtime";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BASLIK = { "Content-Type": "application/json", Origin: ORIGIN, Referer: ORIGIN + "/", "User-Agent": UA };
const WS_SEC = { headers: { Origin: ORIGIN, "User-Agent": UA } };

async function post(yol, govde) {
  const r = await fetch(BASE + yol, { method: "POST", headers: BASLIK, body: JSON.stringify(govde) });
  if (!r.ok) throw new Error(`${yol} -> HTTP ${r.status}`);
  return (await r.json()).data;
}

async function kanalBilgisiDene() {
  if (!AYAR.kanal_adi || (AYAR.chatroom_id && AYAR.kanal_id)) return;
  try {
    const r = await fetch("https://kick.com/api/v2/channels/" + encodeURIComponent(AYAR.kanal_adi), {
      headers: { "User-Agent": UA, Accept: "application/json" }
    });
    if (!r.ok) return;
    const j = await r.json();
    const guncel = {};
    if (!AYAR.chatroom_id && j.chatroom?.id) guncel.chatroom_id = String(j.chatroom.id);
    if (!AYAR.kanal_id && j.id) guncel.kanal_id = String(j.id);
    if (Object.keys(guncel).length) {
      AYAR = ayarKaydet(guncel);
      logEkle("KICK", `Kanal bilgileri otomatik bulundu (Chatroom: ${AYAR.chatroom_id}, Kanal: ${AYAR.kanal_id})`);
    }
  } catch {}
}

function olayIsle(rawEvent, rawData) {
  try {
    const evName = String(rawEvent || "");
    let v = typeof rawData === "string" ? JSON.parse(rawData) : rawData;
    if (v && v.data && typeof v.data === "object" && !v.sender && !v.content) v = v.data;
    if (!v || typeof v !== "object") return false;

    // 1. Sohbet Mesajı
    if ((!evName || evName.includes("ChatMessageEvent")) && v.content != null && v.sender) {
      const badges = v.sender.identity?.badges || [];
      const isMod = badges.some((b) => {
        const t = String(b.type || b.text || "").toLowerCase();
        return t === "broadcaster" || t === "moderator" || t === "owner";
      });
      const r = badges.length > 0;
      const u = v.sender.username;
      const m = String(v.content);
      yay({ u, m, r, isMod });
      return true;
    }

    // Sohbet dışındaki tüm Kick olaylarını logla (teşhis için çok değerli)
    if (evName) {
      logEkle("OLAY", evName + " -> " + JSON.stringify(v).slice(0, 220));
    }

    // NOT: Halay ekranının çökmemesi için abone/hediye/kicks/takip olaylarında
    // "u" yerine "kullanici" alanı kullanılır (para-yagmuru.html ikisini de okur).

    // 2. Hediye Abonelik
    if (/gift.*sub|luckyusers|giftedsubscription/i.test(evName)) {
      const isim = v.gifter_username || v.gifter?.username || v.username || v.sender?.username || "Biri";
      const adet = Array.isArray(v.gifted_usernames)
        ? v.gifted_usernames.length
        : (Number(v.gifted_total || v.count || v.quantity || v.amount) || 1);
      yay({ tip: "hediye", kullanici: isim, adet });
      return true;
    }

    // 3. KICKs / Hediye Puanı
    if (/kicks/i.test(evName)) {
      const isim = v.sender?.username || v.username || v.user?.username || "Biri";
      const miktar = Number(v.gift?.amount || v.amount || v.kicks || v.value) || 0;
      yay({ tip: "kicks", kullanici: isim, miktar });
      return true;
    }

    // 4. Tekil Abonelik / Yenileme
    if (/subscription/i.test(evName)) {
      const isim = v.username || v.subscriber_username || v.user?.username || v.sender?.username || "Biri";
      const ay = Number(v.months || v.duration || 1) || 1;
      yay({ tip: "abone", kullanici: isim, ay });
      return true;
    }

    // 5. Takipçi
    if (/follow/i.test(evName)) {
      const isim = v.username || v.follower?.username || v.user?.username || "";
      if (isim) yay({ tip: "takip", kullanici: isim });
      return true;
    }

    // 6. Diğer Bağış / Tip
    if (/donat|tip/i.test(evName)) {
      const isim = v.sender?.username || v.username || v.name || "Biri";
      const miktar = Number(v.amount || v.value) || 0;
      yay({ tip: "bagis", kullanici: isim, miktar });
      return true;
    }
  } catch (e) {
    logEkle("HATA", "Olay işleme hatası: " + e.message);
  }
  return false;
}

function paketCoz(d) {
  try {
    if (typeof d === "string") d = JSON.parse(d);
    if (d.push?.pub) {
      const pub = d.push.pub;
      let inner = pub.data;
      if (typeof inner === "string") inner = JSON.parse(inner);
      const evAd = inner?.event || pub.event || d.push.channel || "";
      const payload = inner?.data !== undefined ? inner.data : inner;
      if (olayIsle(evAd, payload)) return;
    }
    olayIsle(d.event || d.channel || "", d.data !== undefined ? d.data : d);
  } catch {}
}

function kickYenidenBaglan() {
  clearTimeout(yenidenBaglanTimer);
  baglantiDeniyor = false;
  if (aktifKickWs) {
    try { aktifKickWs.removeAllListeners(); aktifKickWs.close(); } catch {}
    aktifKickWs = null;
  }
  kickBaglan();
}

async function kickBaglan() {
  if (baglantiDeniyor) return;
  await kanalBilgisiDene();

  const ODA = String(AYAR.chatroom_id || "").trim();
  const KANAL = String(AYAR.kanal_id || "").trim();
  if (!ODA) {
    durumGuncelle("Chatroom ID boş! http://localhost:" + AYAR.port + " panelinden ID girin.", true);
    return;
  }

  baglantiDeniyor = true;
  const id = randomUUID();
  let bitti = false;
  let pusherPing = null;

  const bitir = (neden) => {
    if (bitti) return;
    bitti = true;
    baglantiDeniyor = false;
    if (pusherPing) clearInterval(pusherPing);
    aktifKickWs = null;
    durumGuncelle(neden + " - 4 sn sonra tekrar bağlanılacak", true);
    clearTimeout(yenidenBaglanTimer);
    yenidenBaglanTimer = setTimeout(kickBaglan, 4000);
  };

  try {
    durumGuncelle("Kick realtime bağlantısı kuruluyor...");
    const cevap = await post(KANAL ? `/channels/${KANAL}/chat/connection` : "/connection", {
      client: { id, type: "web" },
      capabilities: { accepted_providers: [{ provider: "centrifugo" }, { provider: "pusher" }] }
    });
    const c = cevap.connections?.[0];
    if (!c) throw new Error("Kick bağlantı bilgisi vermedi");

    const kanallar = [`chatrooms.${ODA}.v2`];
    if (KANAL) kanallar.push(`channel.${KANAL}`);

    let ws;
    if (c.provider === "centrifugo") {
      const { token } = await post("/auth/connection", { client_id: id });
      ws = new WebSocket(c.credentials.url, WS_SEC);
      aktifKickWs = ws;

      ws.on("open", () => {
        ws.send(JSON.stringify({ id: 1, connect: { token, name: "js" } }));
      });

      ws.on("message", (ham) => {
        ham.toString().split("\n").filter(Boolean).forEach((satir) => {
          let m;
          try { m = JSON.parse(satir); } catch { return; }

          // Centrifugo sunucu pingi ({}) gelince anında pong ({}) dön (3005 önler)
          if (Object.keys(m).length === 0 || m.ping !== undefined) {
            if (ws.readyState === WebSocket.OPEN) ws.send("{}");
            return;
          }
          if (m.error) {
            logEkle("UYARI", `Kick mesajı: ${m.error.code} ${m.error.message}`);
            return;
          }
          if (m.connect) {
            kanallar.forEach((ch, idx) => {
              ws.send(JSON.stringify({ id: 2 + idx, subscribe: { channel: ch } }));
            });
            return;
          }
          if (m.id === 2 && m.subscribe) {
            durumGuncelle(`Bağlandı, chatroom #${ODA} dinleniyor`);
            return;
          }
          if (m.id === 3 && m.subscribe) {
            logEkle("KICK", `Kanal olay kanalı (#${KANAL}) aktif`);
            return;
          }
          if (m.push?.pub) paketCoz(m);
        });
      });
    } else if (c.provider === "pusher") {
      const { app_key, cluster } = c.credentials;
      ws = new WebSocket(`wss://ws-${cluster}.pusher.com/app/${app_key}?protocol=7&client=js&version=8.4.0&flash=false`, WS_SEC);
      aktifKickWs = ws;

      ws.on("open", () => {
        pusherPing = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: "pusher:ping", data: {} }));
        }, 25000);
      });

      ws.on("message", (ham) => {
        let m;
        try { m = JSON.parse(ham); } catch { return; }
        if (m.event === "pusher:connection_established") {
          kanallar.forEach((ch) => {
            ws.send(JSON.stringify({ event: "pusher:subscribe", data: { auth: "", channel: ch } }));
          });
        } else if (m.event === "pusher_internal:subscription_succeeded" && m.channel === `chatrooms.${ODA}.v2`) {
          durumGuncelle(`Bağlandı (Pusher), chatroom #${ODA} dinleniyor`);
        } else if (m.event === "pusher:ping") {
          ws.send(JSON.stringify({ event: "pusher:pong", data: {} }));
        } else if (m.event === "pusher:error") {
          logEkle("UYARI", "Pusher hatası: " + JSON.stringify(m.data));
        } else {
          paketCoz(m);
        }
      });
    } else {
      throw new Error("Bilinmeyen sağlayıcı: " + c.provider);
    }

    ws.on("close", (kod) => bitir(`Kick bağlantısı kapandı (${kod})`));
    ws.on("error", (e) => bitir("Kick bağlantı hatası: " + e.message));
  } catch (e) {
    bitir(e.message);
  }
}

// ============================================================================
// WEB KONTROL PANELİ (http://localhost:8787)
// ============================================================================
const PANEL_HTML = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<title>AUSEC Yayın Kontrol Paneli</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:"Segoe UI",Arial,sans-serif;background:#0b0f14;color:#eef2f6;padding:22px;max-width:980px;margin:0 auto}
  h1{font-size:22px;color:#53fc18;display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
  .pill{font-size:12px;padding:4px 10px;border-radius:999px;background:#1e293b;color:#cbd5e1;font-weight:700}
  .pill.ok{background:#14532d;color:#4ade80}
  .pill.err{background:#7f1d1d;color:#fca5a5}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
  @media(max-width:760px){.grid{grid-template-columns:1fr}}
  .card{background:#131922;border:1px solid #243042;border-radius:14px;padding:16px}
  .card h2{font-size:14px;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px}
  .obs-item{display:flex;align-items:center;justify-content:space-between;gap:8px;background:#0c1118;border:1px solid #1e293b;padding:10px 12px;border-radius:10px;margin-bottom:8px}
  .obs-item b{display:block;font-size:14px;color:#fff}
  .obs-item small{color:#94a3b8;font-size:12px}
  .obs-url{font-family:Consolas,monospace;font-size:12px;color:#53fc18;display:block;margin-top:3px;word-break:break-all}
  button{background:#53fc18;color:#071108;border:none;border-radius:8px;padding:8px 12px;font-weight:800;font-size:12px;cursor:pointer}
  button:hover{filter:brightness(1.08)}
  button.sec{background:#1e293b;color:#e2e8f0;border:1px solid #334155}
  .btns{display:flex;flex-wrap:wrap;gap:8px}
  label{display:block;font-size:12px;color:#94a3b8;margin-bottom:4px;margin-top:8px}
  input{width:100%;padding:8px 10px;border-radius:8px;border:1px solid #334155;background:#0c1118;color:#fff;font-size:13px}
  #logs{background:#080b10;border:1px solid #1e293b;border-radius:10px;padding:10px;height:210px;overflow-y:auto;font:12px/1.5 Consolas,monospace;color:#cbd5e1}
  .msg{font-size:12px;color:#53fc18;margin-top:8px;min-height:16px}
</style>
</head>
<body>
  <h1>
    <span>AUSEC Kick Yayın Paketi <small id="ver" style="color:#94a3b8;font-size:13px"></small></span>
    <span id="durumPill" class="pill">Yükleniyor...</span>
  </h1>

  <div class="grid">
    <div class="card">
      <h2>OBS Tarayıcı (Browser) Linkleri</h2>
      <div class="obs-item">
        <div>
          <b>1. Halay &amp; Orkestra</b>
          <small>OBS Boyutu: 500 x 230</small>
          <span class="obs-url" id="uHalay"></span>
        </div>
        <button onclick="kopyala('uHalay')">Kopyala</button>
      </div>
      <div class="obs-item">
        <div>
          <b>2. Topik Yarışı (6 Harita)</b>
          <small>OBS Boyutu: 420 x 720</small>
          <span class="obs-url" id="uTopik"></span>
        </div>
        <button onclick="kopyala('uTopik')">Kopyala</button>
      </div>
      <div class="obs-item">
        <div>
          <b>3. 100 AUSEC Para Yağmuru</b>
          <small>OBS Boyutu: 1920 x 1080 (En Üste Koy)</small>
          <span class="obs-url" id="uPara"></span>
        </div>
        <button onclick="kopyala('uPara')">Kopyala</button>
      </div>
    </div>

    <div class="card">
      <h2>Canlı Test (OBS'te Anında Dene)</h2>
      <label>Test Kullanıcı Adı</label>
      <input id="tIsim" value="AusecFan_01">
      <div class="btns" style="margin-top:10px">
        <button onclick="testAt('abone',1)">Abone</button>
        <button onclick="testAt('hediye',5)">5 Hediye</button>
        <button onclick="testAt('kicks',250)">250 KICKs</button>
        <button onclick="testAt('bagis',100)">100 TL Bağış</button>
        <button onclick="testAt('takip',0)">Takip</button>
        <button class="sec" onclick="testAt('halay',0)">Halay +1</button>
        <button class="sec" onclick="testAt('topik',0)">Topik +1</button>
        <button class="sec" onclick="testAt('topik_baslat',0)">Topik Başlat</button>
      </div>
      <div id="testMsg" class="msg"></div>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>Kanal &amp; Güncelleme Ayarları</h2>
      <label>Kick Kanal Adı</label>
      <input id="aKanal">
      <label>Chatroom ID</label>
      <input id="aOda">
      <label>Kanal ID (isteğe bağlı, otomatik bulunur)</label>
      <input id="aKanalId">
      <label>Uzaktan Güncelleme Linki (GitHub Raw Klasörü)</label>
      <input id="aGuncel" placeholder="https://raw.githubusercontent.com/kullanici/repo/main">
      <div class="btns" style="margin-top:12px">
        <button onclick="ayarKaydetUI()">Kaydet &amp; Yeniden Bağlan</button>
        <button class="sec" onclick="guncelleUI()">Güncellemeleri Yükle</button>
      </div>
      <div id="ayarMsg" class="msg"></div>
    </div>

    <div class="card">
      <h2>Canlı Olay &amp; Bağlantı Kaydı</h2>
      <div id="logs"></div>
    </div>
  </div>

<script>
  var base = location.origin;
  document.getElementById('uHalay').textContent = base + '/halay?temiz=1';
  document.getElementById('uTopik').textContent = base + '/topik';
  document.getElementById('uPara').textContent  = base + '/para?ses=1';

  var formYuklendi = false;
  function kopyala(id) {
    var txt = document.getElementById(id).textContent;
    navigator.clipboard.writeText(txt).then(function() {
      document.getElementById('testMsg').textContent = 'Kopyalandı: ' + txt;
    });
  }
  function testAt(tur, miktar) {
    var isim = document.getElementById('tIsim').value || 'TestIzleyici';
    fetch('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tur: tur, isim: isim, miktar: miktar })
    }).then(function() {
      document.getElementById('testMsg').textContent = 'OBS ekranına gönderildi: ' + tur + ' (' + isim + ')';
    });
  }
  function ayarKaydetUI() {
    var body = {
      kanal_adi: document.getElementById('aKanal').value,
      chatroom_id: document.getElementById('aOda').value,
      kanal_id: document.getElementById('aKanalId').value,
      guncelleme_url: document.getElementById('aGuncel').value
    };
    fetch('/api/ayar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function(r) { return r.json(); }).then(function() {
      document.getElementById('ayarMsg').textContent = 'Ayarlar kaydedildi ve Kick bağlantısı yenilendi.';
    });
  }
  function guncelleUI() {
    document.getElementById('ayarMsg').textContent = 'Güncelleme kontrol ediliyor...';
    fetch('/api/guncelle', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        document.getElementById('ayarMsg').textContent = d.mesaj || 'İşlem bitti.';
      })
      .catch(function() {
        document.getElementById('ayarMsg').textContent = 'Güncelleme sırasında bağlantı hatası oluştu.';
      });
  }
  function yenile() {
    fetch('/api/durum').then(function(r) { return r.json(); }).then(function(d) {
      document.getElementById('ver').textContent = 'v' + (d.ayar.surum || '1.0.0') + ' · OBS: ' + d.bagliIstemci;
      var pill = document.getElementById('durumPill');
      pill.textContent = d.durum.durum || 'Bekleniyor';
      pill.className = 'pill ' + (d.durum.hata ? 'err' : (/bağlandı|dinleniyor/i.test(d.durum.durum || '') ? 'ok' : ''));
      if (!formYuklendi) {
        document.getElementById('aKanal').value = d.ayar.kanal_adi || '';
        document.getElementById('aOda').value = d.ayar.chatroom_id || '';
        document.getElementById('aKanalId').value = d.ayar.kanal_id || '';
        document.getElementById('aGuncel').value = d.ayar.guncelleme_url || '';
        formYuklendi = true;
      }
      var box = document.getElementById('logs');
      box.innerHTML = (d.loglar || []).map(function(l) {
        return '<div>[' + l.saat + '] <b>' + l.tur + '</b>: ' + String(l.metin).replace(/</g, '&lt;') + '</div>';
      }).join('');
      box.scrollTop = box.scrollHeight;
    }).catch(function() {});
  }
  yenile();
  setInterval(yenile, 2000);
</script>
</body>
</html>`;

// ============================================================================
// SERVİSİ BAŞLAT
// ============================================================================
const PORT = Number(AYAR.port) || 8787;
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`HATA: ${PORT} portu zaten kullanılıyor! Arka planda açık başka bir başlatma penceresi varsa kapatın.`);
  } else {
    console.error("Sunucu hatası:", err.message);
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("====================================================");
  console.log(` AUSEC Yayın Paketi v${AYAR.surum} çalışıyor!`);
  console.log(` Kontrol Paneli : http://localhost:${PORT}`);
  console.log(` Halay OBS      : http://localhost:${PORT}/halay?temiz=1`);
  console.log(` Topik OBS      : http://localhost:${PORT}/topik`);
  console.log(` Para Yağmuru   : http://localhost:${PORT}/para?ses=1`);
  console.log("====================================================");
  kickBaglan();
});
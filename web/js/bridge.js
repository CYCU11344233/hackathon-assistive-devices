// 台北通（TownPass）WebView 橋接。
// 協定依官方原始碼 lib/util/web_message_handler/*.dart：
//   網頁 → App：window.flutterObject.postMessage(JSON.stringify({ name, data }))
//   App → 網頁：flutterObject 收到 message 事件，event.data 為 JSON 字串 { name, data }
// 不在 App 內（一般瀏覽器）時，改用瀏覽器原生功能，方便開發與 Demo。

const waiting = new Map(); // name -> [resolve]
let listening = false;

export function isInApp() {
  return typeof window !== 'undefined' && !!window.flutterObject;
}

function listen() {
  if (listening || !isInApp()) return;
  listening = true;
  const onMessage = (event) => {
    let msg;
    try {
      msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    } catch {
      return;
    }
    const queue = waiting.get(msg?.name);
    if (queue && queue.length) queue.shift()(msg.data);
  };
  const obj = window.flutterObject;
  if (typeof obj.addEventListener === 'function') obj.addEventListener('message', onMessage);
  else obj.onmessage = onMessage;
}

function post(name, data) {
  window.flutterObject.postMessage(JSON.stringify({ name, data: data ?? null }));
}

function request(name, data, timeoutMs = 10000) {
  listen();
  return new Promise((resolve) => {
    const queue = waiting.get(name) || [];
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    queue.push(finish);
    waiting.set(name, queue);
    setTimeout(() => {
      const i = queue.indexOf(finish);
      if (i >= 0) queue.splice(i, 1);
      finish(undefined);
    }, timeoutMs);
    post(name, data);
  });
}

/** 台北通帳號資料（姓名、身分證、電話、生日、地址）；不在 App 內或拿不到時回傳 null。 */
export async function getUserInfo() {
  if (!isInApp()) return null;
  const d = await request('userinfo');
  return d && typeof d === 'object' && !Array.isArray(d) ? d : null;
}

/** 取得目前位置；失敗回傳 null。 */
export async function getLocation() {
  if (isInApp()) {
    const pos = await request('location');
    if (pos && typeof pos.latitude === 'number') return { lat: pos.latitude, lng: pos.longitude };
    return null;
  }
  if (!navigator.geolocation) return null;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { timeout: 10000, maximumAge: 60000 },
    );
  });
}

export function phoneCall(number) {
  const digits = String(number).replace(/[^\d+]/g, '');
  if (isInApp()) post('phone_call', digits);
  else window.location.href = `tel:${digits}`;
}

/**
 * 用手機預設的地圖 App 顯示中心位置。
 * App 內用 Android 標準的 geo: 連結，由手機自己選地圖 App，程式裡不使用任何商用地圖服務。
 * 一般瀏覽器改開 OpenStreetMap，標出位置。
 */
export function launchMap(lat, lng, label) {
  if (isInApp()) {
    // 用中心名稱搜尋（座標只當附近範圍），地圖 App 會找到中心本身的位置
    post('launch_map', `geo:${lat},${lng}?q=${encodeURIComponent(label || `${lat},${lng}`)}`);
  } else {
    window.open(`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat}/${lng}`, '_blank', 'noopener');
  }
}

/**
 * 開外部網頁（官方預約網站等）。
 * 台北通的 open_link 會用 GetX 開新的 WebView 頁，但在微服務的 WebView 裡會被
 * 「不重複開同一路由」擋掉，所以 App 內直接在同一個 WebView 前往，看完按台北通的返回鍵回來。
 */
export function openLink(url) {
  if (isInApp()) window.location.href = url;
  else window.open(url, '_blank', 'noopener');
}

/**
 * 立即顯示一則通知。台北通的 notify 只能立即通知、不能排程，
 * 所以提醒是在每次打開服務時檢查到期狀態後發出。
 * 注意：content 不可含「已訂閱…」「已取消訂閱…」，App 會把它當成訂閱指令。
 */
export function notify(title, content, fallback) {
  const safe = String(content).replace(/已(取消)?訂閱/g, '');
  if (isInApp()) {
    post('notify', { title, content: safe });
    return true;
  }
  if (fallback) fallback(title, safe);
  return false;
}

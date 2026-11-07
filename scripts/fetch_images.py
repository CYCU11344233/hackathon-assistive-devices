"""下載官網的輔具圖片，縮小後存到 web/img/（Demo 時不必連官網）。

用法：python scripts/fetch_images.py
- 類別圖：/app37/tools/showvehiclemodel/{類別}      → web/img/items/{類別}.jpg
- 款式圖：/app37/tools/showvehiclemodeltype/{款式}  → web/img/models/{款式}.jpg
款式清單取自 data/stock-snapshot.json（serve.mjs 爬庫存時產生）。主辦單位同意爬取此網站。
"""
import io, json, os, ssl, sys, time, urllib.request
from PIL import Image, ImageOps

BASE = 'https://tpap.taipei/app37/tools'
UA = 'TaipeiPass-AidHelper/0.1 (Taipei Codefest 2026 hackathon)'
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')


# 官網憑證缺 Subject Key Identifier，Python 3.13 的嚴格模式會拒絕；仍然驗證憑證，只關掉嚴格模式
CTX = ssl.create_default_context()
CTX.verify_flags &= ~getattr(ssl, 'VERIFY_X509_STRICT', 0)


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=30, context=CTX) as r:
        return r.read()


def save(data, path):
    im = Image.open(io.BytesIO(data))
    im = ImageOps.exif_transpose(im).convert('RGBA')
    bg = Image.new('RGBA', im.size, (255, 255, 255, 255))
    bg.alpha_composite(im)
    im = bg.convert('RGB')
    im.thumbnail((240, 240))
    im.save(path, quality=82, optimize=True)


def run(kind, ids, folder):
    os.makedirs(folder, exist_ok=True)
    for i in ids:
        out = os.path.join(folder, f'{i}.jpg')
        if os.path.exists(out):
            continue
        try:
            save(fetch(f'{BASE}/{kind}/{i}'), out)
            print('ok', kind, i)
        except Exception as e:  # 沒有圖或不是圖片就跳過，畫面會退回類別圖
            print('skip', kind, i, e, file=sys.stderr)
        time.sleep(0.3)


snap = json.load(open(os.path.join(ROOT, 'data', 'stock-snapshot.json'), encoding='utf8'))
run('showvehiclemodel', [c['id'] for c in snap['categories']], os.path.join(ROOT, 'web', 'img', 'items'))
run('showvehiclemodeltype', [m['id'] for c in snap['categories'] for m in c['models']], os.path.join(ROOT, 'web', 'img', 'models'))

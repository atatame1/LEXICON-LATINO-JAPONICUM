# -*- coding: utf-8 -*-
"""把 MDict 词典（.mdx / .mdd）转换成静态网页词典。

用法：
    pip install -r tools/requirements.txt
    python tools/build.py --mdx "mdx/羅和辞典.mdx" --mdd "mdx/羅和辞典.mdd" \
                          --css "mdx/llj.css" --icon "mdx/羅和辞典.png" --out . --force

产物：
    data/idx.js      检索索引（词头 → 分片位置）
    data/c*.js       正文分片，浏览器按需加载
    data/stats.js    统计数字
    img/             从 .mdd 导出的图片等资源
    assets/llj.css   词典原样式表
    assets/icon.png  词典图标
"""
import argparse
import json
import os
import shutil
import sys
import unicodedata

sys.stdout.reconfigure(encoding='utf-8')
from mdict_utils.base.readmdict import MDX, MDD

LINK_TAG = '<link href="llj.css" rel="stylesheet" type="text/css">'


def fold(s: str) -> str:
    """检索用归一化：去组合符号、转小写、连字拆开。需与 assets/app.js 里的 fold() 保持一致。"""
    s = unicodedata.normalize('NFD', s)
    s = ''.join(c for c in s if not unicodedata.combining(c))
    s = s.lower()
    for a, b in (('æ', 'ae'), ('œ', 'oe'), ('ø', 'o'), ('ł', 'l'), ('đ', 'd'), ('ð', 'd'), ('þ', 'th')):
        s = s.replace(a, b)
    return s


def clean_key(k: str) -> str:
    return k.replace('\t', ' ').replace('\n', ' ').replace('\r', ' ').strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mdx', required=True, help='主词典文件 .mdx')
    ap.add_argument('--mdd', help='资源文件 .mdd（可选）')
    ap.add_argument('--css', help='词典自带样式表（可选，会复制到 assets/llj.css）')
    ap.add_argument('--icon', help='词典图标（可选，会复制到 assets/icon.png）')
    ap.add_argument('--out', default='.', help='输出目录，默认当前目录')
    ap.add_argument('--chunk', type=int, default=600_000, help='每个正文分片的目标字节数')
    ap.add_argument('--force', action='store_true', help='允许写入非空目录')
    a = ap.parse_args()

    out = os.path.abspath(a.out)
    if os.path.isdir(out) and os.listdir(out) and not a.force:
        raise SystemExit(f'输出目录非空：{out}（确认要覆盖请加 --force）')
    for d in ('assets', 'data', 'img'):
        os.makedirs(os.path.join(out, d), exist_ok=True)

    print('读取 mdx …')
    mdx = MDX(a.mdx)
    items = list(mdx.items())
    print(f'  原始条目 {len(items)}')

    real, aliases = [], {}
    for k, v in items:
        key = clean_key(k.decode('utf-8'))
        html = v.decode('utf-8')
        if html.startswith('@@@LINK='):
            aliases[key] = html[len('@@@LINK='):].strip()
        else:
            real.append((key, html.replace(LINK_TAG, '')))
    total = sum(len(h.encode()) for _, h in real)
    print(f'  正式词条 {len(real)}，跳转条目 {len(aliases)}，正文 {total / 1048576:.1f} MB')

    # ---- 按首字母分组分片 ----
    groups = {}
    for key, html in real:
        head = fold(key)[:1]
        if not ('a' <= head <= 'z'):
            head = '#'            # 假名词条、符号、附录等并入一组，后面按体积切开
        groups.setdefault(head, []).append((key, html))

    chunks = []
    for _, rows in groups.items():
        buf, size = [], 0
        for key, html in rows:
            n = len(html.encode())
            if buf and size + n > a.chunk:
                chunks.append(buf)
                buf, size = [], 0
            buf.append((key, html))
            size += n
        if buf:
            chunks.append(buf)

    loc = {}
    for i, buf in enumerate(chunks):
        for j, (key, _) in enumerate(buf):
            loc.setdefault(key, (f'c{i}', j))     # 重复词头保留第一条

    # ---- 索引（保持 mdx 原顺序）----
    rows = []
    for k, _ in items:
        key = clean_key(k.decode('utf-8'))
        if key in aliases:
            tgt = aliases[key]
            hit = loc.get(tgt)
            if hit is None:
                low = {x.lower(): x for x in loc}
                t = low.get(tgt.lower())
                hit = loc.get(t) if t else None
            if hit is None:
                continue
            rows.append([key, hit[0], str(hit[1]), '1', tgt])
        else:
            hit = loc.get(key)
            if hit is None:
                continue
            rows.append([key, hit[0], str(hit[1]), '0', ''])
    print(f'  索引条目 {len(rows)}（含 {sum(1 for r in rows if r[3] == "1")} 个跳转）')

    idx_path = os.path.join(out, 'data', 'idx.js')
    with open(idx_path, 'w', encoding='utf-8', newline='\n') as f:
        f.write('window.__IDX=')
        f.write(json.dumps('\n'.join('\t'.join(r) for r in rows), ensure_ascii=False)
                .replace('\u2028', '\\u2028').replace('\u2029', '\\u2029'))
        f.write(';\n')
    print(f'  idx.js {os.path.getsize(idx_path) / 1048576:.2f} MB')

    for i, buf in enumerate(chunks):
        payload = json.dumps([h for _, h in buf], ensure_ascii=False, separators=(',', ':'))
        payload = payload.replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')
        with open(os.path.join(out, 'data', f'c{i}.js'), 'w', encoding='utf-8', newline='\n') as f:
            f.write(f'window.__CH("c{i}",{payload});\n')
    print(f'  正文分片 {len(chunks)} 个')

    # ---- mdd 资源 ----
    n = 0
    if a.mdd:
        print('读取 mdd …')
        mdd = MDD(a.mdd)
        for k, v in mdd.items():
            name = k.decode('utf-8', 'replace').replace('\\', '/').lstrip('/')
            if not name or name.endswith('/'):
                continue
            dst = os.path.join(out, name)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, 'wb') as f:
                f.write(v)
            n += 1
        print(f'  导出资源 {n} 个')

    if a.css:
        shutil.copy(a.css, os.path.join(out, 'assets', 'llj.css'))
    if a.icon:
        shutil.copy(a.icon, os.path.join(out, 'assets', 'icon.png'))

    stats = {'entries': len(real), 'aliases': len(aliases), 'total': len(rows), 'chunks': len(chunks)}
    with open(os.path.join(out, 'data', 'stats.js'), 'w', encoding='utf-8', newline='\n') as f:
        f.write('window.__STATS=' + json.dumps(stats) + ';\n')
    print('完成:', stats)


if __name__ == '__main__':
    main()

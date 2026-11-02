#!/usr/bin/env python3
"""
二维码 PNG 转 1-bit 黑白。

qrcode 库输出的是 RGBA，对纯黑白图案是三倍的浪费。转成 1-bit 位图后
体积降到 1/3，且这本来就是印刷 RIP 最想要的格式（纯黑白无中间调，
不会因为抗锯齿灰边导致模块边缘发虚）。

注意 dither 必须关掉 —— Pillow 的 convert('1') 默认开 Floyd-Steinberg，
对纯黑白源虽然无害，但一旦源图带了抗锯齿就会把模块边缘打成噪点。
"""
import sys, os
from PIL import Image

root = sys.argv[1]
n = 0
for dirpath, _, files in os.walk(root):
    for f in files:
        if not f.endswith('.png'):
            continue
        p = os.path.join(dirpath, f)
        im = Image.open(p)
        if im.mode in ('RGBA', 'LA'):
            bg = Image.new('RGB', im.size, 'white')
            bg.paste(im, mask=im.split()[-1])
            im = bg
        im.convert('L').convert('1', dither=Image.Dither.NONE).save(p, optimize=True, bits=1)
        n += 1
        if n % 5000 == 0:
            print(f'  ... {n}', flush=True)
print(f'转换 {n} 个文件')

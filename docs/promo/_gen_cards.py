import io, os

OUT = "F:/Project/Reader/docs/promo"

MARK = '''<svg class="mark" viewBox="0 0 400 240" width="46" height="28">
<defs>
<linearGradient id="rp" x1="35%" y1="0%" x2="80%" y2="100%">
<stop offset="0%" stop-color="#1E3F7A"/><stop offset="45%" stop-color="#355FA3"/>
<stop offset="85%" stop-color="#5885CC"/><stop offset="100%" stop-color="#87AEE6" stop-opacity="0.75"/>
</linearGradient>
<linearGradient id="lp" x1="10%" y1="85%" x2="75%" y2="20%">
<stop offset="0%" stop-color="#1D4180"/><stop offset="40%" stop-color="#4572BD"/>
<stop offset="80%" stop-color="#7EA6E0" stop-opacity="0.8"/><stop offset="100%" stop-color="#B9D2F5" stop-opacity="0.35"/>
</linearGradient>
<linearGradient id="wv" x1="0%" y1="50%" x2="100%" y2="65%">
<stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.05"/><stop offset="38%" stop-color="#EBF3FF" stop-opacity="0.72"/>
<stop offset="72%" stop-color="#769FDB" stop-opacity="0.55"/><stop offset="100%" stop-color="#4673BD" stop-opacity="0.1"/>
</linearGradient>
<linearGradient id="wv2" x1="15%" y1="30%" x2="95%" y2="85%">
<stop offset="0%" stop-color="#2D569C" stop-opacity="0.75"/><stop offset="50%" stop-color="#6A94D4" stop-opacity="0.45"/>
<stop offset="100%" stop-color="#ADC8F0" stop-opacity="0.15"/>
</linearGradient>
</defs>
<path d="M 168 126 L 204 54 C 210 42, 222 42, 231 53 L 366 196 C 324 186, 276 162, 230 144 C 206 135, 186 130, 168 126 Z" fill="url(#rp)"/>
<path d="M 142 120 L 175 62 C 181 51, 192 51, 200 61 L 304 182 C 254 166, 200 140, 142 120 Z" fill="url(#wv)" opacity="0.6"/>
<path d="M 34 196 L 132 90 C 141 80, 154 80, 164 90 L 284 188 C 230 162, 174 146, 122 156 C 88 162, 58 178, 34 196 Z" fill="url(#lp)"/>
<path d="M 176 112 C 205 116, 235 132, 266 154 C 298 176, 332 190, 366 196 C 322 194, 278 182, 238 160 C 202 140, 172 132, 142 136 C 154 126, 165 117, 176 112 Z" fill="url(#wv)"/>
<path d="M 94 162 C 146 142, 198 148, 254 174 C 292 191, 330 198, 366 196 C 316 192, 268 172, 224 148 C 184 126, 142 134, 94 162 Z" fill="url(#wv2)"/>
</svg>'''

HILL = '''<svg class="hill" viewBox="0 0 1080 260" preserveAspectRatio="none">
<path d="M 0 260 L 0 198 C 130 190 250 174 360 150 C 450 130 520 106 590 82 C 650 62 706 58 758 72 C 800 84 840 94 880 98 C 946 106 1014 118 1080 126 L 1080 260 Z" fill="#E4EDFA" opacity="0.85"/>
<path d="M 120 260 L 120 218 C 240 210 360 194 470 172 C 560 154 630 128 700 106 C 750 90 796 86 850 96 C 926 106 1004 126 1080 140 L 1080 260 Z" fill="#D4E2F5" opacity="0.8"/>
<path d="M 280 260 L 280 236 C 400 228 520 212 620 192 C 700 176 764 156 828 138 C 848 132 866 134 880 138 C 948 149 1014 164 1080 176 L 1080 260 Z" fill="#C2D5EE" opacity="0.7"/>
</svg>'''

BASE = '''*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1080px;height:1080px;overflow:hidden}
body{font-family:"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif;
  background:linear-gradient(135deg,#FDFDFE 0%,#F6F9FD 55%,#E9F0FA 100%);}
.card{position:relative;width:1080px;height:1080px;padding:76px;display:flex;flex-direction:column;overflow:hidden}
.head{display:flex;align-items:center;gap:14px;position:relative;z-index:2;flex:none}
.head .divider{width:1px;height:26px;background:#C6CFDD}
.head .cn{font-size:21px;letter-spacing:5px;color:#2A313D}
.head .en{font-size:9.5px;letter-spacing:5px;color:#6B7688;margin-top:3px}
.hill{position:absolute;left:0;bottom:0;width:1080px;height:260px;z-index:0}
.body{flex:1;display:flex;flex-direction:column;justify-content:center;position:relative;z-index:2}
.foot{position:relative;z-index:2}
.t{font-size:33px;font-weight:600;letter-spacing:0.02em;color:#1B2129;line-height:1.4}
.s{font-size:16px;color:#5A6472;margin-top:14px;line-height:1.6}
.n{position:absolute;right:76px;top:86px;font-size:12px;letter-spacing:0.18em;color:#A6B1C2;z-index:2}
.hero{font-size:92px;font-weight:600;letter-spacing:0.02em;line-height:1.24;color:#1B2129}
.hero-sub{font-size:20px;color:#4E5867;margin-top:26px;letter-spacing:0.03em}
.shot{display:block;width:1080px;height:340px;object-fit:cover;object-position:top center;margin:0 -76px;flex:none;border-top:1px solid #E4EAF3;border-bottom:1px solid #E4EAF3}
'''


def page(body, title, sub, num, extra_css="", grouped=False):
    head = '<div class="head">' + MARK + '<div class="divider"></div><div><div class="cn">岑序</div><div class="en">CENRO</div></div></div>'
    foot = '<div class="foot"><div class="t">' + title + '</div><div class="s">' + sub + '</div></div>'
    if grouped:
        main = '<div class="body">' + body + foot + '</div>'
    else:
        main = '<div class="body">' + body + '</div>' + foot
    return ('<!doctype html>\n<html><head><meta charset="utf-8"><style>\n'
            + BASE + extra_css +
            '\n</style></head><body>\n<div class="card">\n  ' + HILL + '\n  ' + head
            + '\n  ' + main + '\n  <div class="n">' + num + '</div>\n</div>\n</body></html>')


cards = []

cards.append(page(
 '<div class="hero">所有格式，<br>一座书架。</div><div class="hero-sub">小说、漫画、PDF —— 收进同一个书架</div>',
 '不联网，不要账号', '内容与阅读进度全部留在本机', '01 / 06',
 '.body{justify-content:center;padding-bottom:56px}'))

cards.append(page(
 '<img class="shot" src="cenro-shelf.webp">',
 '十二本书，三类内容，一个书架', '小说、漫画、文档混排，进度各自记着', '02 / 06',
 '.body{justify-content:center}.foot{margin-top:52px}', grouped=True))

cards.append(page(
 '<img class="shot" src="cenro-reader.webp">',
 '划词就划线，笔记贴在原文旁边', '改字号、换行距、切分页，划线都不会漂', '03 / 06',
 '.body{justify-content:center}.foot{margin-top:52px}.shot{-webkit-mask-image:linear-gradient(to bottom,#000 76%,rgba(0,0,0,0) 100%);mask-image:linear-gradient(to bottom,#000 76%,rgba(0,0,0,0) 100%);border-bottom:0}', grouped=True))

cards.append(page(
 '<div class="cols">'
 '<div class="col"><h4>小说</h4><p>EPUB<br>MOBI<br>AZW3<br>FB2<br>TXT<br>Markdown<br>HTML</p></div>'
 '<div class="col"><h4>漫画</h4><p>CBZ<br>CBR<br>CBT<br>CB7<br>ZIP<br>图片文件夹</p></div>'
 '<div class="col"><h4>文档</h4><p>PDF<br>OFD<br>DOCX<br>RTF<br>XLSX<br>MHTML</p></div>'
 '</div>',
 '能读什么', '十余种格式，不用装第二个阅读器', '04 / 06',
 '.cols{display:flex}.col{flex:1}.col h4{font-size:15px;font-weight:500;color:#2F6FEB;letter-spacing:0.16em;margin-bottom:22px}.col p{font-size:26px;line-height:2.05;color:#2B333F;letter-spacing:0.01em}.body{justify-content:center}.foot{margin-top:58px}', grouped=True))

cards.append(page(
 '<div class="hero" style="font-size:74px">不联网，<br>也能读完一整本。</div>'
 '<div class="pts">'
 '<div class="pt"><b>不要账号</b><span>装完就能读，没有登录这一步</span></div>'
 '<div class="pt"><b>不要书源</b><span>书从磁盘进，读完还在磁盘上</span></div>'
 '<div class="pt"><b>数据在你机器上</b><span>备份就是一个普通 zip，解开能看见 cenro.db</span></div>'
 '</div>',
 '本地优先', '断网、换机、十年后，都还是你的', '05 / 06',
 '.pts{margin-top:46px}.pt{display:flex;align-items:baseline;gap:22px;padding:16px 0;border-top:1px solid rgba(32,41,56,0.09)}.pt b{font-size:19px;font-weight:500;color:#1B2129;min-width:204px}.pt span{font-size:15px;color:#5A6472}.body{justify-content:center}.foot{margin-top:56px}', grouped=True))

cards.append(page(
 '<div class="qrwrap"><img class="qr" src="cenro-qr.png" width="340" height="340"></div><div class="urlline">lingmeng.net.cn/apps/cenro</div>',
 '扫码看详情与下载', 'Windows 10+ / Android 8+ · 免费开源', '06 / 06',
 '.body{align-items:flex-start;justify-content:center}.qrwrap{background:#fff;border:1px solid #E6EBF3;border-radius:28px;padding:24px;display:inline-block}.qr{display:block;width:340px;height:340px}.urlline{font-size:19px;color:#2F6FEB;margin-top:28px;letter-spacing:0.02em}.foot{margin-top:52px}', grouped=True))

for i, html in enumerate(cards, 1):
    io.open(os.path.join(OUT, "card-%d.html" % i), "w", encoding="utf-8").write(html)
print("written", len(cards))

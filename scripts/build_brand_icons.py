"""从同一组贝塞尔路径生成新品牌 SVG、透明 PNG 与 Windows 多尺寸 ICO。"""
from pathlib import Path
import shutil
from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets/brand"
# 开放式声带构成 V，铜色折线强调声音与流动；不使用默认字体图标。
RIBBON = [("M", 160, 222), ("C", 210, 177, 270, 185, 306, 255), ("L", 493, 623),
          ("C", 507, 650, 528, 652, 543, 622), ("L", 745, 223),
          ("C", 774, 164, 830, 148, 875, 184), ("C", 901, 205, 902, 233, 886, 265),
          ("L", 635, 764), ("C", 589, 857, 482, 878, 418, 819),
          ("C", 395, 798, 380, 771, 367, 745), ("L", 143, 305), ("C", 127, 273, 132, 245, 160, 222)]
ECHO = [("M", 745, 223), ("C", 774, 164, 830, 148, 875, 184),
        ("C", 901, 205, 902, 233, 886, 265), ("L", 710, 614),
        ("C", 691, 652, 646, 669, 609, 651), ("L", 579, 636),
        ("C", 627, 611, 645, 575, 663, 539), ("L", 745, 223)]


def points(commands, scale):
    result = []
    current = (0, 0)
    for command in commands:
        if command[0] in ("M", "L"):
            current = command[1:]; result.append(tuple(v * scale for v in current))
        else:
            start = current; a, b, end = command[1:3], command[3:5], command[5:7]
            for i in range(1, 65):
                t = i / 64; u = 1 - t
                result.append(tuple(scale * (u**3 * start[k] + 3*u*u*t*a[k] + 3*u*t*t*b[k] + t**3*end[k]) for k in (0, 1)))
            current = end
    return result


def svg_path(commands):
    return " ".join(command[0] + " " + " ".join(map(str, command[1:])) for command in commands) + " Z"


def generate():
    OUT.mkdir(parents=True, exist_ok=True)
    size = 2048; scale = size / 1024
    image = Image.new("RGBA", (size, size))
    colors = [(RIBBON, "#426658", "#172e29"), (ECHO, "#e3ba87", "#b77d50")]
    for commands, top, bottom in colors:
        mask = Image.new("L", (size, size)); ImageDraw.Draw(mask).polygon(points(commands, scale), fill=255)
        gradient = ImageOps.colorize(Image.linear_gradient("L").resize((size, size)), top, bottom).convert("RGBA")
        image.paste(gradient, (0, 0), mask)
    master = image.resize((1024, 1024), Image.Resampling.LANCZOS)
    for installer in (False, True):
        asset = master.copy(); suffix = "installer" if installer else "app"
        overlay = ""
        if installer:
            draw = ImageDraw.Draw(asset); draw.ellipse((672, 672, 970, 970), fill="#fbfaf7")
            draw.ellipse((692, 692, 950, 950), fill="#b77d50")
            draw.line([(821, 750), (821, 870)], fill="white", width=26)
            draw.line([(770, 822), (821, 873), (872, 822)], fill="white", width=26, joint="curve")
            overlay = '<circle cx="821" cy="821" r="149" fill="#fbfaf7"/><circle cx="821" cy="821" r="129" fill="#b77d50"/><path d="M821 750V870M770 822L821 873L872 822" stroke="white" stroke-width="26" fill="none" stroke-linejoin="round"/>'
        asset.save(OUT / f"voxcpm-{suffix}.png")
        asset.resize((256, 256), Image.Resampling.LANCZOS).save(OUT / f"voxcpm-{suffix}-256.png")
        asset.save(OUT / f"voxcpm-{suffix}.ico", sizes=[(n, n) for n in (16, 20, 24, 32, 40, 48, 64, 96, 128, 256)])
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><linearGradient id="body" x2="0" y2="1"><stop stop-color="#426658"/><stop offset="1" stop-color="#172e29"/></linearGradient><linearGradient id="echo" x2="0" y2="1"><stop stop-color="#e3ba87"/><stop offset="1" stop-color="#b77d50"/></linearGradient></defs>'
        svg += f'<path d="{svg_path(RIBBON)}" fill="url(#body)"/><path d="{svg_path(ECHO)}" fill="url(#echo)"/>{overlay}</svg>'
        (OUT / f"voxcpm-{suffix}.svg").write_text(svg, encoding="utf-8")
        assert asset.getpixel((0, 0))[3] == 0 and asset.getextrema()[3] == (0, 255)
    print("全新透明品牌图标：", OUT)
    frontend = ROOT / "frontend/voxcpm_studio_electron"
    shutil.copy2(OUT / "voxcpm-app.ico", frontend / "app.ico")
    shutil.copy2(OUT / "voxcpm-app-256.png", frontend / "app-icon.png")


if __name__ == "__main__":
    generate()

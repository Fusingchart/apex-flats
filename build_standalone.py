#!/usr/bin/env python3
"""Build Apex Flats as a single HTML file with its runtime assets embedded."""
from __future__ import annotations

import base64
import io
import json
import mimetypes
import re
import urllib.request
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent
OUTPUT = Path('/Users/MasterOogway/Documents/claude-gta5-remake.html')


def read_cdn(url: str) -> str:
    request = urllib.request.Request(url, headers={'User-Agent': 'ApexFlatsStandaloneBuilder/1.0'})
    with urllib.request.urlopen(request, timeout=45) as response:
        return response.read().decode('utf-8')


def script_text(source: str) -> str:
    # Prevent HTML's raw-text parser from ending an inline script prematurely.
    return re.sub(r'</script', r'<\/script', source, flags=re.IGNORECASE)


def asset_mime(path: Path) -> str:
    suffix = path.suffix.lower()
    return {
        '.glb': 'model/gltf-binary',
        '.hdr': 'application/octet-stream',
        '.json': 'application/json',
    }.get(suffix, mimetypes.guess_type(path.name)[0] or 'application/octet-stream')

def procedural_sky_script() -> str:
    return '''<script>
window.createProceduralSky = function () {
  const width = 256, height = 128;
  const rgbe = new Uint8Array(width * height * 4);
  const env = new Float32Array(width * height * 4);
  const horizon = new Float32Array(64 * 3);
  for (let y = 0; y < height; y++) {
    const t = y / (height - 1);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rgbe[i] = 125 + Math.round(34 * t);
      rgbe[i + 1] = 177 + Math.round(48 * t);
      rgbe[i + 2] = 224 + Math.round(30 * t);
      rgbe[i + 3] = 119;
      env[i] = 0.20 + 0.12 * t;
      env[i + 1] = 0.34 + 0.16 * t;
      env[i + 2] = 0.56 + 0.16 * t;
      env[i + 3] = 1;
    }
  }
  for (let i = 0; i < 64; i++) {
    horizon[i * 3] = 0.45;
    horizon[i * 3 + 1] = 0.57;
    horizon[i * 3 + 2] = 0.69;
  }
  const skyTex = new THREE.DataTexture(rgbe, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  skyTex.magFilter = THREE.LinearFilter; skyTex.minFilter = THREE.LinearFilter;
  skyTex.generateMipmaps = false; skyTex.wrapS = THREE.RepeatWrapping; skyTex.needsUpdate = true;
  const envTex = new THREE.DataTexture(env, width, height, THREE.RGBAFormat, THREE.FloatType);
  envTex.mapping = THREE.EquirectangularReflectionMapping;
  envTex.magFilter = THREE.LinearFilter; envTex.needsUpdate = true;
  return { W: width, H: height, skyTex, envTex,
    sunDir: new THREE.Vector3(-0.25, 0.72, 0.64).normalize(),
    sunColor: [1, 0.93, 0.82], horizon, gain: 1 };
};
</script>'''

def embedded_payload(path: Path, relative: str) -> bytes:
    if relative.startswith('assets/tex/') or relative.startswith('assets/cars/previews/'):
        is_preview = relative.startswith('assets/cars/previews/')
        max_dimension, quality = (400, 80) if is_preview else (1024, 75)
        with Image.open(path) as image:
            image.thumbnail((max_dimension, max_dimension), Image.Resampling.LANCZOS)
            image = image.convert('RGB')
            output = io.BytesIO()
            image.save(output, format='JPEG', quality=quality, optimize=True)
            return output.getvalue()
    return path.read_bytes()



def make_asset_map() -> dict[str, str]:
    assets = {}
    for path in sorted((ROOT / 'assets').rglob('*')):
        if not path.is_file():
            continue
        relative = path.relative_to(ROOT).as_posix()
        if relative == 'assets/sky/sky_4k.hdr':
            continue
        encoded = base64.b64encode(embedded_payload(path, relative)).decode('ascii')
        assets[relative] = f'data:{asset_mime(path)};base64,{encoded}'
    if not assets:
        raise RuntimeError('No assets were found under assets/.')
    return assets


def inline_local_script(url: str) -> str:
    path = url.split('?', 1)[0].split('#', 1)[0]
    source_path = ROOT / path
    if not source_path.is_file():
        raise FileNotFoundError(f'HTML references missing script: {path}')
    source = source_path.read_text(encoding='utf-8')
    if path == 'src/main.js':
        old_sky = "const SKY = await loadHDR('assets/sky/sky_4k.hdr');"
        if source.count(old_sky) != 1:
            raise RuntimeError('Expected exactly one HDR load call in src/main.js')
        # the real photographed sky, at 2K so the single file stays a sensible size
        source = source.replace(old_sky, "const SKY = await loadHDR('assets/sky/sky_2k.hdr').catch(() => window.createProceduralSky());", 1)
        preview_path = 'src="assets/cars/previews/${pr.id}.jpg"'
        if source.count(preview_path) != 1:
            raise RuntimeError('Expected exactly one dynamic car preview URL in src/main.js')
        source = source.replace(
            preview_path,
            'src="${__assetUrl(\'assets/cars/previews/\' + pr.id + \'.jpg\')}"',
            1,
        )
    return '<script>\n' + script_text(source) + '\n</script>'


def inline_script_tag(match: re.Match[str]) -> str:
    url = match.group(1)
    if re.fullmatch(r'https://cdn\.jsdelivr\.net/npm/three@[^/]+/build/three\.min\.js', url):
        return match.group(0)
    if url.startswith(('https://', 'http://')):
        try:
            source = read_cdn(url)
        except Exception as exc:
            raise RuntimeError(f'Unable to embed CDN script {url}: {exc}') from exc
        return '<script>\n' + script_text(source) + '\n</script>'
    return inline_local_script(url)


def main() -> None:
    html = (ROOT / 'index.html').read_text(encoding='utf-8')
    assets = make_asset_map()

    # Everything, Three.js included (vendor/), is inlined: the file runs offline.
    html = re.sub(
        r'<script\b[^>]*\bsrc=["\']([^"\']+)["\'][^>]*>\s*</script\s*>',
        inline_script_tag,
        html,
        flags=re.IGNORECASE,
    )

    def inline_stylesheet(match: re.Match[str]) -> str:
        url = match.group(1)
        if url.startswith(('https://', 'http://')):
            # External web fonts are decorative; omit them so the output makes no network requests.
            return ''
        path = (ROOT / url.split('?', 1)[0].split('#', 1)[0]).resolve()
        if ROOT not in path.parents or not path.is_file():
            raise FileNotFoundError(f'HTML references missing stylesheet: {url}')
        css = path.read_text(encoding='utf-8')
        return '<style>\n' + css.replace('</style', '<\\/style') + '\n</style>'

    html = re.sub(
        r'<link\b(?=[^>]*\brel=["\']stylesheet["\'])[^>]*\bhref=["\']([^"\']+)["\'][^>]*>',
        inline_stylesheet,
        html,
        flags=re.IGNORECASE,
    )

    asset_script = (
        '<script>\n'
        'const __embeddedAssets = ' + json.dumps(assets, separators=(',', ':')) + ';\n'
        'function __assetUrl(url) {\n'
        '  const value = String(url);\n'
        '  const key = value.replace(/^\\.\\//, "").split(/[?#]/, 1)[0];\n'
        '  return __embeddedAssets[key] || value;\n'
        '}\n'
        '(() => {\n'
        '  const nativeFetch = window.fetch.bind(window);\n'
        '  window.fetch = (input, init) => nativeFetch(__assetUrl(input instanceof Request ? input.url : input), init);\n'
        '  const fileLoad = THREE.FileLoader.prototype.load;\n'
        '  THREE.FileLoader.prototype.load = function(url, ...args) { return fileLoad.call(this, __assetUrl(url), ...args); };\n'
        '  const imageLoad = THREE.ImageLoader.prototype.load;\n'
        '  THREE.ImageLoader.prototype.load = function(url, ...args) { return imageLoad.call(this, __assetUrl(url), ...args); };\n'
        '})();\n'
        '</script>'
    )
    asset_script += '\n' + procedural_sky_script()
    marker = re.search(r'<script>\s*THREE\.ColorManagement\.legacyMode', html)
    if not marker:
        raise RuntimeError('Could not find the point after Three.js to install offline asset loading.')
    html = html[:marker.start()] + asset_script + '\n' + html[marker.start():]
    html = re.sub(r'<link\b(?=[^>]*\brel=["\']preconnect["\'])[^>]*>', '', html, flags=re.IGNORECASE)
    # the model studio is a separate page that the single file doesn't carry
    html = re.sub(r'\s*<a href="car-studio\.html"[^>]*>.*?</a>', '', html)
    external_scripts = re.findall(r'<script\b[^>]*\bsrc=["\']([^"\']+)["\'][^>]*>', html, re.IGNORECASE)
    if '__embeddedAssets' not in html or external_scripts:
        raise RuntimeError('Standalone conversion left an unexpected external script or failed to install its asset map.')

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(html, encoding='utf-8')
    print(f'Wrote {OUTPUT} ({OUTPUT.stat().st_size:,} bytes; {len(assets)} embedded assets).')


if __name__ == '__main__':
    main()

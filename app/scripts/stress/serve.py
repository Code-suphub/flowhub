"""Isolated synthetic harness. Copies referenced UI assets, never user data."""
from pathlib import Path
import functools
import http.server
import re
import shutil
import tempfile

UI = Path(__file__).resolve().parents[2] / 'ui'


def build_fixture(root, ui=UI):
    root = Path(root)
    html = (ui / 'search.html').read_text()
    for adapter in ('tauri-adapter', 'browser-adapter'):
        pattern = rf'<script\b[^>]*src=["\']shared/{adapter}\.js["\'][^>]*>\s*</script>'
        html, count = re.subn(pattern, '', html)
        if count != 1:
            raise ValueError(f'Cannot isolate adapter: {adapter}')
    # Fixture runs before any script; React's deferred entry remains intact.
    html = html.replace('<head>', '<head><script src="fixture.js"></script>', 1)
    controls = '''<aside style="position:fixed;top:4px;left:4px;z-index:9999">
<button id="runStress" data-stress-run="stress">Run stress</button>
<button data-stress-run="paging">Run paging checks</button>
<button data-stress-run="timing">Run stage timing</button></aside>
<pre id="stressReport" style="position:fixed;right:0;top:40px;z-index:9999;background:var(--fh-canvas);color:var(--fh-text);font-size:11px;max-width:620px;max-height:85vh;overflow:auto"></pre>
<script defer src="stress.js"></script>'''
    html = html.replace('</body>', controls + '</body>')
    for relative in re.findall(r'(?:src|href)=["\']([^"\']+)["\']', html):
        if relative in ('fixture.js', 'stress.js'):
            source = Path(__file__).with_name(relative)
        else:
            source = (ui / relative).resolve()
            if not source.is_relative_to(ui.resolve()) or source.suffix not in ('.js', '.css'):
                raise ValueError(f'Unexpected fixture asset: {relative}')
        if not source.is_file():
            raise FileNotFoundError(f'Missing {relative}; run npm run build:ui first')
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(source, target)
    (root / 'index.html').write_text(html)


def main():
    with tempfile.TemporaryDirectory(prefix='flowhub-stress-') as directory:
        build_fixture(directory)
        print('Open http://127.0.0.1:8766 and choose a synthetic check.', flush=True)
        http.server.ThreadingHTTPServer(('127.0.0.1', 8766), functools.partial(
            http.server.SimpleHTTPRequestHandler, directory=directory)).serve_forever()


if __name__ == '__main__':
    main()

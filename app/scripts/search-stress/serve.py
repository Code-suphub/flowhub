"""Isolated synthetic-data harness; does not load the user's config or clipboard."""
from pathlib import Path
import tempfile, shutil, http.server, functools
ui = Path(__file__).resolve().parents[2] / 'ui'
with tempfile.TemporaryDirectory(prefix='flowhub-stress-') as directory:
    root = Path(directory)
    for glob in ('*.js', '*.css'):
        for source in ui.glob(glob): shutil.copy(source, root / source.name)
    for name in ('fixture.js', 'stress.js'): shutil.copy(Path(__file__).with_name(name), root / name)
    html = (ui / 'search.html').read_text().replace('<script src="tauri-adapter.js"></script>', '<script src="fixture.js"></script>').replace('<script src="browser-adapter.js"></script>', '')
    html = html.replace('</body>', '<button id="runStress" style="position:fixed;top:4px;left:4px;z-index:9999">Run stress</button><pre id="stressReport" style="position:fixed;right:0;top:0;z-index:9999;background:#111;font-size:11px;max-width:620px;max-height:90vh;overflow:auto"></pre><script src="stress.js"></script></body>')
    (root / 'index.html').write_text(html)
    print('Open http://127.0.0.1:8766 and click Run stress / Run paging checks.', flush=True)
    http.server.ThreadingHTTPServer(('127.0.0.1', 8766), functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)).serve_forever()

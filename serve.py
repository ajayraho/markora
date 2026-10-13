"""Serve Markora's dist/ folder locally:  python serve.py  ->  http://localhost:4173"""
import http.server, functools, os, webbrowser

PORT = 4173
DIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist")

class Handler(http.server.SimpleHTTPRequestHandler):
    # Windows' registry can map .js to text/plain, which breaks module scripts; force the right types
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".css": "text/css", ".webmanifest": "application/manifest+json",
                      ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf"}
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

print(f"Markora running at http://localhost:{PORT}  (Ctrl+C to stop)")
webbrowser.open(f"http://localhost:{PORT}")
http.server.ThreadingHTTPServer(("localhost", PORT), functools.partial(Handler, directory=DIST)).serve_forever()

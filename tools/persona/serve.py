import http.server, os, sys
root, frames = sys.argv[1], sys.argv[2]
os.makedirs(frames, exist_ok=True)

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=root, **k)
    def end_headers(self):
        self.send_header("Cache-Control", "no-store"); super().end_headers()
    def do_POST(self):
        name = self.path.rsplit("/", 1)[1]
        data = self.rfile.read(int(self.headers["Content-Length"]))
        open(os.path.join(frames, name + ("" if name == "states" else ".jpg")), "wb").write(data)
        self.send_response(204); self.end_headers()
    def log_message(self, *a): pass

http.server.ThreadingHTTPServer(("127.0.0.1", 8932), H).serve_forever()

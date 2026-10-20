"""Generate or edit one image with the Gemini API (Nano Banana) and log it.

Every call appends {file, model, prompt, references, seconds} to prompts.json next to the output, so each
mockup can be traced and re-made. The key is read from the environment variable named by --key-env
(default `gemini_key`); it is never written anywhere.

  python tools/gen_image.py --prompt-file prompts/tower-south.txt --output assets/mockups/tower-south.png
  python tools/gen_image.py --ref assets/mockups/tower-south.png --prompt-file prompts/tower-north.txt \
      --output assets/mockups/tower-north.png
"""
from pathlib import Path
import argparse, base64, json, mimetypes, os, sys, time, urllib.error, urllib.request

p = argparse.ArgumentParser()
p.add_argument('--model', default='gemini-3-pro-image')
p.add_argument('--prompt'); p.add_argument('--prompt-file')
p.add_argument('--ref', action='append', default=[], help='Reference image(s), in order')
p.add_argument('--output', required=True)
p.add_argument('--aspect', default='9:16')
p.add_argument('--size', default='2K', help='1K, 2K or 4K')
p.add_argument('--key-env', default='gemini_key')
a = p.parse_args()
prompt = a.prompt if a.prompt else Path(a.prompt_file).read_text().strip()

parts = [{'text': prompt}]
for r in a.ref:
    parts.append({'inline_data': {'mime_type': mimetypes.guess_type(r)[0] or 'image/png',
                                  'data': base64.b64encode(Path(r).read_bytes()).decode()}})
body = {'contents': [{'parts': parts}],
        'generationConfig': {'responseModalities': ['IMAGE'], 'imageConfig': {'aspectRatio': a.aspect, 'imageSize': a.size}}}
req = urllib.request.Request(f'https://generativelanguage.googleapis.com/v1beta/models/{a.model}:generateContent',
                             data=json.dumps(body).encode(),
                             headers={'x-goog-api-key': os.environ[a.key_env], 'Content-Type': 'application/json'})
t0 = time.time()
try:
    with urllib.request.urlopen(req, timeout=600) as resp: out = json.load(resp)
except urllib.error.HTTPError as e:
    sys.exit(f'HTTP {e.code}: {e.read().decode()[:2000]}')
images = [q['inlineData'] for c in out.get('candidates', []) for q in c.get('content', {}).get('parts', []) if 'inlineData' in q]
if not images: sys.exit('no image returned: ' + json.dumps(out)[:2000])
dest = Path(a.output); dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_bytes(base64.b64decode(images[-1]['data']))
usage = out.get('usageMetadata', {})
log_path = dest.parent / 'prompts.json'
log = json.loads(log_path.read_text()) if log_path.exists() else []
log = [e for e in log if e['file'] != dest.name] + [{'file': dest.name, 'model': a.model, 'prompt': prompt,
       'references': [Path(r).name for r in a.ref], 'aspect': a.aspect, 'size': a.size,
       'output_tokens': usage.get('candidatesTokenCount'), 'seconds': round(time.time() - t0, 1)}]
log_path.write_text(json.dumps(log, indent=2, ensure_ascii=False) + '\n')
print(json.dumps({'file': str(dest), 'seconds': round(time.time() - t0, 1)}))

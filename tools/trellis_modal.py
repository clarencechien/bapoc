"""TRELLIS.2 image-to-3D on Modal H100, single image or a turnaround (front/back/left/right).

Carried over from clarencechien/yukimura (tools/trellis_modal.py, tools/multiview/trellis_multiview_modal.py):
- RGBA input; the null background remover skips the separately gated RMBG-2.0.
- Multiview = the ComfyUI-Trellis2 (visualbruno, MIT) region-wise sampler: for the positive conditioning each
  flow model runs once per view and the velocities are blended by voxel position (front of the volume follows
  the front image, and so on). It is guidance, not reconstruction, so the views must agree in scale and pose.
- Voxel axes measured in yukimura: exported GLB = (x, z, -y) of voxel space; z up, front = -y, left = +x.

Weights and the verified CUDA image are shared with yukimura (Volume `yukimura-trellis2-cache`, HF_HOME on it);
results go to results/bapoc/<name>/ on that Volume and are downloaded to --output.

  python tools/run_trellis.py --name tower --views front=assets/inputs/tower-south.png,back=...,left=...,right=...
  python tools/run_trellis.py --name prop-bess --views front=assets/inputs/prop-bess.png --faces 120000 --texture 2048
"""
from pathlib import Path
import os
import modal

app = modal.App('bapoc-trellis2')
cache = modal.Volume.from_name('yukimura-trellis2-cache')
image = modal.Image.from_id('im-CWPfod9BzDeCjqD07JU8Ui')      # TRELLIS.2 CUDA image verified in yukimura
secrets = [] if os.environ.get('TRELLIS_ENVIRONMENT_CHECK_ONLY') == '1' else [
    modal.Secret.from_name(os.environ.get('TRELLIS_HF_SECRET', 'trellis-huggingface'), required_keys=['HF_TOKEN'])]
ROOT = 'results/bapoc'
DIRECTIONS = {'front': (0, -1), 'back': (0, 1), 'left': (1, 0), 'right': (-1, 0)}   # (x, y) in voxel space


@app.function(image=image, gpu='H100', cpu=4, memory=49152, timeout=3600, startup_timeout=1200, max_containers=4,
              scaledown_window=2, retries=0, volumes={'/cache': cache}, secrets=secrets)
def generate(name: str, views: dict, seed: int = 7, temperature: float = 2.0, pipeline_type: str = '1536_cascade',
             faces: int = 400000, texture: int = 4096):
    import io, json, time, hashlib, tempfile
    import torch, o_voxel
    from PIL import Image
    from huggingface_hub import hf_hub_download
    from trellis2.pipelines import Trellis2ImageTo3DPipeline, rembg
    started = time.monotonic(); out = Path('/cache') / ROOT / f'{name}-seed-{seed}'; out.mkdir(parents=True, exist_ok=True)
    repo = 'microsoft/TRELLIS.2-4B'; config = json.loads(Path(hf_hub_download(repo, 'pipeline.json')).read_text())
    for key, path in config['args']['models'].items():
        if path.startswith('ckpts/'): config['args']['models'][key] = f'{repo}/{path}'
    config['args']['rembg_model'] = {'name': 'ProvidedAlpha', 'args': {}}; rembg.ProvidedAlpha = lambda: None
    with tempfile.TemporaryDirectory() as temp:
        Path(temp, 'pipeline.json').write_text(json.dumps(config)); pipeline = Trellis2ImageTo3DPipeline.from_pretrained(temp)
    pipeline.cuda()
    pre = {v: pipeline.preprocess_image(Image.open(io.BytesIO(b))) for v, b in views.items()}
    report = {'name': name, 'model': repo, 'pipeline': pipeline_type, 'seed': seed, 'views': list(pre),
              'temperature': temperature if len(pre) > 1 else None,
              'inputs_sha256': {v: hashlib.sha256(b).hexdigest() for v, b in views.items()}, 'gpu': torch.cuda.get_device_name()}
    if len(pre) > 1:
        conds = {r: {v: pipeline.get_cond([im], r) for v, im in pre.items()} for r in (512, 1024)}
        front = {r: conds[r]['front'] for r in conds}
        by_id = {id(front[r]['cond']): {v: conds[r][v]['cond'] for v in pre} for r in conds}
        axis_log = []

        def weights(x, names):
            if hasattr(x, 'coords'):
                c = x.coords[:, 1:4].float(); lo, hi = c.min(0).values, c.max(0).values
                n = (c - (lo + hi) / 2) / ((hi - lo) / 2).clamp(min=1)
                if len(axis_log) < 3: axis_log.append([int(v) for v in (hi - lo)])
                s = torch.stack([n[:, 0] * DIRECTIONS[v][0] + n[:, 1] * DIRECTIONS[v][1] for v in names], 1)
                return torch.softmax(s * temperature, 1)                      # (N, views)
            X, Y = x.shape[2], x.shape[3]
            gx = torch.linspace(-1, 1, X, device=x.device)[:, None, None]; gy = torch.linspace(-1, 1, Y, device=x.device)[None, :, None]
            s = torch.stack([(gx * DIRECTIONS[v][0] + gy * DIRECTIONS[v][1]).expand(X, Y, x.shape[4]) for v in names], 0)
            return torch.softmax(s * temperature, 0)                          # (views, x, y, z)

        class MultiView(torch.nn.Module):
            def __init__(self, inner): super().__init__(); self.inner = inner
            def __getattr__(self, name):
                try: return super().__getattr__(name)
                except AttributeError: return getattr(self._modules['inner'], name)
            def forward(self, x, t, cond, **kw):
                per_view = by_id.get(id(cond))
                if per_view is None: return self.inner(x, t, cond, **kw)          # negative conditioning
                names = list(per_view); w = weights(x, names); acc = None
                for i, v in enumerate(names):
                    p = self.inner(x, t, per_view[v], **kw); f = p.feats if hasattr(p, 'feats') else p
                    wi = w[:, i:i + 1] if hasattr(x, 'coords') else w[i][None, None]
                    acc = f * wi if acc is None else acc + f * wi
                return p.replace(acc) if hasattr(p, 'feats') else acc

        for k in [k for k in pipeline.models.keys() if 'flow_model' in k]: pipeline.models[k] = MultiView(pipeline.models[k])
        pipeline.get_cond = lambda image, resolution, include_neg_cond=True: front[resolution]
    t = time.monotonic()
    outputs, latent = pipeline.run(pre['front'], seed=seed, pipeline_type=pipeline_type, return_latent=True,
                                   max_num_tokens=65536, preprocess_image=False)
    report.update(actual_resolution=int(latent[2]), inference_seconds=round(time.monotonic() - t, 1))
    if len(pre) > 1: report['sparse_extent_xyz'] = axis_log
    mesh = outputs[0]; del outputs, latent
    for v, im in pre.items(): im.save(out / f'input-{v}.png')
    t = time.monotonic()
    glb = o_voxel.postprocess.to_glb(vertices=mesh.vertices, faces=mesh.faces, attr_volume=mesh.attrs, coords=mesh.coords,
                                     attr_layout=mesh.layout, voxel_size=float(mesh.voxel_size), aabb=[[-.5, -.5, -.5], [.5, .5, .5]],
                                     decimation_target=faces, texture_size=texture, remesh=True, remesh_band=1, remesh_project=0, verbose=False)
    glb.export(str(out / f'{name}.glb'))
    report.update(export_seconds=round(time.monotonic() - t, 1), source_triangles=int(mesh.faces.shape[0]),
                  decimation_target=faces, texture_size=texture,
                  invocation_seconds=round(time.monotonic() - started, 1), status='completed')
    (out / 'generation.json').write_text(json.dumps(report, indent=2) + '\n'); cache.commit()
    return json.dumps(report)


@app.local_entrypoint()
def main(name: str, views: str = '', seeds: str = '7', output: str = '.tmp/trellis', temperature: float = 2.0,
         faces: int = 400000, texture: int = 4096, download_only: bool = False):
    paths = dict(kv.split('=', 1) for kv in views.split(',') if kv)
    payload = {v: Path(p).read_bytes() for v, p in paths.items()}
    if not download_only:
        assert 'front' in payload, 'need at least front=PATH'
        calls = [generate.spawn(name, payload, int(s), temperature, faces=faces, texture=texture) for s in seeds.split(',')]
        for c in calls: print('Completed:', c.get(), flush=True)
    for s in seeds.split(','):
        d = Path(output, f'{name}-seed-{s}'); d.mkdir(parents=True, exist_ok=True)
        for e in cache.listdir(f'{ROOT}/{name}-seed-{s}'):
            (d / Path(e.path).name).write_bytes(b''.join(cache.read_file(e.path)))
        print('downloaded', d, sorted(p.name for p in d.iterdir()), flush=True)

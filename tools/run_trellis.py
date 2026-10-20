"""Launch tools/trellis_modal.py with the system CA trust and the environment's Modal credentials.

Maps `modal`/`modal_secret` (or `modal_token_id`/`modal_token_secret`) to MODAL_TOKEN_ID/SECRET.
Never put the keys in code, the front end, Git or docs.
"""
import os, runpy, sys
import truststore
truststore.inject_into_ssl()
os.environ.setdefault('MODAL_SERVER_URL', 'https://api.modal.com')
for upper, lower in [('MODAL_TOKEN_ID', 'modal_token_id'), ('MODAL_TOKEN_SECRET', 'modal_token_secret'),
                     ('MODAL_TOKEN_ID', 'modal'), ('MODAL_TOKEN_SECRET', 'modal_secret')]:
    if not os.environ.get(upper) and os.environ.get(lower):
        os.environ[upper] = os.environ[lower]
if '--download-only' in sys.argv:
    os.environ['TRELLIS_ENVIRONMENT_CHECK_ONLY'] = '1'
sys.argv = ['modal', 'run', 'tools/trellis_modal.py', *sys.argv[1:]]
runpy.run_module('modal', run_name='__main__')

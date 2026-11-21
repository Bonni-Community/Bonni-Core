"""Executed inside the fixed Synapse service by the independent manager."""
import json
import os
import secrets
from pathlib import Path
import yaml
from bonni_policy import BonniPolicy

def configure(root=Path('/data'), settings_path=Path('/run/bonni-settings.json'),
              password_path=Path('/run/secrets/postgres_password')):
    settings = json.loads(settings_path.read_text())
    config_path = root / 'homeserver.yaml'
    source = yaml.safe_load(config_path.read_text())
    if source.get('server_name') != settings['serverName']:
        raise RuntimeError('SERVER_NAME_IMMUTABLE')
    parsed = BonniPolicy.parse_config({'server_name': settings['serverName'], 'allowed_servers': settings['allowedServers']})
    modules = [item for item in source.get('modules') or [] if item.get('module') != 'bonni_policy.BonniPolicy']
    modules.append({'module': 'bonni_policy.BonniPolicy', 'config': parsed})
    source.update({
        'modules': modules,
        'public_baseurl': settings['publicBaseUrl'].rstrip('/') + '/',
        'database': {'name': 'psycopg2', 'args': {'user': 'matrix', 'password': password_path.read_text().strip(),
                     'database': 'matrix', 'host': 'db', 'port': 5432, 'cp_min': 1, 'cp_max': 5}},
        'listeners': [{'port': 8008, 'tls': False, 'type': 'http', 'x_forwarded': True,
                       'bind_addresses': ['0.0.0.0'], 'resources': [{'names': ['client', 'federation'], 'compress': False}]}],
        'federation_domain_whitelist': parsed['allowed_servers'],
        'federation_whitelist_endpoint_enabled': True,
        'allow_profile_lookup_over_federation': False,
        'require_auth_for_profile_requests': True,
        'allow_public_rooms_without_auth': False,
        'allow_public_rooms_over_federation': False,
        'enable_registration': False,
        'registration_shared_secret': source.get('registration_shared_secret') or secrets.token_hex(32),
        'allow_guest_access': False,
        'max_upload_size': str(settings['maxUploadMiB']) + 'M',
        'user_directory': {'enabled': True, 'search_all_users': True, 'prefer_local_users': True},
    })
    temporary = root / 'homeserver.bonni.tmp'
    temporary.write_text(yaml.safe_dump(source, sort_keys=False))
    temporary.chmod(0o600)
    if hasattr(os, 'chown'):
        os.chown(temporary, int(os.environ.get('UID', '991')), int(os.environ.get('GID', '991')))
    temporary.replace(config_path)


if __name__ == '__main__':
    configure()

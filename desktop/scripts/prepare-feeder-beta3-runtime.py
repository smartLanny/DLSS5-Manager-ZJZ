#!/usr/bin/env python3
"""Stage source-pinned Feeder assets without executing any downloaded package.

The dgVoodoo archives are deliberately not accepted as inputs or opened here.
"""
import argparse
import hashlib
import json
import shutil
import zipfile
from pathlib import Path

def sha(data):
    return hashlib.sha256(data).hexdigest()

def prepare(repo, build, output):
    if output.exists():
        raise ValueError('Use a new resource directory')
    validation = json.loads((build / 'validation.json').read_text(encoding='utf-8-sig'))
    if not validation.get('compileLinkVerified') or validation['source']['upstreamCommit'] != '3f624855276c4bde55145c712782477639b30e85':
        raise ValueError('Expected complete source-pinned provider build')
    old = repo / 'resources/feeder-runtime'
    old_recipe = json.loads((old / 'recipe.json').read_text(encoding='utf8'))
    bundle_root = repo / 'payload/nr-before-sr'
    bundle = json.loads((bundle_root / 'bundle.json').read_text(encoding='utf8'))
    if bundle['defaultVersion'] != old_recipe['coreVersion']:
        raise ValueError('Provider ABI Core must match the selected bundle baseline')
    rows = []
    output.mkdir(parents=True)
    def asset(id, data, source, role, architecture=None, mutable=False, target=None, provenance=None):
        target_file = output / source
        target_file.parent.mkdir(parents=True, exist_ok=True)
        target_file.write_bytes(data)
        rows.append(dict(id=id, source=source, role=role, architecture=architecture, mutable=mutable,
                         sha256=sha(data), bytes=len(data), **({'target':target} if target else {}),
                         **({'provenance':provenance} if provenance else {})))
    with zipfile.ZipFile(repo / 'build/feeder-beta3-downloads/ReShade_Setup_6.8.0_Addon.exe') as loader:
        for bits, arch in [(32,'x86'),(64,'x64')]:
            data = loader.read(f'ReShade{bits}.dll')
            if bits == 64 and sha(data) != bundle['fixed']['RTX50']['files']['ReShade64.dll']:
                raise ValueError('Downloaded ReShade64 differs from reviewed fixed loader')
            asset(f'loader-{arch}', data, f'loaders/ReShade{bits}.dll', 'loader', arch,
                  provenance={'url':'https://reshade.me/downloads/ReShade_Setup_6.8.0_Addon.exe','version':'6.8.0'})
    for filename, id, arch, role in [('dlss5-feed.addon64','provider-x64','x64','provider'),
            ('dlss5-feed.addon32','provider-x86','x86','provider'),
            ('dlss5-feed-relay.addon64','provider-relay-x64','x64','provider'),
            ('dlss5-feed-host64.exe','host-x64','x64','host')]:
        data = (build / filename).read_bytes()
        expected = next(row for row in validation['files'] if row['name'] == filename)
        if sha(data) != expected['sha256']:
            raise ValueError('Provider binary changed after build')
        asset(id, data, 'providers/' + filename, role, arch,
              provenance={'upstreamCommit':validation['source']['upstreamCommit'], 'ipcVersion':9,
                          'ipcExtension':'project-frame-completion-v1', 'source':validation['source']['files']})
    core_name = None
    for row in old_recipe['files']:
        role = row['role']
        if role in ('provider','loader','nr-runtime','feeder-config','reshade-config'):
            continue
        data = (old / row['source']).read_bytes()
        if sha(data) != row['sha256']:
            raise ValueError('Existing read-only provider pool source changed')
        rel = row['target'].removeprefix('_DLSS5_Feeder/')
        if role == 'core':
            core_name = Path(rel).name
            asset('core',data,'core/' + core_name,'core','x64',provenance=row['provenance'])
        elif role in ('chain','core-config'):
            asset(role,data,'core/' + Path(rel).name,role,'x64' if role == 'chain' else None,row['mutable'])
        elif role == 'preset':
            asset('preset',data,'config/ReShadePreset.ini',role,None,True)
        else:
            asset('shared-' + str(len(rows)),data,'shared/' + rel, 'texture' if '/Textures/' in rel else role,
                  None,row['mutable'],rel,row['provenance'])
    for family in ('RTX40','RTX50'):
        data = (bundle_root / 'fixed' / family / 'nvngx_dlssnr.dll').read_bytes()
        if sha(data) != bundle['fixed'][family]['files']['nvngx_dlssnr.dll']:
            raise ValueError('GPU-specific NR runtime differs from bundle identity')
        asset('runtime-' + family.lower(),data,f'runtimes/{family}/nvngx_dlssnr.dll','nr-runtime','x64',
              provenance={'hardwareFamily':family,'source':'bundle.fixed.' + family})
    attribution = ('VORT motion estimation includes files with two different licenses.\n'
        'The root project is MIT (see VORT-root-MIT.txt).\n'
        'Includes/vort_MotionVectors.fxh is CC BY-NC 4.0, not MIT.\n'
        'Original authors: Jakob Wapenhensch (Jak0bW), Pascal Gilcher / Marty McFly.\n'
        'Modifications by: Vortigern.\n'
        'License: https://creativecommons.org/licenses/by-nc/4.0/\n'
        'Source: https://github.com/vortigern11/vort_Shaders/tree/b410b9f0c0fbb83c8cb42164aaf1655fab386f4a\n'
        'Original attribution and license headers are retained in every shader.\n'
        'This package is provided for noncommercial use.\n').encode()
    asset('license-vort-details',attribution,'shared/licenses/VORT-license-details.txt','license',target='licenses/VORT-license-details.txt')
    manifest = dict(schema=1, upstream={'repository':'jlrouzies-fr/DLSS5-Feeder','version':'0.15.1',
        'commit':validation['source']['upstreamCommit'],'ipcVersion':9}, coreVersion=bundle['defaultVersion'],
        coreFileName=core_name, coreInterface='NRExternalProviderV1',
        coreVariant={'requiredInterface':'NRExternalProviderV1','baselineVersion':bundle['defaultVersion'],
                     'sourceCommit':old_recipe['sourceRevision'],'genericCoreInterchangeable':False},
        colorContract='actual-sRGB packed RGBA8/BGRA8 -> linear FP16 -> project Core -> original layout; alpha preserved',
        provenance='Synthetic', srInjected=False, fgInjected=False,
        blockedComponents=[{'id':'dgvoodoo2','deliveryBlocked':True,
                            'reason':'Defender severe detection persists; upstream excludes general launcher/framework bundling'}],
        acceptance={}, assets=rows)
    (output / 'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    fingerprint = sha(json.dumps(manifest,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode())
    print(json.dumps({'output':str(output),'manifestFingerprint':fingerprint,'assets':len(rows)}))
    return fingerprint

if __name__ == '__main__':
    p=argparse.ArgumentParser(); p.add_argument('--repo',type=Path,required=True);p.add_argument('--build',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    a=p.parse_args();prepare(a.repo.resolve(),a.build.resolve(),a.output.resolve())

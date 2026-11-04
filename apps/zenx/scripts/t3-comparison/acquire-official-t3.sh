#!/usr/bin/env bash
set -euo pipefail
destination=${1:?Pass an owned download directory}
mkdir -p "$destination"
archive="$destination/T3-Code-0.1.7-nightly.20261103.4119-arm64.zip"
url='https://github.com/pingdotgg/t3code/releases/download/v0.1.7-nightly.20261103.4119/T3-Code-0.1.7-nightly.20261103.4119-arm64.zip'
if [[ ! -f "$archive" ]]; then
  curl --fail --location --connect-timeout 30 --max-time 600 --output "$archive" "$url"
fi
python3 - "$archive" <<'PY'
import hashlib,json,pathlib,struct,sys,zipfile
p=pathlib.Path(sys.argv[1]); digest=hashlib.sha256(p.read_bytes()).hexdigest()
assert p.stat().st_size==186437562,(p.stat().st_size,'unexpected size')
assert digest=='3a65c0355a08a8d32e0df04d7719f545551d76be5e7b4662b7f26335f06f0c95',digest
with zipfile.ZipFile(p) as z:
 a=z.read('T3 Code (Nightly).app/Contents/Resources/app.asar')
 h=json.loads(a[16:16+struct.unpack_from('<I',a,12)[0]])
 v=h['files']['package.json']; offset=8+struct.unpack_from('<I',a,4)[0]+int(v['offset'])
 package=json.loads(a[offset:offset+v['size']])
 assert package['version']=='0.1.7-nightly.20261103.4119'
 assert package['t3codeCommitHash']=='cefb544af3c9'
 assert package['main']=='apps/desktop/dist-electron/boot.cjs'
 print(json.dumps({'assetBytes':p.stat().st_size,'sha256':digest,'version':package['version'],'embeddedCommit':package['t3codeCommitHash'],'main':package['main']}))
PY
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo 'Verified download only. This ARM64 macOS App cannot run on this host.'
  exit 0
fi
if [[ ! -d "$destination/T3 Code (Nightly).app" ]]; then
  ditto -x -k "$archive" "$destination"
fi
codesign --verify --deep --strict "$destination/T3 Code (Nightly).app"
echo "$destination/T3 Code (Nightly).app/Contents/MacOS/T3 Code (Nightly)"

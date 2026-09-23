#!/usr/bin/env bash
set -euo pipefail

# 妙笔插件一键发版：版本号 → 构建 → 打包 → 校验 → 同步发布仓库
# 用法: npm run release -- [版本号] [更新说明1] [更新说明2...]
#   版本号缺省 = patch +1；更新说明缺省 = changelog 不动（会警告提醒手改）
# 先试跑: npm run release -- --dry-run [版本号...]

EXT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$EXT_DIR/../.." && pwd)"
PUBLISHER_REPO="${PUBLISHER_REPO:-/Users/smilerz/PycharmProjects/weixin-article-publisher}"

DRY_RUN=0
VERSION_ARG=""
NOTES=()
# 参数循环解析：--dry-run 任意位置生效；未知 -- 开头参数直接报错
# （历史事故：--dry-run 放在版本号后会被当成更新说明写进 changelog 并真发版）
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --*) echo "❌ 未知参数: $1（支持的开关仅 --dry-run）" >&2; exit 2 ;;
    *) if [ -z "$VERSION_ARG" ]; then VERSION_ARG="$1"; else NOTES+=("$1"); fi ;;
  esac
  shift
done
set -- "$VERSION_ARG"

CUR="$(grep -o '"version": "[^"]*"' "$EXT_DIR/manifest.json" | head -1 | cut -d'"' -f4)"
if [ $# -ge 1 ] && [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEW="$1"; shift
else
  NEW="$(python3 -c "a,b,c='$CUR'.split('.'); print(f'{a}.{b}.{int(c)+1}')")"
fi
echo "▶ 版本: $CUR → $NEW"

[ -d "$PUBLISHER_REPO/static" ] || { echo "❌ 发布仓库不存在: $PUBLISHER_REPO（可用 PUBLISHER_REPO 覆盖）"; exit 1; }

# 1) manifest 版本号（历史踩坑：漏改导致用户更新看不到变化）
sed -i '' "s/\"version\": \"$CUR\"/\"version\": \"$NEW\"/" "$EXT_DIR/manifest.json"

# 2) 构建
echo "▶ tsc + vite build…"
( cd "$EXT_DIR" && npx tsc && npx vite build >/dev/null 2>&1 ) || { echo "❌ 构建失败"; exit 1; }

# 2.5) 生成 loader 定向静默：扩展重载/更新后旧页面残留 loader 的
#      "Extension context invalidated" 是无害暂态——只静默这一种，其余照报
python3 - "$EXT_DIR" <<'PYEOF'
import pathlib, re, sys
root = pathlib.Path(sys.argv[1])
for pat in ("dist/*loader*.js", "dist/assets/*loader*.js"):
    for f in root.glob(pat):
        s = f.read_text(encoding="utf-8")
        s2 = s.replace(
            "})().catch(console.error);",
            '})().catch((e)=>{if(String(e&&e.message||e).includes("Extension context invalidated"))return;console.error(e);});')
        if s2 != s:
            f.write_text(s2, encoding="utf-8")
            print(f"  loader 静默: {f.name}")
PYEOF

# 3) 产物版本校验
DIST_VER="$(grep -o '"version": "[^"]*"' "$EXT_DIR/dist/manifest.json" | head -1 | cut -d'"' -f4)"
[ "$DIST_VER" = "$NEW" ] || { echo "❌ dist 版本 $DIST_VER ≠ $NEW"; exit 1; }

# 4) 打包（外层 miaobi-extension/ 目录）+ zip 内版本校验
STAGE="$(mktemp -d)"
cp -R "$EXT_DIR/dist" "$STAGE/miaobi-extension"
( cd "$STAGE" && zip -rq miaobi-extension.zip miaobi-extension )
ZIP_VER="$(unzip -p "$STAGE/miaobi-extension.zip" miaobi-extension/manifest.json | grep -o '"version": "[^"]*"' | cut -d'"' -f4)"
[ "$ZIP_VER" = "$NEW" ] || { echo "❌ zip 内版本 $ZIP_VER ≠ $NEW"; exit 1; }
SIZE_KB=$(( ($(stat -f%z "$STAGE/miaobi-extension.zip") + 1023) / 1024 ))
echo "▶ zip 就绪: ${SIZE_KB}KB · manifest=${ZIP_VER} ✓"

if [ $DRY_RUN -eq 1 ]; then
  sed -i '' "s/\"version\": \"$NEW\"/\"version\": \"$CUR\"/" "$EXT_DIR/manifest.json"
  echo "DRY RUN OK (manifest=$CUR; zip=$STAGE/miaobi-extension.zip)"
  exit 0
fi

# 5) 同步发布仓库：zip + extension-info.json + download.html
cp "$STAGE/miaobi-extension.zip" "$PUBLISHER_REPO/static/miaobi-extension.zip"
TODAY="$(date +%Y-%m-%d)"
python3 - "$PUBLISHER_REPO" "$NEW" "$TODAY" "$SIZE_KB" "${NOTES[@]}" <<'PY'
import json, re, sys
repo, ver, today, size = sys.argv[1:5]
notes = [n for n in sys.argv[5:] if n]
info = json.load(open(f"{repo}/static/extension-info.json", encoding="utf-8"))
info["version"], info["updated"], info["size"] = ver, today, f"{size}KB"
if notes:
    info["changelog"] = notes + info["changelog"][:5]
json.dump(info, open(f"{repo}/static/extension-info.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
src = open(f"{repo}/static/download.html", encoding="utf-8").read()
src = re.sub(r'(<span class="ver">)v[\d.]+(</span><span class="meta">)[^<]+',
             rf'\g<1>v{ver}\g<2>{today} 发布 · {size}KB · Chrome / Edge', src, count=1)
open(f"{repo}/static/download.html", "w", encoding="utf-8").write(src)
print("▶ extension-info.json / download.html 已同步")
PY
[ ${#NOTES[@]} -gt 0 ] || echo "⚠️ 未提供更新说明——记得手改 static/extension-info.json 的 changelog"
rm -rf "$STAGE"

cat <<EOF

OK: release v$NEW ready (manifest/extension-info/download.html aligned)
next:
  1. cd $PUBLISHER_REPO && git diff && commit + push (dev fast lane ~3min)
  2. cd $REPO_ROOT && git add -A && git commit -m "release: v$NEW" && git push origin miaobi-fork
EOF

#!/usr/bin/env bash
# Verlaut Android APK — Gradle-loser Build direkt mit den SDK-Werkzeugen.
#
#   ./build.sh [SERVER_URL] [OUT_APK]
#
# Baut eine signierte (Debug-Key) WebView-APK, die SERVER_URL lädt. Ohne
# Argument wird VERLAUT_SERVER_URL bzw. ein Platzhalter genutzt (die App fragt
# dann beim ersten Start nach der Adresse).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# JDK-bin (javac/jar/keytool) aus dem echten Pfad von `java` ableiten.
if ! command -v javac >/dev/null 2>&1; then
    JAVA_REAL="$(readlink -f "$(command -v java)")"
    export PATH="$(dirname "$JAVA_REAL"):$PATH"
fi
SDK="${ANDROID_SDK_ROOT:-$HOME/android-sdk}"
BT="$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)"
PLATFORM="$(ls -d "$SDK"/platforms/android-* | sort -V | tail -1)"
ANDROID_JAR="$PLATFORM/android.jar"

SERVER_URL="${1:-${VERLAUT_SERVER_URL:-@@SERVER_URL@@}}"
OUT_APK="${2:-$HERE/verlaut.apk}"
MIN_SDK=26
TARGET_SDK=35

echo "SDK=$SDK"
echo "build-tools=$BT"
echo "platform=$PLATFORM"
echo "SERVER_URL=$SERVER_URL"

WORK="$(mktemp -d /mnt/e/verlaut-apk.XXXXXX 2>/dev/null || mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/gen" "$WORK/classes" "$WORK/dex" "$WORK/src/com/verlaut/app"

# 1) Server-URL in eine Arbeitskopie der Activity einsetzen.
sed "s|@@SERVER_URL@@|$SERVER_URL|g" \
    "$HERE/java/com/verlaut/app/MainActivity.java" > "$WORK/src/com/verlaut/app/MainActivity.java"

# 2) Ressourcen kompilieren + linken (erzeugt R.java + unsignierte Basis-APK).
"$BT/aapt2" compile --dir "$HERE/res" -o "$WORK/res.zip"
"$BT/aapt2" link \
    -o "$WORK/base.apk" \
    -I "$ANDROID_JAR" \
    --manifest "$HERE/AndroidManifest.xml" \
    --java "$WORK/gen" \
    --min-sdk-version "$MIN_SDK" \
    --target-sdk-version "$TARGET_SDK" \
    "$WORK/res.zip"

# 3) Java kompilieren (Framework-only, gegen android.jar).
javac -source 11 -target 11 -nowarn \
    -classpath "$ANDROID_JAR" \
    -d "$WORK/classes" \
    "$WORK/gen/com/verlaut/app/R.java" \
    "$WORK/src/com/verlaut/app/MainActivity.java"

# 4) Nach DEX übersetzen.
CLASSES=$(find "$WORK/classes" -name '*.class')
"$BT/d8" --release --min-api "$MIN_SDK" --lib "$ANDROID_JAR" \
    --output "$WORK/dex" $CLASSES

# 5) classes.dex in die APK legen (jar aus dem JDK, kein zip nötig).
cp "$WORK/base.apk" "$WORK/unsigned.apk"
( cd "$WORK/dex" && jar uf "$WORK/unsigned.apk" classes.dex )

# 6) Ausrichten.
"$BT/zipalign" -f -p 4 "$WORK/unsigned.apk" "$WORK/aligned.apk"

# 7) Debug-Keystore (einmalig) + signieren.
KS="$HERE/debug.keystore"
if [ ! -f "$KS" ]; then
    keytool -genkeypair -keystore "$KS" -storepass verlaut -keypass verlaut \
        -alias verlaut -keyalg RSA -keysize 2048 -validity 10000 \
        -dname "CN=Verlaut,O=Verlaut,C=DE" >/dev/null 2>&1
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:verlaut --key-pass pass:verlaut \
    --min-sdk-version "$MIN_SDK" --out "$OUT_APK" "$WORK/aligned.apk"

"$BT/apksigner" verify --min-sdk-version "$MIN_SDK" "$OUT_APK" && echo "SIGN_OK"
echo "APK: $OUT_APK ($(du -h "$OUT_APK" | cut -f1))"

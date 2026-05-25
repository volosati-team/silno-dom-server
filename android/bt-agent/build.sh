#!/bin/bash
# build.sh — собирает bt-agent APK
# Требования: Java 8+ (java -version), ANDROID_HOME установлен
# Запуск: bash build.sh
# APK будет в: app/build/outputs/apk/debug/app-debug.apk

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ─── Check Java ──────────────────────────────────────────────────────────────
if ! command -v java &>/dev/null; then
    echo "ERROR: Java not found. Install with:"
    echo "  sudo apt install openjdk-11-jdk    # Ubuntu/Debian WSL"
    echo "  brew install openjdk@11             # macOS"
    exit 1
fi
echo "Java: $(java -version 2>&1 | head -1)"

# ─── Check ANDROID_HOME ──────────────────────────────────────────────────────
if [ -z "$ANDROID_HOME" ]; then
    # Common locations
    for candidate in \
        "$HOME/Android/Sdk" \
        "$HOME/android-sdk" \
        "/opt/android-sdk" \
        "/usr/local/android-sdk"; do
        if [ -d "$candidate" ]; then
            export ANDROID_HOME="$candidate"
            break
        fi
    done
fi

if [ -z "$ANDROID_HOME" ] || [ ! -d "$ANDROID_HOME" ]; then
    echo ""
    echo "ERROR: Android SDK not found."
    echo "Install Android command-line tools:"
    echo ""
    echo "  # Download from https://developer.android.com/studio#command-tools"
    echo "  mkdir -p ~/android-sdk/cmdline-tools"
    echo "  unzip commandlinetools-linux-*.zip -d ~/android-sdk/cmdline-tools"
    echo "  mv ~/android-sdk/cmdline-tools/cmdline-tools ~/android-sdk/cmdline-tools/latest"
    echo "  export ANDROID_HOME=~/android-sdk"
    echo "  \$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --install 'platform-tools' 'platforms;android-27' 'build-tools;27.0.3'"
    echo ""
    echo "Or if Android Studio is installed on Windows, set:"
    echo "  export ANDROID_HOME=/mnt/c/Users/<you>/AppData/Local/Android/Sdk"
    exit 1
fi
echo "ANDROID_HOME: $ANDROID_HOME"

# ─── Bootstrap Gradle wrapper if needed ──────────────────────────────────────
if [ ! -f "gradlew" ] || [ ! -f "gradle/wrapper/gradle-wrapper.jar" ]; then
    echo "Downloading Gradle wrapper..."
    if command -v gradle &>/dev/null; then
        gradle wrapper --gradle-version 6.7.1
    else
        # Download gradlew from official GitHub distribution
        GRADLE_VERSION="6.7.1"
        TMP_DIR=$(mktemp -d)
        echo "Downloading Gradle $GRADLE_VERSION..."
        curl -sL "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" -o "$TMP_DIR/gradle.zip"
        unzip -q "$TMP_DIR/gradle.zip" -d "$TMP_DIR"
        "$TMP_DIR/gradle-${GRADLE_VERSION}/bin/gradle" wrapper --gradle-version "$GRADLE_VERSION"
        rm -rf "$TMP_DIR"
    fi
    chmod +x gradlew
fi

# ─── Build ───────────────────────────────────────────────────────────────────
echo "Building..."
./gradlew assembleDebug

APK="app/build/outputs/apk/debug/app-debug.apk"
if [ -f "$APK" ]; then
    SIZE=$(du -h "$APK" | cut -f1)
    echo ""
    echo "✓ Build successful: $APK ($SIZE)"
    echo ""
    echo "Install on tablet via:"
    echo "  cp $APK ../../panel/static/bt-agent-debug.apk"
    echo "  # Then open http://silno.local/bt-agent-debug.apk in Bromite"
else
    echo "ERROR: APK not found after build"
    exit 1
fi

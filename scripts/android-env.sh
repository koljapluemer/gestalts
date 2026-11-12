# Sourced by the android-* tasks: the Android SDK and NDK the build uses. ANDROID_HOME defaults to where Android
# Studio installs the SDK; NDK_HOME to the NDK version pinned here, inside it (`sdkmanager --install "ndk;<version>"`).
NDK_VERSION=28.2.13676358
if [ -z "${ANDROID_HOME:-}" ]; then
  case "$(uname -s)" in
    Darwin) ANDROID_HOME="$HOME/Library/Android/sdk" ;;
    *)      ANDROID_HOME="$HOME/Android/Sdk" ;;
  esac
fi
NDK_HOME="${NDK_HOME:-$ANDROID_HOME/ndk/$NDK_VERSION}"
if [ ! -d "$NDK_HOME" ]; then
  echo "No Android NDK at $NDK_HOME. Install it with: sdkmanager --install \"ndk;$NDK_VERSION\" (or set NDK_HOME)" >&2
  exit 1
fi
export ANDROID_HOME NDK_HOME

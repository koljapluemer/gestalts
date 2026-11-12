//! What the app asks Android for directly, over JNI: a multicast lock while it looks for the desktop by mDNS (Wi-Fi
//! drivers drop multicast packets without one), and the phone's name to pair under.

use std::sync::Mutex;

use jni::objects::{GlobalRef, JObject, JValue};
use jni::{JNIEnv, JavaVM};

/// The lock, once created; acquired while held.
static LOCK: Mutex<Option<GlobalRef>> = Mutex::new(None);

fn with_env<T>(f: impl FnOnce(&mut JNIEnv, &JObject) -> jni::errors::Result<T>) -> Option<T> {
    let ctx = ndk_context::android_context();
    // SAFETY: the VM and the context are the ones Android started this app with, alive as long as the process
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }.ok()?;
    let mut env = vm.attach_current_thread().ok()?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };
    let out = f(&mut env, &context);
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
    out.ok()
}

/// Acquires (`hold`) or releases this app's `WifiManager.MulticastLock`.
pub fn multicast(hold: bool) {
    let done = with_env(|env, context| {
        let mut lock = LOCK.lock().unwrap_or_else(|p| p.into_inner());
        if lock.is_none() {
            if !hold {
                return Ok(());
            }
            let app = env.call_method(context, "getApplicationContext", "()Landroid/content/Context;", &[])?.l()?;
            let service = env.new_string("wifi")?;
            let wifi = env.call_method(&app, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", &[JValue::Object(&service)])?.l()?;
            if wifi.is_null() {
                return Ok(());
            }
            let tag = env.new_string("gestalts-mdns")?;
            let l = env
                .call_method(&wifi, "createMulticastLock", "(Ljava/lang/String;)Landroid/net/wifi/WifiManager$MulticastLock;", &[JValue::Object(&tag)])?
                .l()?;
            // acquire and release pair up, whatever happens in between
            env.call_method(&l, "setReferenceCounted", "(Z)V", &[JValue::Bool(0)])?;
            *lock = Some(env.new_global_ref(l)?);
        }
        let l = lock.as_ref().expect("created above");
        env.call_method(l.as_obj(), if hold { "acquire" } else { "release" }, "()V", &[])?;
        Ok(())
    });
    if done.is_none() {
        eprintln!("gestalter: the multicast lock failed; finding the computer by mDNS may not work");
    }
}

/// The phone's name as its maker sells it, e.g. "Google Pixel 8".
pub fn model() -> Option<String> {
    with_env(|env, _| {
        let field = |env: &mut JNIEnv, name: &str| -> jni::errors::Result<String> {
            let v = env.get_static_field("android/os/Build", name, "Ljava/lang/String;")?.l()?;
            Ok(env.get_string(&v.into())?.into())
        };
        let (maker, model) = (field(env, "MANUFACTURER")?, field(env, "MODEL")?);
        let maker = capitalize(&maker);
        Ok(if model.to_lowercase().starts_with(&maker.to_lowercase()) { model } else { format!("{maker} {model}") })
    })
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
}

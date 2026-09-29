use base64::Engine;
use xcap::Monitor;

/// macOS 屏幕录制权限检查：未授权时截图只能得到桌面壁纸（窗口内容被系统抹掉）。
/// 未授权则触发系统授权弹窗，并返回引导文案。
#[cfg(target_os = "macos")]
fn ensure_screen_permission() -> Result<(), String> {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }
    if unsafe { CGPreflightScreenCaptureAccess() } {
        return Ok(());
    }
    unsafe { CGRequestScreenCaptureAccess() };
    Err("需要屏幕录制权限：系统设置 → 隐私与安全性 → 屏幕录制，勾选本应用后重启桌宠再试".to_string())
}

#[cfg(not(target_os = "macos"))]
fn ensure_screen_permission() -> Result<(), String> {
    Ok(())
}

/// 缩放到长边 1568px 以内（控制视觉模型 token 消耗），编码为 base64 PNG。
fn to_b64_png(image: image::DynamicImage) -> Result<String, String> {
    const MAX_SIDE: f32 = 1568.0;
    let (w, h) = (image.width() as f32, image.height() as f32);
    let scale = (MAX_SIDE / w.max(h)).min(1.0);
    let final_image = if scale < 1.0 {
        image::DynamicImage::ImageRgba8(image::imageops::resize(
            &image.to_rgba8(),
            (w * scale) as u32,
            (h * scale) as u32,
            image::imageops::FilterType::Triangle,
        ))
    } else {
        image
    };

    let mut buf = std::io::Cursor::new(Vec::new());
    final_image
        .write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| format!("PNG 编码失败: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(buf.into_inner()))
}

/// 截取主显示器，缩放到长边 1568px 以内（控制视觉模型 token 消耗），返回 base64 PNG。
/// macOS 首次调用需要用户在 系统设置 → 隐私与安全性 → 屏幕录制 中授权。
#[tauri::command]
pub async fn capture_screen() -> Result<String, String> {
    ensure_screen_permission()?;
    tauri::async_runtime::spawn_blocking(|| -> Result<String, String> {
        let monitor = Monitor::all()
            .map_err(|e| format!("枚举显示器失败: {e}"))?
            .into_iter()
            .find(|m| m.is_primary().unwrap_or(false))
            .ok_or_else(|| "找不到主显示器".to_string())?;

        let image = monitor
            .capture_image()
            .map_err(|e| format!("截图失败（macOS 需要屏幕录制权限）: {e}"))?;

        to_b64_png(image::DynamicImage::ImageRgba8(image))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// macOS 交互框选截图（系统原生十字选框）；用户 Esc 取消时返回 None。
/// 框选期间桌宠窗口设为穿透，避免遮挡系统选框。
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn capture_region(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri::Manager;
    ensure_screen_permission()?;
    let window = app.get_webview_window("main");
    if let Some(w) = &window {
        let _ = w.set_ignore_cursor_events(true);
    }
    let result = tauri::async_runtime::spawn_blocking(|| -> Result<Option<String>, String> {
        let path =
            std::env::temp_dir().join(format!("sloth-pet-region-{}.png", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let status = std::process::Command::new("screencapture")
            .arg("-i")
            .arg(&path)
            .status()
            .map_err(|e| format!("启动系统截图失败: {e}"))?;
        if !status.success() || !path.exists() {
            return Ok(None); // 用户按 Esc 取消
        }
        let data = std::fs::read(&path).map_err(|e| format!("读取截图失败: {e}"))?;
        let _ = std::fs::remove_file(&path);
        let img =
            image::load_from_memory(&data).map_err(|e| format!("解码截图失败: {e}"))?;
        to_b64_png(img).map(Some)
    })
    .await
    .map_err(|e| e.to_string())??;
    if let Some(w) = &window {
        let _ = w.set_ignore_cursor_events(false);
    }
    Ok(result)
}

/// 非 macOS 平台暂无框选 UI，退回全屏截图。
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn capture_region() -> Result<Option<String>, String> {
    capture_screen().await.map(Some)
}


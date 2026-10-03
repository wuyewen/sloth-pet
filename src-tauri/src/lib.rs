use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::Manager;

mod reminder;
mod screenshot;

#[derive(Clone, Copy, Default)]
struct HitRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// 解析模型目录：dir 非空用自定义目录，否则用默认 app data 目录下的 models/
fn resolve_models_dir(
    app: &tauri::AppHandle,
    dir: Option<String>,
) -> Result<std::path::PathBuf, String> {
    match dir {
        Some(d) if !d.trim().is_empty() => Ok(std::path::PathBuf::from(d.trim())),
        _ => Ok(app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("models")),
    }
}

/// 自定义 VRM 模型：存在则返回其路径，否则前端用内置默认模型（旧版 custom.vrm 约定兼容）
#[tauri::command]
fn custom_model_path(app: tauri::AppHandle, dir: Option<String>) -> Option<String> {
    let path = resolve_models_dir(&app, dir).ok()?.join("custom.vrm");
    path.exists().then(|| path.to_string_lossy().into_owned())
}

/// 打开模型目录（不存在则创建），同时创建 motions/ 子目录：放 .vrma 动作文件
#[tauri::command]
fn open_model_dir(app: tauri::AppHandle, dir: Option<String>) -> Result<(), String> {
    let dir = resolve_models_dir(&app, dir)?;
    std::fs::create_dir_all(dir.join("motions")).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(target_os = "windows")]
    let cmd = "explorer";
    std::process::Command::new(cmd)
        .arg(&dir)
        .status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 列出模型目录下的全部 .vrm 文件名（不含 motions/ 子目录，按文件名排序）
#[tauri::command]
fn list_models(app: tauri::AppHandle, dir: Option<String>) -> Vec<String> {
    let dir = match resolve_models_dir(&app, dir) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let mut out: Vec<String> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let p = e.path();
                    if p.extension().is_some_and(|e| e.eq_ignore_ascii_case("vrm")) {
                        e.file_name().to_string_lossy().into_owned().into()
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

/// 资产文件名校验：只允许纯文件名，防路径穿越
fn valid_asset_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
}

/// 按文件名取模型绝对路径（存在才返回），供前端 convertFileSrc 加载
#[tauri::command]
fn model_file_path(app: tauri::AppHandle, name: String, dir: Option<String>) -> Option<String> {
    if !valid_asset_name(&name) {
        return None;
    }
    let path = resolve_models_dir(&app, dir).ok()?.join(&name);
    path.exists().then(|| path.to_string_lossy().into_owned())
}

/// 删除资产文件：kind="model" 删目录下模型，kind="motion" 删目录 motions/ 下动作
#[tauri::command]
fn delete_asset(
    app: tauri::AppHandle,
    name: String,
    kind: String,
    dir: Option<String>,
) -> Result<(), String> {
    if !valid_asset_name(&name) {
        return Err("非法文件名".into());
    }
    let base = resolve_models_dir(&app, dir)?;
    let dir = match kind.as_str() {
        "model" => base,
        "motion" => base.join("motions"),
        _ => return Err("未知资产类型".into()),
    };
    std::fs::remove_file(dir.join(&name)).map_err(|e| e.to_string())
}

/// 列出模型目录 motions/ 下的 VRMA 动作文件（绝对路径，按文件名排序）
#[tauri::command]
fn list_motions(app: tauri::AppHandle, dir: Option<String>) -> Vec<String> {
    let dir = match resolve_models_dir(&app, dir) {
        Ok(d) => d.join("motions"),
        Err(_) => return Vec::new(),
    };
    let mut out: Vec<String> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.extension()
                        .is_some_and(|e| e.eq_ignore_ascii_case("vrma"))
                })
                .map(|p| p.to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}


/// 前端上报角色本体的命中区域（物理像素，相对窗口左上角）
#[tauri::command]
fn set_hit_rect(state: tauri::State<'_, Arc<Mutex<HitRect>>>, x: f64, y: f64, w: f64, h: f64) {
    *state.lock().unwrap() = HitRect { x, y, w, h };
}

const KEYRING_SERVICE: &str = "com.slothpet.app";
const KEYRING_USER: &str = "api-key";

/// 从服务端事件帧提取事件名与错误详情（error_code + error_message，都空则 None）
fn ws_event(msg: &str) -> (String, Option<String>) {
    let v: serde_json::Value = match serde_json::from_str(msg) {
        Ok(v) => v,
        Err(_) => return (String::new(), None),
    };
    let event = v
        .pointer("/header/event")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let code = v
        .pointer("/header/error_code")
        .and_then(|x| x.as_str())
        .unwrap_or("");
    let message = v
        .pointer("/header/error_message")
        .and_then(|x| x.as_str())
        .unwrap_or("");
    let detail = match (code.is_empty(), message.is_empty()) {
        (true, true) => None,
        (false, true) => Some(code.to_string()),
        (true, false) => Some(message.to_string()),
        (false, false) => Some(format!("{code}：{message}")),
    };
    (event, detail)
}

/// task-failed 时尽量给出可读原因，服务端字段全空则附原始报文便于排查
fn ws_fail_err(err: Option<String>, raw: &str) -> String {
    let detail = err.unwrap_or_else(|| {
        raw.chars().take(300).collect::<String>()
    });
    format!("TTS 任务失败：{detail}")
}

/// 浏览器 Audio 元素只认容器格式。服务端可能忽略 format 参数直接吐裸 PCM，
/// 检测魔数：RIFF/ID3/MP3帧同步/OggS 原样返回，否则按 s16le 单声道 PCM 包 WAV 头
fn ensure_playable(audio: Vec<u8>, sample_rate: u32) -> Vec<u8> {
    if audio.len() >= 12
        && (&audio[..4] == b"RIFF"
            || &audio[..3] == b"ID3"
            || &audio[..4] == b"OggS"
            || (audio[0] == 0xFF && audio[1] & 0xE0 == 0xE0))
    {
        return audio;
    }
    let data_len = audio.len() as u32;
    let mut out = Vec::with_capacity(44 + audio.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // 单声道
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // 位深
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(&audio);
    out
}

/// WebSocket TTS 协议主体（run-task → continue-task → finish-task，收集二进制音频帧）
async fn ws_tts_inner(
    endpoint: String,
    api_key: String,
    model: String,
    text: String,
    voice: Option<String>,
) -> Result<Vec<u8>, String> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::http::header::HeaderValue;
    use tokio_tungstenite::tungstenite::Message;

    let mut req = endpoint
        .into_client_request()
        .map_err(|e| format!("WS 地址无效：{e}"))?;
    let auth = HeaderValue::from_str(&format!("bearer {api_key}"))
        .map_err(|e| format!("API Key 含非法字符：{e}"))?;
    req.headers_mut().insert("Authorization", auth);

    let (mut ws, _) = tokio_tungstenite::connect_async(req)
        .await
        .map_err(|e| format!("WS 连接失败：{e}"))?;

    let task_id = uuid::Uuid::new_v4().simple().to_string();
    let cmd = |action: &str, payload: serde_json::Value| {
        serde_json::json!({
            "header": { "action": action, "task_id": task_id, "streaming": "duplex" },
            "payload": payload,
        })
        .to_string()
    };

    let mut params =
        serde_json::json!({ "text_type": "PlainText", "format": "mp3", "sample_rate": 22050 });
    if let Some(v) = voice.filter(|v| !v.trim().is_empty()) {
        params["voice"] = serde_json::json!(v.trim());
    }
    let run = cmd(
        "run-task",
        serde_json::json!({
            "task_group": "audio", "task": "tts", "function": "SpeechSynthesizer",
            "model": model, "parameters": params, "input": {},
        }),
    );
    ws.send(Message::Text(run.into()))
        .await
        .map_err(|e| format!("WS 发送失败：{e}"))?;

    let mut started = false;
    while let Some(msg) = ws.next().await {
        let msg = msg.map_err(|e| format!("WS 接收失败：{e}"))?;
        if let Message::Text(t) = msg {
            let (event, err) = ws_event(&t);
            match event.as_str() {
                "task-started" => {
                    started = true;
                    break;
                }
                "task-failed" => return Err(ws_fail_err(err, &t)),
                _ => {}
            }
        }
    }
    if !started {
        return Err("WS 连接被关闭，未收到 task-started".into());
    }

    let cont = cmd("continue-task", serde_json::json!({ "input": { "text": text } }));
    ws.send(Message::Text(cont.into()))
        .await
        .map_err(|e| format!("WS 发送失败：{e}"))?;
    let fin = cmd("finish-task", serde_json::json!({ "input": {} }));
    ws.send(Message::Text(fin.into()))
        .await
        .map_err(|e| format!("WS 发送失败：{e}"))?;

    let mut audio = Vec::new();
    while let Some(msg) = ws.next().await {
        let msg = msg.map_err(|e| format!("WS 接收失败：{e}"))?;
        match msg {
            Message::Binary(b) => audio.extend_from_slice(&b),
            Message::Text(t) => {
                let (event, err) = ws_event(&t);
                match event.as_str() {
                    "task-finished" => break,
                    "task-failed" => return Err(ws_fail_err(err, &t)),
                    _ => {}
                }
            }
            _ => {}
        }
    }
    let _ = ws.close(None).await;
    if audio.is_empty() {
        return Err("TTS 未返回音频数据".into());
    }
    // 调试：打印原始音频头并落盘，用于确认服务端实际返回的格式
    let preview: Vec<String> = audio.iter().take(16).map(|b| format!("{b:02x}")).collect();
    eprintln!("[tts] 收到音频 {} 字节，前16字节: {}", audio.len(), preview.join(" "));
    let _ = std::fs::write(std::env::temp_dir().join("sloth_tts_last.bin"), &audio);
    Ok(ensure_playable(audio, 22050))
}

/// OpenAI 兼容 /chat/completions 的 SSE 流式代理。
/// 打包后 WebView 源是 tauri:// 自定义协议，带 Authorization 头的跨域 fetch 会被
/// WebKit 拦截（TypeError: Load failed），因此聊天请求走 Rust 侧 reqwest（无 CORS 限制），
/// SSE 按行经 Channel 推回前端（按行切分保证每行是完整 UTF-8，\n 是 ASCII 不会劈开多字节字符）
#[tauri::command]
async fn llm_chat_stream(
    endpoint: String,
    api_key: String,
    body: serde_json::Value,
    on_chunk: tauri::ipc::Channel<String>,
) -> Result<(), String> {
    use futures_util::StreamExt;

    let client = reqwest::Client::new();
    let mut req = client.post(&endpoint).json(&body);
    if !api_key.is_empty() {
        req = req.bearer_auth(api_key);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let msg: String = text.chars().take(200).collect();
        return Err(format!("API {status}：{msg}"));
    }
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("读取流失败：{e}"))?;
        buf.extend_from_slice(&chunk);
        while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            if on_chunk
                .send(String::from_utf8_lossy(&line).into_owned())
                .is_err()
            {
                return Ok(()); // 前端已断开（中止对话）
            }
        }
    }
    if !buf.is_empty() {
        let _ = on_chunk.send(String::from_utf8_lossy(&buf).into_owned());
    }
    Ok(())
}

/// 百炼/自建网关 WebSocket TTS（tts_v2 SpeechSynthesizer 协议，cosyvoice、qwen-audio-tts 等）。
/// 浏览器 WebSocket 握手不能带自定义 Authorization 头，只能放 Rust 侧。
/// endpoint 为完整 wss 地址（官方 wss://dashscope.aliyuncs.com/api-ws/v1/inference 或自建网关）。
#[tauri::command]
async fn dashscope_ws_tts(
    endpoint: String,
    api_key: String,
    model: String,
    text: String,
    voice: Option<String>,
) -> Result<Vec<u8>, String> {
    tokio::time::timeout(
        Duration::from_secs(60),
        ws_tts_inner(endpoint, api_key, model, text, voice),
    )
    .await
    .map_err(|_| "TTS 超时（60s）".to_string())?
}

/// 百炼原生 TTS（qwen3-tts 等，multimodal-generation 接口）。该接口没有 CORS 头，
/// WebView 直接 fetch 会被拦，所以走 Rust 侧：POST 合成 → 解析限时音频 URL → 下载音频字节。
/// endpoint 为完整端点地址（官方或自建网关）。
#[tauri::command]
async fn dashscope_tts(
    endpoint: String,
    api_key: String,
    model: String,
    text: String,
    voice: Option<String>,
) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::new();
    let mut input = serde_json::json!({ "text": text });
    if let Some(v) = voice.filter(|v| !v.trim().is_empty()) {
        input["voice"] = serde_json::json!(v.trim());
    }
    let body = serde_json::json!({ "model": model, "input": input });
    let resp = client
        .post(&endpoint)
        .bearer_auth(&api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("TTS 请求失败：{e}"))?;
    let status = resp.status();
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let msg: String = String::from_utf8_lossy(&bytes).chars().take(200).collect();
        return Err(format!("TTS {status}：{msg}"));
    }
    let json: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("TTS 响应解析失败：{e}"))?;
    let url = json
        .pointer("/output/audio/url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            let msg: String = String::from_utf8_lossy(&bytes).chars().take(200).collect();
            format!("TTS 响应缺少音频地址：{msg}")
        })?;
    let audio = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("音频下载失败：{e}"))?;
    let status = audio.status();
    let bytes = audio.bytes().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("音频下载失败 {status}"));
    }
    Ok(bytes.to_vec())
}

/// API Key 存操作系统钥匙串（macOS Keychain / Windows 凭据管理器），不落明文文件。
/// account 区分条目：api-key（对话主 Key，语音输入复用）、voice-api-key（语音播报）。
/// 钥匙串可能弹授权框阻塞，必须在 blocking 线程池执行避免卡死 UI。
#[tauri::command]
async fn save_api_key(key: String, account: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let account = account.unwrap_or_else(|| KEYRING_USER.to_string());
        let entry = keyring::Entry::new(KEYRING_SERVICE, &account).map_err(|e| e.to_string())?;
        if key.is_empty() {
            // 空 key 视为删除（Ollama 等本地服务无需 key）
            match entry.delete_credential() {
                Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(e.to_string()),
            }
        } else {
            entry.set_password(&key).map_err(|e| e.to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_api_key(account: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let account = account.unwrap_or_else(|| KEYRING_USER.to_string());
        let entry = keyring::Entry::new(KEYRING_SERVICE, &account).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(k) => Ok(k),
            Err(keyring::Error::NoEntry) => Ok(String::new()),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 读取全局光标位置（物理像素，左上角原点）。
/// macOS 用 NSEvent.mouseLocation（无需辅助功能权限），Windows 用 GetCursorPos。
#[cfg(target_os = "macos")]
fn cursor_position(scale: f64) -> Option<(i32, i32)> {
    use cocoa::appkit::NSScreen;
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSPoint;
    use objc::{class, msg_send, sel, sel_impl};

    unsafe {
        let loc: NSPoint = msg_send![class!(NSEvent), mouseLocation];
        let main_screen: id = NSScreen::mainScreen(nil);
        if main_screen == nil {
            return None;
        }
        let frame = NSScreen::frame(main_screen);
        // AppKit 坐标原点在左下角，翻转为左上角原点
        let y = frame.size.height - loc.y;
        Some(((loc.x * scale) as i32, (y * scale) as i32))
    }
}

#[cfg(target_os = "windows")]
fn cursor_position(_scale: f64) -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()? };
    Some((p.x, p.y))
}

/// 光标在命中区域内 → 窗口可交互；区域外 → 整窗点击穿透。
/// Tauri 的 set_ignore_cursor_events 是全窗口布尔值，无法区域穿透，
/// 因此用 16ms 轮询光标位置自行切换。
fn spawn_click_through_polling(app: &tauri::App) {
    let handle = app.handle().clone();
    let hit_rect = app.state::<Arc<Mutex<HitRect>>>().inner().clone();
    std::thread::spawn(move || {
        let mut ignoring = false;
        let mut last_emitted = (f64::MAX, f64::MAX);
        loop {
            std::thread::sleep(Duration::from_millis(16));
            let Some(window) = handle.get_webview_window("main") else {
                continue;
            };
            let Ok(pos) = window.outer_position() else {
                continue;
            };
            let Ok(scale) = window.scale_factor() else {
                continue;
            };
            let Some((cx, cy)) = cursor_position(scale) else {
                continue;
            };

            // 广播窗口内相对坐标（逻辑像素），供角色全局视线追踪
            let rel = ((cx - pos.x) as f64 / scale, (cy - pos.y) as f64 / scale);
            if (rel.0 - last_emitted.0).abs() > 2.0 || (rel.1 - last_emitted.1).abs() > 2.0 {
                use tauri::Emitter;
                let _ = window.emit("cursor-move", [rel.0, rel.1]);
                last_emitted = rel;
            }

            let rect = *hit_rect.lock().unwrap();
            let inside = rect.w > 0.0
                && cx >= pos.x + rect.x as i32
                && cx < pos.x + (rect.x + rect.w) as i32
                && cy >= pos.y + rect.y as i32
                && cy < pos.y + (rect.y + rect.h) as i32;
            let should_ignore = !inside;
            if should_ignore != ignoring {
                if window.set_ignore_cursor_events(should_ignore).is_ok() {
                    ignoring = should_ignore;
                }
            }
        }
    });
}

/// 系统托盘（macOS 菜单栏 / Windows 右下角）：设置、退出等常驻入口
fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::TrayIconBuilder;
    use tauri::Emitter;

    let chat = MenuItemBuilder::with_id("chat", "💬 聊天").build(app)?;
    let shot = MenuItemBuilder::with_id("shot", "📸 截屏分析").build(app)?;
    let settings = MenuItemBuilder::with_id("settings", "⚙️ 设置").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "❌ 退出").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&chat, &shot, &settings])
        .separator()
        .item(&quit)
        .build()?;

    let mut tray = TrayIconBuilder::new().menu(&menu).tooltip("Sloth Pet");
    // 显式内嵌图标：dev 模式下 default_window_icon 可能取不到，导致托盘空白
    let icon = app
        .default_window_icon()
        .cloned()
        .or_else(|| tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png")).ok());
    if let Some(icon) = icon {
        tray = tray.icon(icon);
    }
    tray.on_menu_event(|app, event| match event.id().as_ref() {
        "quit" => app.exit(0),
        "chat" => {
            let _ = app.emit("tray-toggle-chat", ());
        }
        "shot" => {
            let _ = app.emit("tray-screenshot", ());
        }
        "settings" => {
            let _ = app.emit("tray-open-settings", ());
        }
        _ => {}
    })
    .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 防多开：第二个实例启动时激活已有窗口并自行退出（需尽早注册）
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(Mutex::new(HitRect::default())))
        .invoke_handler(tauri::generate_handler![
            set_hit_rect,
            save_api_key,
            get_api_key,
            dashscope_tts,
            dashscope_ws_tts,
            llm_chat_stream,
            custom_model_path,
            open_model_dir,
            list_models,
            model_file_path,
            delete_asset,
            list_motions,
            screenshot::capture_screen,
            screenshot::capture_region,
            reminder::list_reminders,
            reminder::upsert_reminder,
            reminder::delete_reminder,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                // 注意：不要用 macos-private-api 强制透明（系统升级后私有 API 失效会导致窗口隐形），
                // 透明由 tauri.conf 的 transparent:true 标准实现承担
                // 桌宠不占 Dock 位，托盘是唯一常驻入口
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            setup_tray(app)?;
            reminder::init(app);
            spawn_click_through_polling(app);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

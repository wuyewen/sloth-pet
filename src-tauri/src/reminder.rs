use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use chrono::{Datelike, Local, Timelike};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Repeat {
    /// 一次性：unix 秒时间戳
    Once { at: i64 },
    /// 每天 time 时刻
    Daily,
    /// 每周 weekday（0=周日）time 时刻
    Weekly { weekday: u8 },
    /// 每天在 start..=end（HH:MM）窗口内，每隔 every_minutes 分钟触发
    Interval {
        start: String,
        end: String,
        every_minutes: u32,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Reminder {
    pub id: String,
    pub text: String,
    /// "HH:MM"，Once 时忽略
    pub time: String,
    pub repeat: Repeat,
    pub enabled: bool,
}

pub struct ReminderStore {
    items: Vec<Reminder>,
    path: PathBuf,
}

impl ReminderStore {
    fn load(path: PathBuf) -> Self {
        let items = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self { items, path }
    }

    fn save(&self) {
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(&self.items) {
            let _ = std::fs::write(&self.path, json);
        }
    }
}

fn parse_hhmm(s: &str) -> Option<(u32, u32)> {
    let mut it = s.split(':');
    let h = it.next()?.parse().ok()?;
    let m = it.next()?.parse().ok()?;
    Some((h, m))
}

/// 今天在 time（HH:MM）时刻的 unix 时间戳
fn today_at(time: &str, now: &chrono::DateTime<Local>) -> Option<i64> {
    let (h, m) = parse_hhmm(time)?;
    Some(
        now.with_hour(h)?
            .with_minute(m)?
            .with_second(0)?
            .with_nanosecond(0)?
            .timestamp(),
    )
}

/// 提醒是否到期：计划时刻落在 (prev, now] 检查窗口内。
/// 一次性提醒在应用重启后补触发（at <= now 即视为到期，触发后禁用）。
fn due(r: &Reminder, prev: i64, now: &chrono::DateTime<Local>) -> bool {
    if !r.enabled {
        return false;
    }
    let now_ts = now.timestamp();
    match &r.repeat {
        Repeat::Once { at } => *at <= now_ts,
        Repeat::Daily => match today_at(&r.time, now) {
            Some(t) => t > prev && t <= now_ts,
            None => false,
        },
        Repeat::Weekly { weekday } => {
            if *weekday as u32 != now.weekday().num_days_from_sunday() {
                return false;
            }
            match today_at(&r.time, now) {
                Some(t) => t > prev && t <= now_ts,
                None => false,
            }
        }
        Repeat::Interval {
            start,
            end,
            every_minutes,
        } => {
            let (Some(s), Some(e)) = (today_at(start, now), today_at(end, now)) else {
                return false;
            };
            if now_ts < s || now_ts > e {
                return false;
            }
            // 窗口内的等距时刻：start, start+k*step, …, 最后一个 <= end
            let step = (*every_minutes as i64).max(1) * 60;
            let candidate = s + (now_ts - s) / step * step;
            candidate > prev && candidate <= now_ts && candidate <= e
        }
    }
}

#[tauri::command]
pub fn list_reminders(state: State<'_, Mutex<ReminderStore>>) -> Vec<Reminder> {
    state.lock().unwrap().items.clone()
}

#[tauri::command]
pub fn upsert_reminder(state: State<'_, Mutex<ReminderStore>>, mut reminder: Reminder) {
    let mut store = state.lock().unwrap();
    if reminder.id.is_empty() {
        reminder.id = format!("r{}", Local::now().timestamp_nanos_opt().unwrap_or_default());
    }
    match store.items.iter_mut().find(|r| r.id == reminder.id) {
        Some(r) => *r = reminder,
        None => store.items.push(reminder),
    }
    store.save();
}

#[tauri::command]
pub fn delete_reminder(state: State<'_, Mutex<ReminderStore>>, id: String) {
    let mut store = state.lock().unwrap();
    store.items.retain(|r| r.id != id);
    store.save();
}

/// 每秒检查到期提醒，触发后向前端广播 reminder-fired 事件
fn spawn_scheduler(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        let mut prev = Local::now().timestamp() - 1;
        loop {
            interval.tick().await;
            let now = Local::now();
            let now_ts = now.timestamp();
            let fired: Vec<Reminder> = {
                let state = handle.state::<Mutex<ReminderStore>>();
                let mut store = state.lock().unwrap();
                let mut fired = Vec::new();
                let mut changed = false;
                for r in store.items.iter_mut() {
                    if due(r, prev, &now) {
                        fired.push(r.clone());
                        if matches!(r.repeat, Repeat::Once { .. }) {
                            r.enabled = false;
                            changed = true;
                        }
                    }
                }
                if changed {
                    store.save();
                }
                fired
            };
            prev = now_ts;
            for r in fired {
                let _ = handle.emit("reminder-fired", &r);
            }
        }
    });
}

pub fn init(app: &tauri::App) {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    app.manage(Mutex::new(ReminderStore::load(dir.join("reminders.json"))));
    spawn_scheduler(app.handle());
}

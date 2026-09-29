import { invoke } from "@tauri-apps/api/core";

export type Repeat =
  | { kind: "once"; at: number }
  | { kind: "daily" }
  | { kind: "weekly"; weekday: number }
  | { kind: "interval"; start: string; end: string; every_minutes: number };

export interface Reminder {
  id: string;
  text: string;
  time: string; // "HH:MM"，once 时忽略
  repeat: Repeat;
  enabled: boolean;
}

export const listReminders = () => invoke<Reminder[]>("list_reminders");

export const upsertReminder = (reminder: Reminder) =>
  invoke("upsert_reminder", { reminder });

export const deleteReminder = (id: string) => invoke("delete_reminder", { id });

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export function describeReminder(r: Reminder): string {
  switch (r.repeat.kind) {
    case "once":
      return `${new Date(r.repeat.at * 1000).toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })}（一次性）`;
    case "daily":
      return `每天 ${r.time}`;
    case "weekly":
      return `每周${WEEKDAYS[r.repeat.weekday] ?? "?"} ${r.time}`;
    case "interval": {
      const m = r.repeat.every_minutes;
      const every =
        m % 60 === 0 ? `每 ${m / 60} 小时` : `每 ${m} 分钟`;
      return `每天 ${r.repeat.start}–${r.repeat.end} ${every}`;
    }
  }
}

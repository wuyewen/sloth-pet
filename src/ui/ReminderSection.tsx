import { useEffect, useState } from "react";
import {
  deleteReminder,
  describeReminder,
  listReminders,
  Reminder,
  upsertReminder,
} from "../store/reminders";

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#999",
  marginBottom: 4,
  marginTop: 16,
};

const inputStyle: React.CSSProperties = {
  boxSizing: "border-box",
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
  color: "#eee",
  fontSize: 13,
  padding: "8px 10px",
  outline: "none",
};

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

/** 设置面板中的提醒管理区 */
export default function ReminderSection() {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<"once" | "daily" | "weekly" | "interval">("daily");
  const [time, setTime] = useState("09:00");
  const [onceAt, setOnceAt] = useState("");
  const [weekday, setWeekday] = useState(1);
  const [intervalStart, setIntervalStart] = useState("09:00");
  const [intervalEnd, setIntervalEnd] = useState("18:00");
  const [everyMinutes, setEveryMinutes] = useState(60);

  const reload = () => listReminders().then(setReminders).catch(() => {});
  useEffect(() => {
    reload();
  }, []);

  const add = async () => {
    const t = text.trim();
    if (!t) return;
    let repeat: Reminder["repeat"];
    if (kind === "once") {
      const ts = new Date(onceAt).getTime();
      if (!Number.isFinite(ts)) return;
      repeat = { kind: "once", at: Math.floor(ts / 1000) };
    } else if (kind === "weekly") {
      repeat = { kind: "weekly", weekday };
    } else if (kind === "interval") {
      repeat = {
        kind: "interval",
        start: intervalStart,
        end: intervalEnd,
        every_minutes: everyMinutes,
      };
    } else {
      repeat = { kind: "daily" };
    }
    await upsertReminder({ id: "", text: t, time, repeat, enabled: true });
    setText("");
    await reload();
  };

  const toggle = async (r: Reminder) => {
    await upsertReminder({ ...r, enabled: !r.enabled });
    await reload();
  };

  const remove = async (id: string) => {
    await deleteReminder(id);
    await reload();
  };

  return (
    <div>
      <div style={labelStyle}>提醒（到点时桌宠会弹出气泡提醒你）</div>

      {reminders.map((r) => (
        <div
          key={r.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 0",
            fontSize: 13,
            opacity: r.enabled ? 1 : 0.4,
          }}
        >
          <input
            type="checkbox"
            checked={r.enabled}
            onChange={() => toggle(r)}
          />
          <span style={{ flex: 1 }}>
            {r.text}
            <span style={{ color: "#888", marginLeft: 8, fontSize: 12 }}>
              {describeReminder(r)}
            </span>
          </span>
          <button
            onClick={() => remove(r.id)}
            style={{
              background: "transparent",
              border: "none",
              color: "#ff7b72",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            删除
          </button>
        </div>
      ))}

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
        <input
          style={inputStyle}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="提醒内容，如：站起来活动一下"
        />
        <div style={{ display: "flex", gap: 8 }}>
          <select
            style={{ ...inputStyle, width: 90 }}
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="once">一次性</option>
            <option value="daily">每天</option>
            <option value="weekly">每周</option>
            <option value="interval">时段间隔</option>
          </select>
          {kind === "once" && (
            <input
              style={{ ...inputStyle, flex: 1 }}
              type="datetime-local"
              value={onceAt}
              onChange={(e) => setOnceAt(e.target.value)}
            />
          )}
          {kind === "weekly" && (
            <select
              style={{ ...inputStyle, width: 80 }}
              value={weekday}
              onChange={(e) => setWeekday(Number(e.target.value))}
            >
              {WEEKDAYS.map((w, i) => (
                <option key={i} value={i}>
                  周{w}
                </option>
              ))}
            </select>
          )}
          {(kind === "daily" || kind === "weekly") && (
            <input
              style={{ ...inputStyle, width: 100 }}
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          )}
          {kind === "interval" && (
            <>
              <input
                style={{ ...inputStyle, width: 80 }}
                type="time"
                value={intervalStart}
                onChange={(e) => setIntervalStart(e.target.value)}
              />
              <span style={{ alignSelf: "center", color: "#888" }}>至</span>
              <input
                style={{ ...inputStyle, width: 80 }}
                type="time"
                value={intervalEnd}
                onChange={(e) => setIntervalEnd(e.target.value)}
              />
              <select
                style={{ ...inputStyle, width: 90 }}
                value={everyMinutes}
                onChange={(e) => setEveryMinutes(Number(e.target.value))}
              >
                <option value={15}>每15分钟</option>
                <option value={30}>每30分钟</option>
                <option value={45}>每45分钟</option>
                <option value={60}>每1小时</option>
                <option value={120}>每2小时</option>
                <option value={180}>每3小时</option>
              </select>
            </>
          )}
          <button
            onClick={add}
            style={{
              ...inputStyle,
              width: 60,
              background: "#4a6cf7",
              border: "none",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            添加
          </button>
        </div>
      </div>
    </div>
  );
}

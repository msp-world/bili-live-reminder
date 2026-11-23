/**
 * B 站主播开播提醒 MSP World（移植自 cortico-world-bili-live-reminder）：
 * - 免登录、无 Cookie 轮询公开接口 get_status_info_by_uids
 * - 工具：bili_live_status, bili_live_follow, bili_live_unfollow
 * - 信号：bili_reminder.live_on, bili_reminder.live_off
 */
import type { MSPNode } from "../shared/msp.ts";

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface FollowedStreamer {
  uid: number;
  uname?: string;
  roomId?: number;
  living: boolean;
  title?: string;
  areaName?: string;
  lastCheckedAt?: string;
}

export class BiliLiveReminderWorld {
  private readonly uids = new Map<number, FollowedStreamer>();
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: FetchImpl;
  private node: MSPNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: { uids?: number[]; pollIntervalMs?: number } = {}, fetchImpl?: FetchImpl) {
    for (const uid of config.uids ?? []) {
      if (Number.isInteger(uid) && uid > 0) this.uids.set(uid, { uid, living: false });
    }
    this.pollIntervalMs = config.pollIntervalMs ?? 60_000;
    this.fetchImpl = fetchImpl ?? ((u, i) => fetch(u, i));
  }

  attach(node: MSPNode): void {
    this.node = node;
    node.declareSignal("bili_reminder.live_on", "关注的 B 站主播开播了");
    node.declareSignal("bili_reminder.live_off", "关注的 B 站主播下播了");

    node.tool(
      "bili_live_status",
      "查询已关注 B 站主播当前是否开播、直播间标题与分区",
      async (args) => {
        if (args.refresh === true) await this.pollOnce();
        const filterUid = typeof args.uid === "number" ? args.uid : null;
        const list = [...this.uids.values()].filter((s) => filterUid === null || s.uid === filterUid);
        return { count: list.length, streamers: list };
      },
      { type: "object", properties: { refresh: { type: "boolean", default: false }, uid: { type: "integer" } } },
    );

    node.tool(
      "bili_live_follow",
      "按数字 UID 关注一位 B 站主播并立即检查一次开播状态",
      async (args) => {
        const uid = Number(args.uid);
        if (!Number.isInteger(uid) || uid <= 0) throw new Error("uid 必须是正整数");
        if (!this.uids.has(uid)) this.uids.set(uid, { uid, living: false });
        await this.pollOnce();
        return { followed: this.uids.get(uid) };
      },
      { type: "object", required: ["uid"], properties: { uid: { type: "integer", minimum: 1 } } },
    );

    node.tool(
      "bili_live_unfollow",
      "按 UID 取消关注",
      (args) => {
        const uid = Number(args.uid);
        const removed = this.uids.delete(uid);
        return { removed, remaining: this.uids.size };
      },
      { type: "object", required: ["uid"], properties: { uid: { type: "integer", minimum: 1 } } },
    );
  }

  start(): void {
    if (this.timer) return;
    void this.pollOnce();
    if (this.pollIntervalMs > 0) {
      this.timer = setInterval(() => void this.pollOnce(), this.pollIntervalMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async pollOnce(): Promise<void> {
    const list = [...this.uids.keys()];
    if (list.length === 0) return;
    try {
      const res = await this.fetchImpl(
        "https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uids: list }),
          signal: AbortSignal.timeout(8000),
        },
      );
      if (!res.ok) return;
      const json = (await res.json()) as { data?: Record<string, any> };
      const map = json?.data ?? {};
      const now = new Date().toISOString();
      for (const uid of list) {
        const info = map[String(uid)];
        if (!info) continue;
        const prev = this.uids.get(uid)!;
        const living = Number(info.live_status ?? 0) === 1;
        const next: FollowedStreamer = {
          uid,
          uname: String(info.uname ?? prev.uname ?? ""),
          roomId: Number(info.room_id ?? prev.roomId ?? 0) || undefined,
          living,
          title: String(info.title ?? ""),
          areaName: String(info.area_v2_name ?? ""),
          lastCheckedAt: now,
        };
        this.uids.set(uid, next);
        if (living && !prev.living) {
          this.node?.publish("bili_reminder.live_on", { ...next });
        } else if (!living && prev.living) {
          this.node?.publish("bili_reminder.live_off", { ...next });
        }
      }
    } catch {
      /* ignore transient network error */
    }
  }
}

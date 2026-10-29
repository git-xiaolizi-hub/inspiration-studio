/**
 * 提交 → 轮询 → 终态 的状态机（可配间隔/超时可注入时钟，便于测试不真等）。
 *
 * 为什么单独一层：轮询逻辑要能被 UI 复用于"刷新后继续看某个 task_id"，
 * 而且**取消是本地语义**（停止轮询 + 标 aborted），不能假装服务端任务已取消。
 */
import type { VideoTask } from './types';

export type RunnerPhase = 'queued' | 'running' | 'succeeded' | 'failed' | 'aborted';

export interface RunnerSnapshot {
  task: VideoTask;
  phase: RunnerPhase;
  /** 从开始轮询到现在的毫秒数（UI 显示 elapsed） */
  elapsedMs: number;
  /** 已经发出的轮询次数（测试断言"取消后不再有新请求"用） */
  polls: number;
}

export interface PollableAdapter {
  poll(taskId: string): Promise<VideoTask>;
  cancel(taskId: string): Promise<void>;
  isAborted?(taskId: string): boolean;
}

export interface RunnerOptions {
  /** 官方建议 30 秒；测试里设 0 */
  pollIntervalMs?: number;
  /** 最长轮询时长，默认 30 分钟 */
  pollTimeoutMs?: number;
  now?: () => number;
  /** 可注入的等待器（测试里同步/可控） */
  sleep?: (ms: number) => Promise<void>;
  onChange?: (snapshot: RunnerSnapshot) => void;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortedTask(taskId: string, last?: VideoTask): VideoTask {
  return {
    task_id: taskId,
    status: 'aborted',
    raw_status: last?.raw_status,
    error: {
      code: 'LocalCancel',
      message: '已本地取消：停止轮询，未向服务端发送取消请求（任务可能仍在运行并计费）',
    },
  };
}

export class VideoTaskRunner {
  private readonly adapter: PollableAdapter;

  private readonly intervalMs: number;

  private readonly timeoutMs: number;

  private readonly now: () => number;

  private readonly sleep: (ms: number) => Promise<void>;

  private readonly onChange?: (snapshot: RunnerSnapshot) => void;

  private readonly cancelled = new Set<string>();

  constructor(adapter: PollableAdapter, options: RunnerOptions = {}) {
    this.adapter = adapter;
    this.intervalMs = options.pollIntervalMs ?? DEFAULT_INTERVAL_MS;
    this.timeoutMs = options.pollTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.onChange = options.onChange;
  }

  isCancelled(taskId: string): boolean {
    return this.cancelled.has(taskId);
  }

  async cancel(taskId: string): Promise<void> {
    this.cancelled.add(taskId);
    await this.adapter.cancel(taskId);
  }

  /**
   * 轮询到终态。返回快照（含 aborted）。
   * 取消后**不会再发新的 poll**：每个等待点前后都检查取消标记。
   */
  async waitForTask(taskId: string): Promise<RunnerSnapshot> {
    const startedAt = this.now();
    let polls = 0;
    let last: VideoTask = { task_id: taskId, status: 'queued' };
    this.emit({ task: last, phase: 'queued', elapsedMs: 0, polls });

    for (;;) {
      if (this.isCancelled(taskId) || this.adapter.isAborted?.(taskId)) {
        return this.finish(abortedTask(taskId, last), 'aborted', startedAt, polls);
      }
      if (this.now() - startedAt > this.timeoutMs) {
        const timedOut: VideoTask = {
          task_id: taskId,
          status: 'failed',
          error: {
            code: 'PollTimeout',
            message: `本地放弃跟踪：轮询超过 ${Math.round(this.timeoutMs / 60000)} 分钟仍未成功（任务可能仍在服务端运行）`,
          },
          raw_status: last.raw_status,
        };
        return this.finish(timedOut, 'failed', startedAt, polls);
      }

      last = await this.adapter.poll(taskId);
      polls += 1;

      if (last.status === 'succeeded') {
        return this.finish(last, 'succeeded', startedAt, polls);
      }
      if (last.status === 'failed') {
        return this.finish(last, 'failed', startedAt, polls);
      }
      this.emit({
        task: last,
        phase: last.status === 'queued' ? 'queued' : 'running',
        elapsedMs: this.now() - startedAt,
        polls,
      });

      await this.sleep(this.intervalMs);

      if (this.isCancelled(taskId) || this.adapter.isAborted?.(taskId)) {
        return this.finish(abortedTask(taskId, last), 'aborted', startedAt, polls);
      }
    }
  }

  private finish(
    task: VideoTask,
    phase: RunnerPhase,
    startedAt: number,
    polls: number,
  ): RunnerSnapshot {
    const snapshot: RunnerSnapshot = { task, phase, elapsedMs: this.now() - startedAt, polls };
    this.emit(snapshot);
    return snapshot;
  }

  private emit(snapshot: RunnerSnapshot): void {
    this.onChange?.(snapshot);
  }
}

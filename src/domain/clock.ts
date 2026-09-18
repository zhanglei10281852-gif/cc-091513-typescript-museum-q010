// 时间源：生产环境取系统时钟，测试可注入固定时钟。

export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export function fixedClock(at: number): Clock {
  return { now: () => at };
}

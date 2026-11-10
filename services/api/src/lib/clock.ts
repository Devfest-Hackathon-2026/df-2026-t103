export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** テスト用の固定/手動進行クロック。 */
export class ManualClock implements Clock {
  private current: Date;
  constructor(initial: Date | string) {
    this.current = typeof initial === "string" ? new Date(initial) : initial;
  }
  now(): Date {
    return new Date(this.current.getTime());
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

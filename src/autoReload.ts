export class DebouncedTask {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private rerun = false;
  private disposed = false;

  constructor(
    private readonly task: () => Promise<void> | void,
    private readonly delayMs: number,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  schedule(delayMs = this.delayMs): void {
    if (this.disposed) {
      return;
    }
    if (this.running) {
      this.rerun = true;
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, delayMs);
  }

  dispose(): void {
    this.disposed = true;
    this.rerun = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private async run(): Promise<void> {
    if (this.disposed || this.running) {
      return;
    }
    this.running = true;
    try {
      await this.task();
    } catch (error) {
      this.onError(error);
    } finally {
      this.running = false;
      if (this.rerun && !this.disposed) {
        this.rerun = false;
        this.schedule(0);
      }
    }
  }
}

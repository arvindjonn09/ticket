import { AsyncLocalStorage } from "node:async_hooks";
import { transactionRemainingMs, type Tx } from "./database.js";

export class OutgoingMailError extends Error {
  constructor(
    public readonly kind:
      | "authentication"
      | "connection"
      | "tls"
      | "address"
      | "delivery"
      | "consent"
      | "oauth_unavailable",
  ) {
    super("Outgoing mail failed");
  }
}
const scope = new AsyncLocalStorage<MailDeadline>();
/** One network budget, including OAuth and DNS; leave time to commit failure evidence. */
export class MailDeadline {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly expires: number;
  private readonly timer: NodeJS.Timeout;
  constructor(tx?: Tx, maximumMs = 10000) {
    const duration = Math.max(
      0,
      Math.min(maximumMs, 10000, tx ? transactionRemainingMs(tx) - 2500 : Infinity),
    );
    this.expires = performance.now() + duration;
    this.timer = setTimeout(
      () => this.controller.abort(new OutgoingMailError("connection")),
      duration,
    );
    this.timer.unref();
  }
  check() {
    if (this.signal.aborted || performance.now() >= this.expires) {
      this.controller.abort(new OutgoingMailError("connection"));
      throw new OutgoingMailError("connection");
    }
  }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    let cancel: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      cancel = () => reject(new OutgoingMailError("connection"));
      this.signal.addEventListener("abort", cancel, { once: true });
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          this.check();
          return operation();
        }),
        aborted,
      ]);
      this.check();
      return result;
    } finally {
      this.signal.removeEventListener("abort", cancel);
    }
  }
  close() {
    clearTimeout(this.timer);
    this.controller.abort(new OutgoingMailError("connection"));
  }
}
export function currentMailDeadline() {
  return scope.getStore();
}
export async function withMailDeadline<T>(
  tx: Tx | undefined,
  work: (deadline: MailDeadline) => Promise<T>,
): Promise<T> {
  const inherited = scope.getStore();
  if (inherited) return work(inherited);
  const deadline = new MailDeadline(tx);
  return scope.run(deadline, async () => {
    try {
      return await work(deadline);
    } finally {
      deadline.close();
    }
  });
}

import type {
  Product,
  RankedProduct,
  VoteEvent,
  VoteSource,
} from "../../shared/types";

export type SchedulerSnapshot = {
  current: string;
  ranking: RankedProduct[];
};

export class DanmakuScheduler {
  private readonly products: Product[];
  private readonly productCodes: Set<string>;
  private readonly votes: VoteEvent[] = [];
  private readonly messageIds = new Set<string>();
  private readonly disabledCodes = new Set<string>();
  private current: string;

  constructor(products: Product[], current: string) {
    this.products = products.filter((product) => product.enabled);
    this.productCodes = new Set(this.products.map((product) => product.code));
    this.current = current;
  }

  ingestText(
    text: string,
    source: VoteSource,
    messageId: string,
    observedAt = Date.now(),
  ): VoteEvent[] {
    if (this.messageIds.has(messageId)) return [];
    this.messageIds.add(messageId);

    const codes = new Set(
      text
        .normalize("NFKC")
        .match(/(?<!\d)\d{1,4}(?!\d)/g)
        ?.filter((code) => this.isEnabled(code)) ?? [],
    );

    const events = [...codes].map((code) => ({
      id: `${messageId}:${code}`,
      code,
      source,
      observedAt,
    }));
    this.votes.push(...events);
    return events;
  }

  snapshot(): SchedulerSnapshot {
    return { current: this.current, ranking: this.buildRanking() };
  }

  lockNext(): string {
    const winner = this.selectNext();
    this.consume(winner);
    return winner;
  }

  setCurrent(code: string): void {
    if (!this.isEnabled(code)) throw new Error(`Unknown or disabled product: ${code}`);
    this.current = code;
  }

  disableProduct(code: string): void {
    if (!this.productCodes.has(code) || code === this.current) return;
    this.disabledCodes.add(code);
    this.consume(code);
  }

  selectNext(): string {
    const ranked = this.buildRanking().find(
      (entry) => entry.code !== this.current && this.isEnabled(entry.code),
    );
    if (ranked) return ranked.code;

    const currentIndex = this.products.findIndex(
      (product) => product.code === this.current,
    );
    for (let offset = 1; offset <= this.products.length; offset += 1) {
      const candidate = this.products[(currentIndex + offset) % this.products.length];
      if (
        candidate &&
        candidate.code !== this.current &&
        this.isEnabled(candidate.code)
      ) return candidate.code;
    }
    return this.current;
  }

  private consume(code: string): void {
    for (let index = this.votes.length - 1; index >= 0; index -= 1) {
      if (this.votes[index]?.code === code) this.votes.splice(index, 1);
    }
  }

  private isEnabled(code: string): boolean {
    return this.productCodes.has(code) && !this.disabledCodes.has(code);
  }

  private buildRanking(): RankedProduct[] {
    const aggregate = new Map<string, RankedProduct>();
    for (const vote of this.votes) {
      const entry = aggregate.get(vote.code);
      if (entry) {
        entry.count += 1;
        entry.lastSeenAt = Math.max(entry.lastSeenAt, vote.observedAt);
      } else {
        aggregate.set(vote.code, {
          code: vote.code,
          count: 1,
          lastSeenAt: vote.observedAt,
        });
      }
    }

    return [...aggregate.values()].sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      if (right.lastSeenAt !== left.lastSeenAt) {
        return right.lastSeenAt - left.lastSeenAt;
      }
      return (
        this.products.findIndex((product) => product.code === left.code) -
        this.products.findIndex((product) => product.code === right.code)
      );
    });
  }
}

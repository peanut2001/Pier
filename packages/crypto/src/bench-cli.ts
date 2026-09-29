/** `bun run --cwd packages/crypto bench`: secure-channel benchmark for the current runtime. */
import { formatBenchResults, runChannelBenchmark } from "./bench.ts";

const runtime =
	"Bun" in globalThis ? `Bun ${(globalThis as { Bun?: { version: string } }).Bun?.version}` : `Node ${process.version}`;
const results = await runChannelBenchmark({ budgetMs: 1000 });
process.stdout.write(`${runtime} (${process.platform}-${process.arch})\n${formatBenchResults(results)}\n`);

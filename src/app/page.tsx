import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-4xl font-bold text-neon-cyan">Chaos Arena</h1>
      <p className="text-muted-foreground max-w-md text-center">
        Three AI bots. Seven days. Pokemon Mega Evolution cards. Paper trading
        with sourced reasoning. Scaffold v0.1.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/pool"
          className="rounded-md border border-neon-cyan bg-neon-cyan/10 px-4 py-2 text-sm font-medium text-neon-cyan transition hover:bg-neon-cyan/20"
        >
          Browse card pool →
        </Link>
        <Link
          href="/leaderboard"
          className="rounded-md border border-neon-magenta bg-neon-magenta/10 px-4 py-2 text-sm font-medium text-neon-magenta transition hover:bg-neon-magenta/20"
        >
          View leaderboard →
        </Link>
        {process.env.NEXT_PUBLIC_ENABLE_SIMULATOR === "true" && (
          <Link
            href="/leaderboard?sim=new"
            className="rounded-md border border-amber-400/60 bg-amber-400/10 px-4 py-2 text-sm font-medium text-amber-300 transition hover:bg-amber-400/20"
          >
            Run simulation →
          </Link>
        )}
      </div>
      <p className="text-accent text-xs">M1 review view live.</p>
    </main>
  );
}

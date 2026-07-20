import SandTable from '@/components/SandTable';

export default function Home() {
  return (
    <main className="min-h-screen bg-neutral-950 px-4 py-8 md:px-8 md:py-12">
      <div className="mx-auto max-w-6xl">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
            Dune Weaver — sand simulator
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-neutral-400">
            Plays a <code className="font-mono text-neutral-300">.thr</code>{' '}
            pattern the way the table would and simulates the sand: the ball
            plows a groove, pushes material into ridges along the edges, and
            later passes cut through and erase what came before.
          </p>
        </header>
        <SandTable />
      </div>
    </main>
  );
}

import Link from 'next/link'

export default function Home() {
  return (
    <div className="max-w-2xl space-y-6 py-8">
      <h1 className="text-4xl font-bold tracking-tight">Your Pokémon games, in the browser, with cloud saves.</h1>
      <p className="text-lg text-muted">
        Load a backup of a Gen 3 game you own — Ruby, Sapphire, Emerald, FireRed or LeafGreen. It runs on your device;
        your save is kept in the cloud with full history. Trading with friends is next.
      </p>
      <div className="flex gap-3">
        <Link href="/register" className="rounded-md bg-accent px-4 py-2 font-medium text-white">
          Get started
        </Link>
        <Link href="/slots" className="rounded-md border border-line px-4 py-2">
          My games
        </Link>
      </div>
    </div>
  )
}

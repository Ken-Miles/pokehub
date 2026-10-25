import type { Metadata } from 'next'
import { Nav } from '@/components/Nav'
import { Providers } from '@/components/Providers'
import './globals.css'

export const metadata: Metadata = {
  title: 'Pokémon Hub',
  description: 'Play your own Pokémon games in the browser, keep cloud saves, and trade with friends.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Providers>
          <Nav />
          <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
          <footer className="mx-auto max-w-5xl px-4 pb-8 text-xs text-muted">
            We never host or distribute games — load a backup of a game you own. The emulators are{' '}
            <a className="underline" href="https://github.com/mgba-emu/mgba">
              mGBA
            </a>{' '}
            {' '}
            <a className="underline" href="https://github.com/mgba-emu/mgba/tree/0.10.5">
              0.10.5
            </a>{' '}
            (MPL-2.0) and{' '}
            <a className="underline" href="https://github.com/melonDS-emu/melonDS/tree/1.1">
              melonDS 1.1
            </a>{' '}
            (GPL-3.0,{' '}
            <a className="underline" href="/emulator/ds/hub.cpp">
              our glue
            </a>
            ), unmodified, built for the browser.
          </footer>
        </Providers>
      </body>
    </html>
  )
}

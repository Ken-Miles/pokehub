/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Served through the custom server (server/main.ts) so Socket.IO shares the
  // HTTP server — same pattern as Stork v2.
  typescript: { ignoreBuildErrors: false },
  // Node-only packages: load from node_modules at runtime instead of bundling.
  serverExternalPackages: ['pino', 'thread-stream', '@node-rs/argon2'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        ],
      },
    ]
  },
}

export default nextConfig

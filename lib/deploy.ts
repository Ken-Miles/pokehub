/**
 * Which blue/green colour this process is (deploy/README.md). Relay state is per
 * process, so each link session is claimed by the colour that first relays it;
 * a colour only ends its own sessions when it starts (lib/link-sessions.ts).
 */
export const DEPLOY_COLOR = process.env.DEPLOY_COLOR || 'dev'
export const DEPLOY_VERSION = process.env.DEPLOY_VERSION || 'dev'

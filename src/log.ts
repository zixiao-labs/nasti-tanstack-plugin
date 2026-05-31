import pc from 'picocolors'

const PREFIX = pc.cyan('[nasti:tanstack-router]')

export interface Logger {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
}

export function createLogger(level: 'info' | 'warn' | 'error' | 'silent' = 'info'): Logger {
  const rank = { silent: 0, error: 1, warn: 2, info: 3 } as const
  const threshold = rank[level]
  return {
    info(msg) {
      if (threshold >= rank.info) console.log(`${PREFIX} ${msg}`)
    },
    warn(msg) {
      if (threshold >= rank.warn) console.warn(`${PREFIX} ${pc.yellow(msg)}`)
    },
    error(msg) {
      if (threshold >= rank.error) console.error(`${PREFIX} ${pc.red(msg)}`)
    },
  }
}
